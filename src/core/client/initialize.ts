/**
 * The `initialize` handshake and capability negotiation.
 *
 * A server is not usable until we know three things it decides, not us:
 *  - which position encoding it will use for `character` offsets,
 *  - how it wants document changes synchronised (none/full/incremental),
 *  - which `workspace/executeCommand` ids it accepts.
 *
 * All three are captured once, here, into `NegotiatedCapabilities`.
 */

import type { LSPConnection } from "./connection.ts";
import type { ClientCapabilities, ServerCapabilities, WorkspaceFolder } from "../../protocol.ts";
import type { NegotiatedCapabilities } from "../../types.ts";

export interface InitializeOptions {
	/** Resolved workspace root, or `undefined` for single-file mode. */
	root: string | undefined;
	/** Sibling roots for the same server, when the workspace is multi-root. */
	workspaceFolders?: readonly WorkspaceFolder[];
	/** Overrides merged over `DEFAULT_CLIENT_CAPABILITIES`. */
	capabilities?: ClientCapabilities;
	/** Sent as `initializationOptions`. */
	initOptions?: Record<string, unknown>;
	/** Sent via `workspace/didChangeConfiguration` after `initialized`. */
	settings?: Record<string, unknown>;
	/** Handshake deadline. */
	timeoutMs: number;
}

/**
 * Run `initialize` → `initialized` → `workspace/didChangeConfiguration`.
 *
 * `processId` is pi's own pid so servers that watch the parent exit cleanly
 * when pi is killed. No `rootUri`/`workspaceFolders` are sent in single-file
 * mode, matching nvim-lspconfig.
 */
export function initializeClient(
	_connection: LSPConnection,
	_options: InitializeOptions,
): Promise<NegotiatedCapabilities> {
	throw new Error("Not implemented: initializeClient");
}

/**
 * Pick a position encoding both sides support.
 *
 * UTF-16 wins whenever offered, because it is the only encoding every server
 * is required to implement. Returns the negotiated kind so the position
 * converter can translate model-facing 1-based offsets correctly.
 */
export function negotiatePositionEncoding(_server: ServerCapabilities): "utf-8" | "utf-16" | "utf-32" {
	throw new Error("Not implemented: negotiatePositionEncoding");
}

/** Read `textDocumentSync.change`, normalising the boolean/object forms. */
export function negotiateSyncKind(_server: ServerCapabilities): 0 | 1 | 2 {
	throw new Error("Not implemented: negotiateSyncKind");
}

/** Extract the `workspace/executeCommand` ids a server advertises. */
export function detectExecuteCommands(_server: ServerCapabilities): readonly string[] {
	throw new Error("Not implemented: detectExecuteCommands");
}

/** True when the server supports pull diagnostics (`textDocument/diagnostic`). */
export function supportsPullDiagnostics(_server: ServerCapabilities): boolean {
	throw new Error("Not implemented: supportsPullDiagnostics");
}
