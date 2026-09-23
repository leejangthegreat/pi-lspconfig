/**
 * The operation surface.
 *
 * This is the single source of truth for what the unified `lsp` tool can do.
 * `tools/schemas.ts` derives its `operation` enum from {@link LSP_OPERATIONS},
 * so adding an operation here is the only change needed for it to appear in the
 * tool schema — the compiler then points at the dispatch switch below.
 *
 * ## Conventions
 *
 * - `line` / `character` are **1-based**, matching what models and compilers
 *   report. {@link toLspPosition} converts to the 0-based wire form.
 * - `symbol` + `occurrence` let the model name a target instead of guessing a
 *   column, which is the common failure mode for position-based tools.
 * - Results are always normalised into an {@link LspEnvelope}; `ok`/`status`
 *   are the authoritative outcome, never the presence of `content` text.
 */

import type { CallHierarchyItem } from "../protocol.ts";
import type { LspEnvelope } from "../types.ts";
import type { Logger } from "../util/logger.ts";
import type { LSPService } from "./service.ts";

/** Every supported operation, in documentation order. */
export const LSP_OPERATIONS = [
	// Navigation
	"definition",
	"typeDefinition",
	"declaration",
	"implementation",
	"references",
	// Information
	"hover",
	"signatureHelp",
	// Symbols
	"documentSymbol",
	"findSymbol",
	"workspaceSymbol",
	// Editing
	"codeAction",
	"rename",
	// Call graph
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
	// Escape hatches
	"executeCommand",
	"capabilities",
	"status",
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** Operations that mutate the workspace and therefore run sequentially. */
export const MUTATING_OPERATIONS: readonly LspOperation[] = ["rename"];

/** Operations that require a `path` and a position. */
export const POSITION_OPERATIONS: readonly LspOperation[] = [
	"definition",
	"typeDefinition",
	"declaration",
	"implementation",
	"references",
	"hover",
	"signatureHelp",
	"rename",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
];

/** Operations that only need a `path`. */
export const FILE_OPERATIONS: readonly LspOperation[] = [
	"documentSymbol",
	"findSymbol",
	"codeAction",
	"capabilities",
];

/** Operations that need no file at all. */
export const WORKSPACE_OPERATIONS: readonly LspOperation[] = ["workspaceSymbol", "status"];

export interface OperationRequest {
	operation: LspOperation;
	/** Absolute or cwd-relative file path. */
	path?: string;
	/** 1-based line. */
	line?: number;
	/** 1-based character. */
	character?: number;
	/** 1-based end line, for range-based operations. */
	endLine?: number;
	/** 1-based end character. */
	endCharacter?: number;
	/** Symbol name to resolve into a position, e.g. `"handleRequest"`. */
	symbol?: string;
	/** Which occurrence of `symbol` to use, 1-based. Defaults to the first. */
	occurrence?: number;
	/** Query text for `workspaceSymbol`. */
	query?: string;
	/** Restrict `workspaceSymbol` to these kinds. */
	kinds?: readonly string[];
	/** Require an exact name match for symbol lookups. */
	exactMatch?: boolean;
	/** Only return top-level symbols from `findSymbol`/`documentSymbol`. */
	topLevelOnly?: boolean;
	/** Cap on returned locations. Defaults to `DEFAULT_MAX_RESULTS`. */
	maxResults?: number;
	/** New name for `rename`. */
	newName?: string;
	/** When false (the default) `rename` previews edits instead of applying them. */
	apply?: boolean;
	/** Command id for `executeCommand`. */
	command?: string;
	/** Arguments for `executeCommand`. */
	commandArguments?: unknown[];
	/** Opaque round-trip token returned by `prepareCallHierarchy`. */
	callHierarchyItem?: CallHierarchyItem;
}

export interface OperationContext {
	cwd: string;
	/** Abort signal from the tool call, threaded into every request. */
	signal?: AbortSignal;
	/** Effective cap on returned results. */
	maxResults: number;
	logger: Logger;
}

/**
 * Dispatch one operation and normalise the outcome.
 *
 * Never throws for expected failures — a missing server, an unsupported
 * capability, or bad input all come back as an envelope with a `status`. Only
 * genuinely unexpected errors propagate, and the tool layer converts those too.
 */
export function executeOperation(
	_service: LSPService,
	_request: OperationRequest,
	_ctx: OperationContext,
): Promise<LspEnvelope> {
	throw new Error("Not implemented: executeOperation");
}

/** Narrow a raw string from the tool schema to an {@link LspOperation}. */
export function isLspOperation(_value: string): _value is LspOperation {
	throw new Error("Not implemented: isLspOperation");
}

/**
 * Validate the fields an operation requires.
 *
 * Returns human-readable problems (with a hint about what to pass instead) so
 * the model can correct itself in one turn rather than guessing.
 */
export function validateOperationRequest(_request: OperationRequest): string[] {
	throw new Error("Not implemented: validateOperationRequest");
}
