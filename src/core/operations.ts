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

import { resolve as resolvePath } from "node:path";
import type { CallHierarchyItem, ServerCapabilities } from "../protocol.ts";
import type {
	LspEnvelope,
	LspStatus,
	LspSymbol,
	NegotiatedCapabilities,
} from "../types.ts";
import type { Logger } from "../util/logger.ts";
import { normalizePath, pathToUri } from "../util/paths.ts";
import { toLspPosition, type ZeroBasedPosition } from "../util/text.ts";
import { isLSPRequestError } from "./client/connection.ts";
import {
	callHierarchyEntries,
	codeActionSummaries,
	flattenSymbols,
	hoverText,
	locationResults,
	signatureHelpText,
	symbolResults,
	workspaceEditToEdits,
} from "./results.ts";
import { isLSPServiceError, LSPServiceError, type ClientDescription, type LSPService } from "./service.ts";

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

/**
 * Call-hierarchy children that are classified as position operations (they need
 * a `path` to select a server) but take a `callHierarchyItem` instead of a
 * position, so no position is resolved for them.
 */
const CALL_HIERARCHY_CHILDREN: readonly LspOperation[] = ["incomingCalls", "outgoingCalls"];

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

/** The LSP method and gating capability for one operation. */
interface OperationRoute {
	method?: string;
	capability?: keyof ServerCapabilities;
}

/**
 * Operation → LSP method and capability.
 *
 * `capabilities` and `status` are answered locally. `findSymbol` reuses
 * `documentSymbol` because resolving a name to a position is exactly what a
 * document-symbol query returns.
 */
const OPERATION_ROUTES: Record<LspOperation, OperationRoute> = {
	definition: { method: "textDocument/definition", capability: "definitionProvider" },
	typeDefinition: { method: "textDocument/typeDefinition", capability: "typeDefinitionProvider" },
	declaration: { method: "textDocument/declaration", capability: "declarationProvider" },
	implementation: { method: "textDocument/implementation", capability: "implementationProvider" },
	references: { method: "textDocument/references", capability: "referencesProvider" },
	hover: { method: "textDocument/hover", capability: "hoverProvider" },
	signatureHelp: { method: "textDocument/signatureHelp", capability: "signatureHelpProvider" },
	documentSymbol: { method: "textDocument/documentSymbol", capability: "documentSymbolProvider" },
	findSymbol: { method: "textDocument/documentSymbol", capability: "documentSymbolProvider" },
	workspaceSymbol: { method: "workspace/symbol", capability: "workspaceSymbolProvider" },
	codeAction: { method: "textDocument/codeAction", capability: "codeActionProvider" },
	rename: { method: "textDocument/rename", capability: "renameProvider" },
	prepareCallHierarchy: {
		method: "textDocument/prepareCallHierarchy",
		capability: "callHierarchyProvider",
	},
	incomingCalls: { method: "callHierarchy/incomingCalls", capability: "callHierarchyProvider" },
	outgoingCalls: { method: "callHierarchy/outgoingCalls", capability: "callHierarchyProvider" },
	executeCommand: { method: "workspace/executeCommand", capability: "executeCommandProvider" },
	capabilities: {},
	status: {},
};

/**
 * Dispatch one operation and normalise the outcome.
 *
 * Never throws for expected failures — a missing server, an unsupported
 * capability, or bad input all come back as an envelope with a `status`. Only
 * genuinely unexpected errors propagate, and the tool layer converts those too.
 */
export async function executeOperation(
	service: LSPService,
	request: OperationRequest,
	ctx: OperationContext,
): Promise<LspEnvelope> {
	const startedAt = Date.now();
	// Populated by `runOperation`; `finish` reads it after the fact so failures
	// still name the server that was involved.
	const servers: string[] = [];

	const finish = (status: LspStatus, partial: Partial<LspEnvelope> = {}): LspEnvelope => ({
		operation: request.operation,
		ok: status === "success" || status === "empty",
		status,
		resultCount: 0,
		durationMs: Date.now() - startedAt,
		...(servers.length > 0 ? { servers: [...servers] } : {}),
		...partial,
	});

	const problems = validateOperationRequest(request);
	if (problems.length > 0) {
		return finish("bad_input", {
			errors: problems,
			hints: ["Correct the fields listed above and retry."],
		});
	}

	try {
		const outcome = await runOperation(service, request, ctx, servers);
		return finish(outcome.status, outcome.partial);
	} catch (error) {
		const outcome = mapError(error, request);
		return finish(outcome.status, outcome.partial);
	}
}

