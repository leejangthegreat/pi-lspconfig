/**
 * Document synchronisation: `didOpen` / `didChange` / `didClose`.
 *
 * Two rules matter more than the mechanics:
 *
 *  1. **Always re-read from disk.** Pi's built-in `edit`/`write` tools change
 *     files behind our back, so a cached in-memory copy goes stale silently.
 *     The tool layer calls `markDirty()` from its `tool_result` hook, and the
 *     next operation re-syncs from disk before asking the server anything.
 *  2. **Never open huge files.** Servers routinely spend minutes on
 *     multi-megabyte generated files; `MAX_DOCUMENT_BYTES` cuts that off.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MAX_DOCUMENT_BYTES } from "../../util/defaults.ts";
import { offsetToPosition } from "../../util/text.ts";
import type { PositionEncoding } from "../../util/text.ts";
import type { LSPConnection } from "./connection.ts";
import type { TextDocumentContentChangeEvent } from "../../protocol.ts";
import type { TouchFileOptions } from "../../types.ts";

export interface DocumentSyncState {
	uri: string;
	path: string;
	languageId: string;
	version: number;
	/** Byte length of the last synced content, for the size guard. */
	byteLength: number;
	/** True when the on-disk content changed since the last sync. */
	dirty: boolean;
}

export interface DocumentSynchronizer {
	/** Sync a file to the server, opening it if needed. No-op when unchanged and not dirty. */
	touch(path: string, options?: TouchFileOptions): Promise<void>;
	/** Send `didClose` and drop local state. No-op when not open. */
	close(path: string): Promise<void>;
	/** Mark a path as changed by an external writer. */
	markDirty(path: string): void;
	isOpen(path: string): boolean;
	/** Snapshot of every open document. */
	openDocuments(): readonly DocumentSyncState[];
	/** Close every open document. Called on shutdown. */
	closeAll(): Promise<void>;
}

export interface CreateDocumentSynchronizerOptions {
	connection: LSPConnection;
	/** Negotiated `textDocumentSync.change`. */
	syncKind: 0 | 1 | 2;
	/** Map a path to the `languageId` to send in `didOpen`. */
	languageIdFor: (path: string) => string;
	/** Files larger than this are never opened. Defaults to `MAX_DOCUMENT_BYTES`. */
	maxDocumentBytes?: number;
	/**
	 * Negotiated position encoding, used for incremental change ranges.
	 * Defaults to `"utf-16"`, the only encoding every server must support.
	 */
	positionEncoding?: PositionEncoding;
}

/** Local bookkeeping for one open document. */
interface DocumentEntry {
	state: DocumentSyncState;
	/** The exact text last sent to the server, for incremental diffs. */
	text: string;
}

export function createDocumentSynchronizer(
	options: CreateDocumentSynchronizerOptions,
): DocumentSynchronizer {
	const { connection, syncKind, languageIdFor } = options;
	const maxDocumentBytes = options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
	const encoding = options.positionEncoding ?? "utf-16";
	const documents = new Map<string, DocumentEntry>();

	const close = async (path: string): Promise<void> => {
		const entry = documents.get(path);
		if (entry === undefined) return;
		documents.delete(path);
		connection.sendNotification("textDocument/didClose", {
			textDocument: { uri: entry.state.uri },
		});
	};

	const touch = async (path: string, touchOptions?: TouchFileOptions): Promise<void> => {
		const content = touchOptions?.content ?? (await readFile(path, "utf8"));
		const byteLength = Buffer.byteLength(content, "utf8");
		const existing = documents.get(path);

		// Huge files are never opened, and a previously-open one is dropped so the
		// server is not left holding a stale revision.
		if (byteLength > maxDocumentBytes) {
			if (existing !== undefined) await close(path);
			return;
		}

		if (existing === undefined) {
			const state: DocumentSyncState = {
				uri: pathToFileURL(path).href,
				path,
				languageId: languageIdFor(path),
				version: 1,
				byteLength,
				dirty: false,
			};
			documents.set(path, { state, text: content });
			connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri: state.uri,
					languageId: state.languageId,
					version: state.version,
					text: content,
				},
			});
			return;
		}

		const changed = existing.text !== content;
		if (!changed && !existing.state.dirty) return;

		if (syncKind === 0) {
			// The server does not accept change notifications; refresh only our
			// own bookkeeping so the next diff starts from the right base.
			existing.text = content;
			existing.state.byteLength = byteLength;
			existing.state.dirty = false;
			return;
		}

		const changes: TextDocumentContentChangeEvent[] =
			syncKind === 2
				? buildContentChanges(existing.text, content, encoding)
				: [{ text: content }];

		if (changed && changes.length > 0) {
			const version = existing.state.version + 1;
			existing.state.version = version;
			connection.sendNotification("textDocument/didChange", {
				textDocument: { uri: existing.state.uri, version },
				contentChanges: changes,
			});
		}

		existing.text = content;
		existing.state.byteLength = byteLength;
		existing.state.dirty = false;
	};

	return {
		touch,
		close,
		markDirty: (path) => {
			const entry = documents.get(path);
			if (entry !== undefined) entry.state.dirty = true;
		},
		isOpen: (path) => documents.has(path),
		openDocuments: () => [...documents.values()].map((entry) => ({ ...entry.state })),
		closeAll: async () => {
			for (const path of [...documents.keys()]) await close(path);
		},
	};
}

/**
 * Compute a minimal set of `TextDocumentContentChangeEvent`s.
 *
 * Used for incremental sync. Falls back to a single full-document change when
 * the diff would be larger than the document itself.
 *
 * `encoding` is the negotiated position encoding, so the emitted range is
 * correct for UTF-8 and UTF-32 servers as well as the UTF-16 default.
 */
export function buildContentChanges(
	previousText: string,
	nextText: string,
	encoding: PositionEncoding = "utf-16",
): TextDocumentContentChangeEvent[] {
	if (previousText === nextText) return [];

	const previousLength = previousText.length;
	const nextLength = nextText.length;

	let prefix = 0;
	const maxPrefix = Math.min(previousLength, nextLength);
	while (
		prefix < maxPrefix &&
		previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)
	) {
		prefix++;
	}
	// Never cut a surrogate pair in half: if the first difference is a low
	// surrogate, its high surrogate also belongs to the changed region.
	if (prefix > 0 && isLowSurrogate(previousText.charCodeAt(prefix))) prefix--;

	let suffix = 0;
	const maxSuffix = Math.min(previousLength - prefix, nextLength - prefix);
	while (
		suffix < maxSuffix &&
		previousText.charCodeAt(previousLength - 1 - suffix) ===
			nextText.charCodeAt(nextLength - 1 - suffix)
	) {
		suffix++;
	}
	if (suffix > 0 && isLowSurrogate(previousText.charCodeAt(previousLength - suffix))) suffix--;

	const removedLength = previousLength - prefix - suffix;
	const addedLength = nextLength - prefix - suffix;

	// When the changed span dominates the document a full replace is both
	// smaller and less likely to trip a server's incremental logic.
	if (removedLength + addedLength >= Math.max(previousLength, nextLength)) {
		return [{ text: nextText }];
	}

	return [
		{
			range: {
				start: offsetToPosition(previousText, prefix, encoding),
				end: offsetToPosition(previousText, prefix + removedLength, encoding),
			},
			text: nextText.slice(prefix, nextLength - suffix),
		},
	];
}

/** True for a UTF-16 low surrogate code unit. */
function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
