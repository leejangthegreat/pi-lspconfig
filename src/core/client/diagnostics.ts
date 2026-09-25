/**
 * Diagnostic collection.
 *
 * Diagnostics are push-first: the server sends `textDocument/publishDiagnostics`
 * whenever it likes. Servers that advertise `diagnosticProvider` are also
 * polled opportunistically, but push remains the primary path.
 *
 * The store exists because "ask for diagnostics right after an edit" is racy —
 * the server has not finished re-analysing yet. `waitFor()` waits for a quiet
 * window so the model gets results for the code it just wrote rather than for
 * the previous revision.
 */

import { fileURLToPath } from "node:url";
import {
	DEFAULT_DIAGNOSTICS_QUIET_MS,
	DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
} from "../../util/defaults.ts";
import type { Diagnostic, PublishDiagnosticsParams } from "../../protocol.ts";

export interface WaitForDiagnosticsOptions {
	/** Consider the result settled after this long with no new publish. */
	quietMs?: number;
	/** Give up after this long regardless. */
	timeoutMs?: number;
	/** Abort the wait. */
	signal?: AbortSignal;
}

export interface DiagnosticStore {
	/** Feed a `textDocument/publishDiagnostics` notification. */
	onPublish(params: PublishDiagnosticsParams): void;
	/** Last known diagnostics for a path, or `undefined` when never published. */
	get(path: string): readonly Diagnostic[] | undefined;
	/**
	 * Wait until diagnostics for `path` stop changing.
	 *
	 * Resolves as soon as a quiet window elapses after the most recent publish;
	 * resolves with whatever is cached on timeout.
	 */
	waitFor(path: string, options?: WaitForDiagnosticsOptions): Promise<readonly Diagnostic[]>;
	/** Drop cached diagnostics for one path (e.g. on `didClose`). */
	clear(path: string): void;
	clearAll(): void;
	/** Aggregate counts for `/lsp-status`. */
	counts(): { files: number; total: number };
}

/** Cached diagnostics for one file, plus when they last arrived. */
interface Entry {
	diagnostics: readonly Diagnostic[];
	at: number;
}

export function createDiagnosticStore(): DiagnosticStore {
	const entries = new Map<string, Entry>();

	const get = (path: string): readonly Diagnostic[] | undefined => entries.get(path)?.diagnostics;

	const waitFor = (
		path: string,
		options?: WaitForDiagnosticsOptions,
	): Promise<readonly Diagnostic[]> => {
		const quietMs = options?.quietMs ?? DEFAULT_DIAGNOSTICS_QUIET_MS;
		const timeoutMs = options?.timeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
		const signal = options?.signal;
		const start = Date.now();
		let lastPublish = start;

		return new Promise<readonly Diagnostic[]>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearInterval(timer);
				signal?.removeEventListener("abort", finish);
				resolve(get(path) ?? []);
			};

			signal?.addEventListener("abort", finish, { once: true });
			if (signal?.aborted) {
				finish();
				return;
			}

			const interval = Math.max(5, Math.min(quietMs, 25));
			timer = setInterval(() => {
				const entry = entries.get(path);
				if (entry !== undefined && entry.at > lastPublish) lastPublish = entry.at;
				const now = Date.now();
				if (now - lastPublish >= quietMs || now - start >= timeoutMs) finish();
			}, interval);
		});
	};

	return {
		onPublish: (params) => {
			const path = pathFromUri(params.uri);
			if (path === undefined) return;
			entries.set(path, { diagnostics: params.diagnostics, at: Date.now() });
		},
		get,
		waitFor,
		clear: (path) => {
			entries.delete(path);
		},
		clearAll: () => {
			entries.clear();
		},
		counts: () => {
			let total = 0;
			for (const entry of entries.values()) total += entry.diagnostics.length;
			return { files: entries.size, total };
		},
	};
}

/** Convert a `file:` URI to a path; `undefined` for anything else. */
function pathFromUri(uri: string): string | undefined {
	if (!uri.startsWith("file:")) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

/**
 * Normalise an LSP `DiagnosticSeverity` into the tool-facing union.
 *
 * A missing severity is the server declining to rank it; treating that as an
 * error is the conventional reading (and the one that surfaces it to a user).
 */
export function toSeverityLabel(
	severity: number | undefined,
): "error" | "warning" | "information" | "hint" {
	if (severity === 2) return "warning";
	if (severity === 3) return "information";
	if (severity === 4) return "hint";
	return "error";
}