/** Narrow a raw string from the tool schema to an {@link LspOperation}. */
export function isLspOperation(value: string): value is LspOperation {
	return (LSP_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Validate the fields an operation requires.
 *
 * Returns human-readable problems (with a hint about what to pass instead) so
 * the model can correct itself in one turn rather than guessing.
 */
export function validateOperationRequest(request: OperationRequest): string[] {
	const problems: string[] = [];
	const operation = request.operation;

	if (!isLspOperation(operation)) {
		return [`Unknown operation '${String(operation)}'.`];
	}

	const needsPath =
		POSITION_OPERATIONS.includes(operation) || FILE_OPERATIONS.includes(operation);
	if (needsPath && (request.path === undefined || request.path.length === 0)) {
		problems.push(`Operation '${operation}' requires \`path\`.`);
	}

	if (POSITION_OPERATIONS.includes(operation) && !CALL_HIERARCHY_CHILDREN.includes(operation)) {
		const hasSymbol = request.symbol !== undefined && request.symbol.length > 0;
		const hasAnyPosition = request.line !== undefined || request.character !== undefined;
		const hasPosition = request.line !== undefined && request.character !== undefined;

		if (hasAnyPosition && !hasPosition) {
			problems.push(
				`Pass both \`line\` and \`character\` (1-based), or use \`symbol\` instead of a partial position.`,
			);
		} else if (!hasPosition && !hasSymbol) {
			problems.push(
				`Operation '${operation}' requires a position: pass \`line\` and \`character\` (1-based), or \`symbol\` (plus \`occurrence\` when the name repeats).`,
			);
		}
	}

	if (request.occurrence !== undefined && (request.symbol === undefined || request.symbol.length === 0)) {
		problems.push("`occurrence` requires `symbol`.");
	}
	if (request.line !== undefined && request.line < 1) {
		problems.push("`line` is 1-based and must be at least 1.");
	}
	if (request.character !== undefined && request.character < 1) {
		problems.push("`character` is 1-based and must be at least 1.");
	}
	if (operation === "workspaceSymbol" && (request.query === undefined || request.query.length === 0)) {
		problems.push("Operation 'workspaceSymbol' requires `query`.");
	}
	if (operation === "rename" && (request.newName === undefined || request.newName.length === 0)) {
		problems.push("Operation 'rename' requires `newName`.");
	}
	if (operation === "executeCommand" && (request.command === undefined || request.command.length === 0)) {
		problems.push("Operation 'executeCommand' requires `command`.");
	}
	if (
		(operation === "incomingCalls" || operation === "outgoingCalls") &&
		request.callHierarchyItem === undefined
	) {
		problems.push(
			`Operation '${operation}' requires \`callHierarchyItem\`, the token returned by 'prepareCallHierarchy'.`,
		);
	}

	return problems;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** A status plus the envelope fields that go with it. */
interface Outcome {
	status: LspStatus;
	partial: Partial<LspEnvelope>;
}

async function runOperation(
	service: LSPService,
	request: OperationRequest,
	ctx: OperationContext,
	servers: string[],
): Promise<Outcome> {
	// `status` is answered locally and must not start anything.
	if (request.operation === "status") {
		const clients = service.status();
		return {
			status: clients.length > 0 ? "success" : "empty",
			partial: {
				resultCount: clients.length,
				payload: { kind: "status", clients: [...clients] },
			},
		};
	}

	// `workspaceSymbol` needs no file; pick the first configured server.
	if (request.operation === "workspaceSymbol" && request.path === undefined) {
		return runWorkspaceSymbol(service, request, ctx, servers);
	}

	const path = normalizePath(resolvePath(ctx.cwd, request.path ?? ""));
	const description = await service.describe(path);
	servers.push(description.serverId);

	const route = OPERATION_ROUTES[request.operation];
	if (
		route.capability !== undefined &&
		!supportsCapability(description.capabilities.serverCapabilities, route.capability)
	) {
		return unsupported(
			`${description.serverId} does not support '${request.operation}'.`,
			`Supported here: ${supportedOperations(description.capabilities).join(", ")}.`,
		);
	}

	if (request.operation === "capabilities") return capabilitiesOutcome(description);

	if (request.operation === "rename" && request.apply === true) {
		return unsupported(
			"pi-lspconfig previews rename edits; it does not write files.",
			"Leave `apply` false, then apply the returned edits with the `edit` tool.",
		);
	}

	if (request.operation === "executeCommand") {
		const commands = description.capabilities.executeCommands;
		if (
			commands.length > 0 &&
			request.command !== undefined &&
			!commands.includes(request.command)
		) {
			return unsupported(
				`${description.serverId} does not offer command '${request.command}'.`,
				`Available: ${commands.join(", ")}.`,
			);
		}
	}

	const needsPosition =
		POSITION_OPERATIONS.includes(request.operation) &&
		!CALL_HIERARCHY_CHILDREN.includes(request.operation);
	const position = needsPosition
		? await resolvePosition(service, path, request, ctx, description)
		: undefined;

	if (route.method === undefined) {
		return unsupported(`Operation '${request.operation}' has no server method.`);
	}

	const raw = await service.request(
		path,
		route.method,
		buildParams(request, path, position, service),
		ctx.signal,
	);
	return normalize(request, raw, path, ctx);
}

/** `workspaceSymbol` without a `path`: use the first configured server. */
async function runWorkspaceSymbol(
	service: LSPService,
	request: OperationRequest,
	ctx: OperationContext,
	servers: string[],
): Promise<Outcome> {
	const spec = service.allServers()[0];
	if (spec === undefined) {
		return { status: "no_server", partial: { errors: ["No language servers are configured."] } };
	}
	servers.push(spec.id);

	const raw = await service.requestWithServer(
		spec.id,
		undefined,
		"workspace/symbol",
		{ query: request.query ?? "" },
		ctx.signal,
	);

	const notes: string[] = [];
	const symbols = capList(
		selectOccurrence(filterSymbols(symbolResults(raw, ""), request), request.occurrence),
		ctx.maxResults,
		notes,
	);
	return {
		status: symbols.length > 0 ? "success" : "empty",
		partial: { resultCount: symbols.length, payload: { kind: "symbols", symbols }, notes },
	};
}

/** Turn a raw response into an envelope payload. */
function normalize(
	request: OperationRequest,
	raw: unknown,
	path: string,
	ctx: OperationContext,
): Outcome {
	const notes: string[] = [];

	switch (request.operation) {
		case "definition":
		case "typeDefinition":
		case "declaration":
		case "implementation":
		case "references": {
			const locations = capList(locationResults(raw), ctx.maxResults, notes);
			return {
				status: locations.length > 0 ? "success" : "empty",
				partial: { locations, resultCount: locations.length, notes },
			};
		}

		case "hover": {
			const text = hoverText(raw);
			if (text === undefined) return empty(notes);
			return { status: "success", partial: { resultCount: 1, payload: { kind: "text", ...text }, notes } };
		}

		case "signatureHelp": {
			const text = signatureHelpText(raw);
			if (text === undefined) return empty(notes);
			return { status: "success", partial: { resultCount: 1, payload: { kind: "text", ...text }, notes } };
		}

		case "documentSymbol": {
			const symbols = capList(
				symbolResults(raw, path, { topLevelOnly: request.topLevelOnly === true }),
				ctx.maxResults,
				notes,
			);
			return {
				status: symbols.length > 0 ? "success" : "empty",
				partial: { resultCount: symbols.length, payload: { kind: "symbols", symbols }, notes },
			};
		}

		case "findSymbol": {
			const all = flattenSymbols(
				symbolResults(raw, path, { topLevelOnly: request.topLevelOnly === true }),
			);
			const matches = selectOccurrence(filterSymbols(all, request), request.occurrence);
			if (matches.length === 0) {
				return empty([
					...notes,
					`No symbol matching '${request.symbol ?? ""}' in ${path}.`,
				]);
			}
			const symbols = capList(matches, ctx.maxResults, notes);
			return {
				status: "success",
				partial: { resultCount: symbols.length, payload: { kind: "symbols", symbols }, notes },
			};
		}

		case "workspaceSymbol": {
			const symbols = capList(
				selectOccurrence(filterSymbols(symbolResults(raw, ""), request), request.occurrence),
				ctx.maxResults,
				notes,
			);
			return {
				status: symbols.length > 0 ? "success" : "empty",
				partial: { resultCount: symbols.length, payload: { kind: "symbols", symbols }, notes },
			};
		}

		case "codeAction": {
			const actions = capList(codeActionSummaries(raw), ctx.maxResults, notes);
			if (actions.length > 0) {
				notes.push("Code actions are listed, not applied; use the `edit` tool to apply one.");
			}
			return {
				status: actions.length > 0 ? "success" : "empty",
				partial: { resultCount: actions.length, payload: { kind: "codeActions", actions }, notes },
			};
		}

		case "rename": {
			const edits = capList(workspaceEditToEdits(raw), ctx.maxResults, notes);
			if (edits.length > 0) {
				notes.push("Preview only; apply these edits with the `edit` tool.");
			}
			return {
				status: edits.length > 0 ? "success" : "empty",
				partial: { resultCount: edits.length, payload: { kind: "edits", edits }, notes },
			};
		}

		case "prepareCallHierarchy":
		case "incomingCalls":
		case "outgoingCalls": {
			const direction =
				request.operation === "prepareCallHierarchy"
					? "prepare"
					: request.operation === "incomingCalls"
						? "incoming"
						: "outgoing";
			const items = capList(callHierarchyEntries(raw, direction), ctx.maxResults, notes);
			return {
				status: items.length > 0 ? "success" : "empty",
				partial: { resultCount: items.length, payload: { kind: "callHierarchy", items }, notes },
			};
		}

		case "executeCommand": {
			const text = stringifyResult(raw);
			if (text === undefined) return empty(notes);
			return {
				status: "success",
				partial: {
					resultCount: 1,
					payload: { kind: "text", text, format: "plaintext" },
					notes,
				},
			};
		}

		case "capabilities":
		case "status":
			// Handled before dispatch; unreachable.
			return unsupported(`Operation '${request.operation}' is answered locally.`);
	}
}

/** Request parameters for one operation. */
function buildParams(
	request: OperationRequest,
	path: string,
	position: ZeroBasedPosition | undefined,
	service: LSPService,
): unknown {
	const textDocument = { uri: pathToUri(path) };

	switch (request.operation) {
		case "references":
			return { textDocument, position, context: { includeDeclaration: true } };

		case "codeAction": {
			const start = position ?? { line: 0, character: 0 };
			const end =
				request.endLine !== undefined && request.endCharacter !== undefined
					? toLspPosition(request.endLine, request.endCharacter)
					: start;
			return {
				textDocument,
				range: { start, end },
				context: { diagnostics: service.cachedDiagnostics(path) },
			};
		}

		case "rename":
			return { textDocument, position, newName: request.newName };

		case "documentSymbol":
		case "findSymbol":
			return { textDocument };

		case "workspaceSymbol":
			return { query: request.query ?? "" };

		case "incomingCalls":
		case "outgoingCalls":
			return { item: request.callHierarchyItem };

		case "executeCommand":
			return { command: request.command, arguments: request.commandArguments ?? [] };

		default:
			return { textDocument, position };
	}
}

/** Resolve `symbol` + `occurrence` into a wire position via `documentSymbol`. */
async function resolvePosition(
	service: LSPService,
	path: string,
	request: OperationRequest,
	ctx: OperationContext,
	description: ClientDescription,
): Promise<ZeroBasedPosition> {
	if (request.line !== undefined && request.character !== undefined) {
		return toLspPosition(request.line, request.character);
	}

	const symbol = request.symbol ?? "";
	if (
		!supportsCapability(description.capabilities.serverCapabilities, "documentSymbolProvider")
	) {
		throw new LSPServiceError(
			"unsupported",
			`${description.serverId} cannot resolve \`symbol\` (no document-symbol support).`,
			["Pass `line` and `character` instead."],
		);
	}

	const raw = await service.request(
		path,
		"textDocument/documentSymbol",
		{ textDocument: { uri: pathToUri(path) } },
		ctx.signal,
	);
	const matches = filterSymbols(flattenSymbols(symbolResults(raw, path)), request);
	const occurrence = request.occurrence ?? 1;
	const target = matches[occurrence - 1];

	if (target === undefined) {
		throw new LSPServiceError("bad_input", `No symbol named '${symbol}' in ${path}.`, [
			matches.length > 0
				? `Only ${matches.length} match(es); lower \`occurrence\` or pass \`line\`/\`character\`.`
				: "Check the spelling, or pass `line` and `character`.",
		]);
	}
	return toLspPosition(target.line, target.character);
}

/** Filter symbols by name (exact or substring) and by kind. */
function filterSymbols(symbols: readonly LspSymbol[], request: OperationRequest): LspSymbol[] {
	const name = request.symbol ?? "";
	const exact = request.exactMatch !== false;
	const kinds =
		request.kinds !== undefined && request.kinds.length > 0
			? new Set(request.kinds.map((kind) => kind.toLowerCase()))
			: undefined;

	let matches = symbols.filter((symbol) =>
		exact ? symbol.name === name : symbol.name.toLowerCase().includes(name.toLowerCase()),
	);
	if (kinds !== undefined) matches = matches.filter((symbol) => kinds.has(symbol.kind.toLowerCase()));
	return matches;
}

/**
 * Narrow matches to one `occurrence` (1-based).
 *
 * Applied once, by the caller that actually wants a single target; listing
 * operations return every match when `occurrence` is omitted.
 */
function selectOccurrence(symbols: readonly LspSymbol[], occurrence: number | undefined): LspSymbol[] {
	if (occurrence === undefined) return [...symbols];
	const target = symbols[occurrence - 1];
	return target === undefined ? [] : [target];
}

/** The `capabilities` operation, answered from the negotiated facts. */
function capabilitiesOutcome(description: ClientDescription): Outcome {
	const { serverId, capabilities } = description;
	return {
		status: "success",
		partial: {
			resultCount: 1,
			payload: {
				kind: "capabilities",
				summary: {
					serverId,
					positionEncoding: capabilities.positionEncoding,
					syncKind: capabilities.syncKind,
					operations: supportedOperations(capabilities),
					executeCommands: [...capabilities.executeCommands],
				},
			},
		},
	};
}

/** Operations this server's advertised capabilities can satisfy. */
function supportedOperations(capabilities: NegotiatedCapabilities): string[] {
	return LSP_OPERATIONS.filter((operation) => {
		const route = OPERATION_ROUTES[operation];
		if (route.capability === undefined) return true;
		return supportsCapability(capabilities.serverCapabilities, route.capability);
	});
}

/** True when the server advertises a capability (boolean or options object). */
function supportsCapability(server: ServerCapabilities, key: keyof ServerCapabilities): boolean {
	return Boolean(server[key]);
}

/** An `empty` outcome with the given notes. */
function empty(notes: string[]): Outcome {
	return { status: "empty", partial: { resultCount: 0, notes } };
}

/** An `unsupported` outcome naming the reason and the way forward. */
function unsupported(message: string, hint?: string): Outcome {
	return {
		status: "unsupported",
		partial: { errors: [message], ...(hint === undefined ? {} : { hints: [hint] }) },
	};
}

/** Cap a list, recording how to narrow the query when anything was dropped. */
function capList<T>(items: T[], maxResults: number, notes: string[]): T[] {
	const limit = Math.max(1, Math.trunc(maxResults));
	if (items.length <= limit) return items;
	notes.push(
		`Showing ${limit} of ${items.length}; narrow the query (by \`path\`, \`symbol\`, or \`query\`) to see the rest.`,
	);
	return items.slice(0, limit);
}

/** Render an `executeCommand` result as text. */
function stringifyResult(raw: unknown): string | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw === "string") return raw.length === 0 ? undefined : raw;
	try {
		return JSON.stringify(raw, null, 2);
	} catch {
		return String(raw);
	}
}

/** Map a thrown error onto an envelope outcome. */
function mapError(error: unknown, request: OperationRequest): Outcome {
	if (isLSPServiceError(error)) {
		return {
			status: error.status,
			partial: { errors: [error.message], ...(error.hints.length > 0 ? { hints: [...error.hints] } : {}) },
		};
	}

	if (isLSPRequestError(error)) {
		if (error.code === -32601) {
			return {
				status: "unsupported",
				partial: {
					errors: [error.message],
					hints: ["The server does not implement this request."],
				},
			};
		}
		return { status: "error", partial: { errors: [`LSP error ${error.code}: ${error.message}`] } };
	}

	if (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "ENOENT"
	) {
		return {
			status: "bad_input",
			partial: { errors: [`File not found: ${request.path ?? ""}`] },
		};
	}

	const message = error instanceof Error ? error.message : String(error);
	return { status: "error", partial: { errors: [message] } };
}
