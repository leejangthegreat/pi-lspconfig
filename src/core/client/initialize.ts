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

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_CLIENT_CAPABILITIES,
	DEFAULT_POSITION_ENCODINGS,
} from "../../util/defaults.ts";
import { deepMerge } from "../../util/merge.ts";
import type { LSPConnection } from "./connection.ts";
import type {
	ClientCapabilities,
	InitializeParams,
	InitializeResult,
	PositionEncodingKind,
	ServerCapabilities,
	WorkspaceFolder,
} from "../../protocol.ts";
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
export async function initializeClient(
	connection: LSPConnection,
	options: InitializeOptions,
): Promise<NegotiatedCapabilities> {
	const params = buildInitializeParams(options);

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`initialize timed out after ${options.timeoutMs}ms`)),
		options.timeoutMs,
	);

	let result: InitializeResult | null;
	try {
		result = await connection.sendRequest<InitializeResult | null>(
			"initialize",
			params,
			controller.signal,
		);
	} catch (error) {
		// The abort may race a real response; the deadline is the authoritative
		// reason whenever it fired.
		if (controller.signal.aborted) {
			throw new Error(`initialize timed out after ${options.timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}

	const serverCapabilities = result?.capabilities ?? {};

	// Servers ask these during or right after the handshake. Answering keeps a
	// well-behaved server from stalling; the shapes are deliberately tolerant
	// because the request payloads are not part of our typed surface.
	connection.onRequest("workspace/configuration", (request) => {
		const items = (request as { items?: unknown } | undefined)?.items;
		const count = Array.isArray(items) ? items.length : 0;
		return Array.from({ length: count }, () => options.settings ?? {});
	});
	connection.onRequest("client/registerCapability", () => null);

	connection.sendNotification("initialized", {});
	if (options.settings !== undefined) {
		connection.sendNotification("workspace/didChangeConfiguration", { settings: options.settings });
	}

	return {
		serverCapabilities,
		positionEncoding: negotiatePositionEncoding(serverCapabilities),
		syncKind: negotiateSyncKind(serverCapabilities),
		executeCommands: detectExecuteCommands(serverCapabilities),
	};
}

/** Assemble the `initialize` payload, including the single-file-mode omissions. */
function buildInitializeParams(options: InitializeOptions): InitializeParams {
	const rootUri = options.root === undefined ? null : pathToFileURL(options.root).href;

	let workspaceFolders: WorkspaceFolder[] | null = null;
	if (options.workspaceFolders !== undefined) {
		workspaceFolders = [...options.workspaceFolders];
	} else if (options.root !== undefined && rootUri !== null) {
		workspaceFolders = [{ uri: rootUri, name: basename(options.root) }];
	}

	return {
		processId: process.pid,
		clientInfo: { name: "pi-lspconfig" },
		rootUri,
		workspaceFolders,
		capabilities: deepMerge(DEFAULT_CLIENT_CAPABILITIES, options.capabilities ?? {}),
		initializationOptions: options.initOptions,
		general: { positionEncodings: [...DEFAULT_POSITION_ENCODINGS] },
		trace: "off",
	};
}

/**
 * Pick a position encoding both sides support.
 *
 * The server decides: it is the one doing the encoding, so a valid advertised
 * kind wins. When it says nothing (or something unknown) UTF-16 is the only
 * safe default, because it is the one encoding every server must support.
 */
export function negotiatePositionEncoding(server: ServerCapabilities): PositionEncodingKind {
	const advertised = server.positionEncoding;
	if (advertised === "utf-8" || advertised === "utf-16" || advertised === "utf-32") {
		return advertised;
	}
	return "utf-16";
}

/** Read `textDocumentSync.change`, normalising the boolean/object forms. */
export function negotiateSyncKind(server: ServerCapabilities): 0 | 1 | 2 {
	const sync = server.textDocumentSync;
	if (sync === undefined || sync === null) return 0;
	// Legacy shorthand: `true` means full-document sync.
	if (typeof sync === "boolean") return sync ? 1 : 0;

	const change = sync.change;
	if (change === 0 || change === 1 || change === 2) return change;
	// An options object with no usable `change` only promises sync if it at
	// least wants open/close notifications, which implies full text.
	return sync.openClose === true ? 1 : 0;
}

/** Extract the `workspace/executeCommand` ids a server advertises. */
export function detectExecuteCommands(server: ServerCapabilities): readonly string[] {
	const commands = server.executeCommandProvider?.commands;
	if (!Array.isArray(commands)) return [];
	return commands.filter((command): command is string => typeof command === "string");
}

/** True when the server supports pull diagnostics (`textDocument/diagnostic`). */
export function supportsPullDiagnostics(server: ServerCapabilities): boolean {
	return Boolean(server.diagnosticProvider) || Boolean(server.workspace?.diagnostics);
}
