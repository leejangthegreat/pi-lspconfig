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
}

export function createDocumentSynchronizer(
	_options: CreateDocumentSynchronizerOptions,
): DocumentSynchronizer {
	throw new Error("Not implemented: createDocumentSynchronizer");
}

/**
 * Compute a minimal set of `TextDocumentContentChangeEvent`s.
 *
 * Used for incremental sync. Falls back to a single full-document change when
 * the diff would be larger than the document itself.
 */
export function buildContentChanges(
	_previousText: string,
	_nextText: string,
): TextDocumentContentChangeEvent[] {
	throw new Error("Not implemented: buildContentChanges");
}
