/**
 * Public domain types for pi-lspconfig.
 *
 * Layering rule: this module may import `protocol.ts` and nothing else.
 * Everything above it (`util/`, `languages/`, `config/`, `core/`, `tools/`,
 * `extension/`) depends on these shapes, never the other way around.
 */

import type {
	ClientCapabilities,
	Diagnostic,
	Location,
	PositionEncodingKind,
	Range,
	ServerCapabilities,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Server specifications
// ---------------------------------------------------------------------------

/** Context handed to a dynamic `cmd` factory. */
export interface LaunchContext {
	/** Server id being launched. */
	serverId: string;
	/** Resolved project root, or `undefined` for single-file mode. */
	root: string | undefined;
	/** Session working directory. */
	cwd: string;
}

/** Context handed to a dynamic `rootDir` resolver. */
export interface RootCtx {
	/** Session working directory. */
	cwd: string;
	/**
	 * A detected root may not escape this directory. Prevents a stray marker in
	 * `$HOME` from pulling the workspace root above the session.
	 */
	ceiling: string;
}

/**
 * One language server, in the spirit of an nvim-lspconfig server table.
 *
 * Plain data wherever possible: `cmd` and `rootDir` are the only fields that
 * may be functions, and both have declarative fast paths.
 */
export interface LspServerSpec {
	/** Unique server id, e.g. `"pyright"`. */
	id: string;
	/** Argv to launch. A function may inspect the resolved root before deciding. */
	cmd: string[] | ((ctx: LaunchContext) => string[] | Promise<string[]>);
	/** LSP `languageId`s this server handles, e.g. `["python"]`. */
	filetypes: string[];
	/** Ordered, highest-priority-first markers used to detect the project root. */
	rootMarkers?: readonly string[];
	/** Escape hatch for dynamic root detection. Takes precedence over `rootMarkers`. */
	rootDir?: (file: string, ctx: RootCtx) => string | undefined | Promise<string | undefined>;
	/** Sent as `initializationOptions`. */
	initOptions?: Record<string, unknown>;
	/** Sent via `workspace/didChangeConfiguration` after `initialized`. */
	settings?: Record<string, unknown>;
	/** Extra environment variables for the spawned process. */
	env?: Record<string, string>;
	/** Client capability overrides merged over the defaults. */
	capabilities?: ClientCapabilities;
	/** Whether the server is usable on a file with no project root. */
	singleFileSupport?: boolean;
	/**
	 * Shell command that installs the server binary.
	 *
	 * Quoted verbatim in the `binary_missing` hint so the model (and the user)
	 * gets an actionable fix rather than a generic "install it". Also the input
	 * for the opt-in auto-install path and the language docs generator.
	 */
	installCommand?: string;
	/** Handshake timeout. Defaults to `DEFAULT_INITIALIZE_TIMEOUT_MS`. */
	initializeTimeoutMs?: number;
	/** Documentation metadata; consumed by the docs generator. */
	docs?: {
		description: string;
		url?: string;
	};
}

/**
 * User-facing server declaration, keyed by id in `LspconfigUserConfig.servers`.
 *
 * Every field is optional because an entry may be a partial *override* of a
 * built-in server. An entry whose id matches no built-in is a new server, and
 * then `cmd` and `filetypes` are required — `config/resolve.ts` reports the
 * omission rather than the type system, since only it knows the catalog.
 */
export type LspServerSpecInput = Partial<Omit<LspServerSpec, "id">>;

/** Fully resolved, merged, ready-to-launch server table. */
export type ServerTable = ReadonlyMap<string, LspServerSpec>;

// ---------------------------------------------------------------------------
// User configuration
// ---------------------------------------------------------------------------

/** Shape of a `pi-lspconfig.config.ts` default export. */
export interface LspconfigUserConfig {
	/** Per-server overrides and additions, keyed by server id. */
	servers?: Record<string, LspServerSpecInput>;
	/** Server ids that must never be started. */
	disabledServers?: readonly string[];
	/** File-extension → LSP languageId overrides, e.g. `{ ".mts": "typescript" }`. */
	languageIds?: Record<string, string>;
	/** Global defaults applied to every server. */
	defaults?: {
		initializeTimeoutMs?: number;
		maxResults?: number;
	};
}

// ---------------------------------------------------------------------------
// Tool result envelope
// ---------------------------------------------------------------------------

/**
 * Machine-stable outcome of one LSP operation.
 *
 * `ok` is a convenience boolean; `status` is the authoritative reason and is
 * what renderers and tests should branch on.
 */
export type LspStatus =
	| "success"
	| "empty"
	| "unsupported"
	| "bad_input"
	| "no_server"
	| "disabled"
	| "binary_missing"
	| "error";

/** A location re-shaped for model consumption (1-based line/character). */
export interface LspLocation {
	path: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
	/** Optional one-line preview of the target, when the server supplied one. */
	preview?: string;
}

/** A diagnostic re-shaped for model consumption (1-based line/character). */
export interface LspDiagnostic {
	path: string;
	line: number;
	character: number;
	severity: "error" | "warning" | "information" | "hint";
	message: string;
	code?: string;
	source?: string;
}

// ---------------------------------------------------------------------------
// Operation payloads
// ---------------------------------------------------------------------------

/** A symbol re-shaped for model consumption (1-based line/character). */
export interface LspSymbol {
	name: string;
	/** Lower-case LSP symbol kind name, e.g. `"function"`. */
	kind: string;
	path: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
	/** Server-supplied signature or type detail, when present. */
	detail?: string;
	/** Enclosing symbol name, for flat `SymbolInformation` results. */
	containerName?: string;
	/** Nested symbols, for hierarchical `DocumentSymbol` results. */
	children?: LspSymbol[];
}

/** A text edit re-shaped for model consumption (1-based line/character). */
export interface LspTextEdit {
	path: string;
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	newText: string;
}

/** A code action the model can ask for by title. */
export interface LspCodeActionSummary {
	title: string;
	kind?: string;
	isPreferred?: boolean;
}

/** One call-hierarchy node, flattened from `CallHierarchyItem`. */
export interface LspCallHierarchyEntry {
	name: string;
	kind: string;
	path: string;
	line: number;
	character: number;
	detail?: string;
	/** Call sites within the queried item, for incoming/outgoing calls. */
	fromRanges?: LspLocation[];
	/**
	 * The raw protocol item, round-tripped verbatim.
	 *
	 * `incomingCalls`/`outgoingCalls` take a `CallHierarchyItem`, not this
	 * flattened shape, so the tool has to hand the model something it can pass
	 * straight back.
	 */
	item?: unknown;
}

/** What a server actually negotiated, for the `capabilities` operation. */
export interface LspCapabilitiesSummary {
	serverId: string;
	positionEncoding: PositionEncodingKind;
	syncKind: 0 | 1 | 2;
	/** `LspOperation`s this server supports. */
	operations: string[];
	executeCommands: string[];
}

/**
 * Operation-specific result, discriminated on `kind`.
 *
 * Which field an operation populates is a fixed contract:
 *  - navigation (`definition`, `typeDefinition`, `declaration`,
 *    `implementation`, `references`) → {@link LspEnvelope.locations};
 *  - `lsp_diagnostics` → {@link LspEnvelope.diagnostics};
 *  - every other operation → `payload`.
 *
 * `resultCount` is the primary item count of whichever field is set, and
 * `status` remains authoritative regardless of which field carries the data.
 */
export type LspPayload =
	| { kind: "text"; text: string; format: "plaintext" | "markdown" }
	| { kind: "symbols"; symbols: LspSymbol[] }
	| { kind: "edits"; edits: LspTextEdit[] }
	| { kind: "codeActions"; actions: LspCodeActionSummary[] }
	| { kind: "callHierarchy"; items: LspCallHierarchyEntry[] }
	| { kind: "capabilities"; summary: LspCapabilitiesSummary }
	| { kind: "status"; clients: LspClientStatus[] };

/** `details` payload attached to every tool result. */
export interface LspEnvelope {
	operation: string;
	ok: boolean;
	status: LspStatus;
	resultCount: number;
	locations?: LspLocation[];
	diagnostics?: LspDiagnostic[];
	/** Operation-specific result; see {@link LspPayload} for the contract. */
	payload?: LspPayload;
	notes?: string[];
	hints?: string[];
	errors?: string[];
	/** Server id(s) that served the request. */
	servers?: string[];
	/** Wall-clock duration of the operation in milliseconds. */
	durationMs?: number;
}

// ---------------------------------------------------------------------------
// Client / service surface
// ---------------------------------------------------------------------------

/** Negotiated server facts, captured once per client after `initialize`. */
export interface NegotiatedCapabilities {
	serverCapabilities: ServerCapabilities;
	positionEncoding: PositionEncodingKind;
	syncKind: 0 | 1 | 2;
	/** `workspace/executeCommand` ids the server advertises. */
	executeCommands: readonly string[];
}

/** Health snapshot for one live client. */
export interface LspClientStatus {
	serverId: string;
	root: string | undefined;
	pid: number | undefined;
	state: "starting" | "ready" | "failed" | "stopped";
	openDocuments: number;
	diagnosticCount: number;
	lastError?: string;
}

/** Options accepted by `LSPService.touchFile`. */
export interface TouchFileOptions {
	/** File contents to sync. Read from disk when omitted. */
	content?: string;
	/** Force a full-text `didChange` even when incremental sync is negotiated. */
	fullSync?: boolean;
}

export type { Range, Location, Diagnostic, ServerCapabilities, ClientCapabilities };
