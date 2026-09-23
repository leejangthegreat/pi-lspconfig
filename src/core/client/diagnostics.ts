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

export function createDiagnosticStore(): DiagnosticStore {
	throw new Error("Not implemented: createDiagnosticStore");
}

/** Normalise an LSP `DiagnosticSeverity` into the tool-facing union. */
export function toSeverityLabel(
	_severity: number | undefined,
): "error" | "warning" | "information" | "hint" {
	throw new Error("Not implemented: toSeverityLabel");
}
