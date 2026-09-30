/**
 * Normalising raw LSP responses into the shapes the envelope carries.
 *
 * Servers are inconsistent about the *union* half of their own protocol: a
 * `definition` response may be a single `Location`, a `Location[]`, or a
 * `LocationLink[]`, and `documentSymbol` may be hierarchical or flat. The
 * normalisers here accept every legal form and produce one shape, so
 * `operations.ts` (and the M3 renderer) never has to branch on it.
 *
 * Everything is validated structurally rather than trusted: a malformed item is
 * skipped, not allowed to produce a `undefined` field in a result.
 */

import type { Diagnostic, Range } from "../protocol.ts";
import type {
	LspCallHierarchyEntry,
	LspCodeActionSummary,
	LspDiagnostic,
	LspLocation,
	LspSymbol,
	LspTextEdit,
} from "../types.ts";
import { uriToPath } from "../util/paths.ts";
import { toSeverityLabel } from "./client/diagnostics.ts";

/** Symbol kind numbers 1..26, in the spelling the tool schema uses. */
const SYMBOL_KIND_NAMES: readonly string[] = [
	"file",
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"string",
	"number",
	"boolean",
	"array",
	"object",
	"key",
	"null",
	"enumMember",
	"struct",
	"event",
	"operator",
	"typeParameter",
];

/** Lower-case name for an LSP `SymbolKind` number. */
export function symbolKindName(kind: number): string {
	return SYMBOL_KIND_NAMES[kind - 1] ?? "unknown";
}

/** A `text` payload, or `undefined` when the server returned nothing useful. */
export interface TextResult {
	text: string;
	format: "plaintext" | "markdown";
}

/**
 * Locations from a `definition`/`references`-style response.
 *
 * Accepts a single `Location`, a `Location[]`, or a `LocationLink[]`; for a
 * link, the precise `targetSelectionRange` is preferred over the wider
 * `targetRange`.
 */
export function locationResults(result: unknown): LspLocation[] {
	if (result === null || result === undefined) return [];
	const items = Array.isArray(result) ? result : [result];

	const locations: LspLocation[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;

		if (typeof item.uri === "string") {
			const range = asRange(item.range);
			if (range !== undefined) {
				locations.push(locationFromRange(item.uri, range));
				continue;
			}
		}

		if (typeof item.targetUri === "string") {
			const range = asRange(item.targetSelectionRange) ?? asRange(item.targetRange);
			if (range !== undefined) locations.push(locationFromRange(item.targetUri, range));
		}
	}
	return locations;
}

/** A single `Location`-shaped result, for `hover`-style ranges. */
export function locationFromRange(uri: string, range: Range): LspLocation {
	return { path: uriToPath(uri), ...positionOf(range) };
}

/**
 * Symbols from `documentSymbol`, `findSymbol`, or `workspace/symbol`.
 *
 * Handles both the hierarchical `DocumentSymbol[]` form and the flat
 * `SymbolInformation[]`/`WorkspaceSymbol[]` form. `fallbackPath` is used when
 * the server omitted a URI (hierarchical document symbols carry no path).
 */
export function symbolResults(
	result: unknown,
	fallbackPath: string,
	options?: { topLevelOnly?: boolean },
): LspSymbol[] {
	if (!Array.isArray(result)) return [];
	const symbols: LspSymbol[] = [];
	for (const item of result) {
		const symbol = toLspSymbol(item, fallbackPath, options);
		if (symbol !== undefined) symbols.push(symbol);
	}
	return symbols;
}

/** Depth-first flatten, parents before children. */
export function flattenSymbols(symbols: readonly LspSymbol[]): LspSymbol[] {
	const flat: LspSymbol[] = [];
	const walk = (list: readonly LspSymbol[]): void => {
		for (const symbol of list) {
			flat.push(symbol);
			if (symbol.children !== undefined) walk(symbol.children);
		}
	};
	walk(symbols);
	return flat;
}

/** Hover contents as text, preferring markdown when the server used it. */
export function hoverText(result: unknown): TextResult | undefined {
	if (!isRecord(result)) return undefined;

	const parts: string[] = [];
	let markdown = false;
	const push = (value: unknown): void => {
		if (typeof value === "string") {
			parts.push(value);
			return;
		}
		if (isRecord(value) && typeof value.value === "string") {
			if (value.kind === "markdown") markdown = true;
			parts.push(value.value);
		}
	};

	if (Array.isArray(result.contents)) result.contents.forEach(push);
	else push(result.contents);

	const text = parts.join("\n\n").trim();
	return text.length === 0 ? undefined : { text, format: markdown ? "markdown" : "plaintext" };
}

/** Signature help as a rendered block, marking the active signature. */
export function signatureHelpText(result: unknown): TextResult | undefined {
	if (!isRecord(result) || !Array.isArray(result.signatures)) return undefined;

	const signatures = result.signatures.filter(isRecord);
	if (signatures.length === 0) return undefined;

	const active = typeof result.activeSignature === "number" ? result.activeSignature : 0;
	const lines: string[] = [];
	let markdown = false;

	signatures.forEach((signature, index) => {
		const label = typeof signature.label === "string" ? signature.label : "";
		lines.push(`${index === active ? "→ " : "  "}${label}`);
		if (index !== active) return;

		const documentation = documentationText(signature.documentation);
		if (documentation !== undefined) {
			if (documentation.format === "markdown") markdown = true;
			lines.push("", documentation.text);
		}
	});

	const text = lines.join("\n").trim();
	return text.length === 0 ? undefined : { text, format: markdown ? "markdown" : "plaintext" };
}

/** Text edits from a `WorkspaceEdit`, in both the `changes` and `documentChanges` forms. */
export function workspaceEditToEdits(result: unknown): LspTextEdit[] {
	if (!isRecord(result)) return [];

	const edits: LspTextEdit[] = [];
	const pushEdits = (uri: string, list: unknown): void => {
		if (!Array.isArray(list)) return;
		const path = uriToPath(uri);
		for (const edit of list) {
			if (!isRecord(edit)) continue;
			const range = asRange(edit.range);
			if (range === undefined) continue;
			edits.push({
				path,
				...positionOf(range),
				newText: typeof edit.newText === "string" ? edit.newText : "",
			});
		}
	};

	if (isRecord(result.changes)) {
		for (const [uri, list] of Object.entries(result.changes)) pushEdits(uri, list);
	}
	if (Array.isArray(result.documentChanges)) {
		for (const change of result.documentChanges) {
			if (!isRecord(change)) continue;
			const document = isRecord(change.textDocument) ? change.textDocument : undefined;
			if (document !== undefined && typeof document.uri === "string") {
				pushEdits(document.uri, change.edits);
			}
		}
	}
	return edits;
}

/** Titles and kinds from a `textDocument/codeAction` response. */
export function codeActionSummaries(result: unknown): LspCodeActionSummary[] {
	if (!Array.isArray(result)) return [];

	const actions: LspCodeActionSummary[] = [];
	for (const item of result) {
		if (!isRecord(item) || typeof item.title !== "string") continue;
		actions.push({
			title: item.title,
			...(typeof item.kind === "string" ? { kind: item.kind } : {}),
			...(typeof item.isPreferred === "boolean" ? { isPreferred: item.isPreferred } : {}),
		});
	}
	return actions;
}

/** Call-hierarchy nodes, flattened for `prepareCallHierarchy` and its two children. */
export function callHierarchyEntries(
	result: unknown,
	direction: "prepare" | "incoming" | "outgoing",
): LspCallHierarchyEntry[] {
	if (!Array.isArray(result)) return [];

	const entries: LspCallHierarchyEntry[] = [];
	for (const item of result) {
		if (!isRecord(item)) continue;

		let node: Record<string, unknown> | undefined;
		let ranges: unknown;
		if (direction === "prepare") {
			node = item;
		} else if (direction === "incoming") {
			node = isRecord(item.from) ? item.from : undefined;
			ranges = item.fromRanges;
		} else {
			node = isRecord(item.to) ? item.to : undefined;
			ranges = item.fromRanges;
		}

		if (node === undefined || typeof node.name !== "string") continue;
		const uri = typeof node.uri === "string" ? node.uri : "";
		const range = asRange(node.selectionRange) ?? asRange(node.range);
		if (range === undefined) continue;

		const entry: LspCallHierarchyEntry = {
			name: node.name,
			kind: typeof node.kind === "number" ? symbolKindName(node.kind) : "unknown",
			path: uri.length === 0 ? "" : uriToPath(uri),
			...startOf(range),
			...(typeof node.detail === "string" ? { detail: node.detail } : {}),
			// Round-tripped verbatim: `incomingCalls`/`outgoingCalls` need a
			// `CallHierarchyItem`, which only the server can produce.
			item: node,
		};

		if (Array.isArray(ranges)) {
			const fromRanges = ranges
				.map((candidate) => asRange(candidate))
				.filter((candidate): candidate is Range => candidate !== undefined)
				.map((candidate) => locationFromRange(uri, candidate));
			if (fromRanges.length > 0) entry.fromRanges = fromRanges;
		}

		entries.push(entry);
	}
	return entries;
}

/**
 * Diagnostics re-shaped for model consumption, with `path` attached.
 *
 * The diagnostic store hands back wire diagnostics (0-based, numeric severity);
 * the envelope carries 1-based positions and severity labels.
 */
export function diagnosticResults(
	diagnostics: readonly Diagnostic[],
	path: string,
): LspDiagnostic[] {
	return diagnostics.map((diagnostic) => ({
		path,
		...startOf(diagnostic.range),
		severity: toSeverityLabel(diagnostic.severity),
		message: diagnostic.message,
		...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
		...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
	}));
}

/** 1-based start position of a range. */
function startOf(range: Range): { line: number; character: number } {
	return { line: range.start.line + 1, character: range.start.character + 1 };
}

/** 1-based start and end of a range. */
function positionOf(
	range: Range,
): { line: number; character: number; endLine: number; endCharacter: number } {
	return {
		...startOf(range),
		endLine: range.end.line + 1,
		endCharacter: range.end.character + 1,
	};
}

/** One symbol item, in either the hierarchical or flat form. */
function toLspSymbol(
	item: unknown,
	fallbackPath: string,
	options?: { topLevelOnly?: boolean },
): LspSymbol | undefined {
	if (!isRecord(item) || typeof item.name !== "string") return undefined;

	const kind = typeof item.kind === "number" ? symbolKindName(item.kind) : "unknown";
	const detail = typeof item.detail === "string" ? { detail: item.detail } : {};
	const containerName = typeof item.containerName === "string" ? { containerName: item.containerName } : {};

	// Flat form: `SymbolInformation` / `WorkspaceSymbol` carry a `location`.
	if (isRecord(item.location)) {
		const range = asRange(item.location.range);
		if (range === undefined) return undefined;
		const uri = typeof item.location.uri === "string" ? item.location.uri : undefined;
		return {
			name: item.name,
			kind,
			path: uri === undefined ? fallbackPath : uriToPath(uri),
			...positionOf(range),
			...detail,
			...containerName,
		};
	}

	// Hierarchical form: `DocumentSymbol` carries ranges and optional children.
	const selectionRange = asRange(item.selectionRange) ?? asRange(item.range);
	if (selectionRange === undefined) return undefined;

	const symbol: LspSymbol = {
		name: item.name,
		kind,
		path: fallbackPath,
		...positionOf(selectionRange),
		...detail,
	};
	if (options?.topLevelOnly !== true) {
		const children = symbolResults(item.children, fallbackPath, options);
		if (children.length > 0) symbol.children = children;
	}
	return symbol;
}

/** Documentation as text, from either a string or a `MarkupContent`. */
function documentationText(value: unknown): TextResult | undefined {
	if (typeof value === "string") {
		return value.length === 0 ? undefined : { text: value, format: "plaintext" };
	}
	if (isRecord(value) && typeof value.value === "string") {
		return value.value.length === 0
			? undefined
			: { text: value.value, format: value.kind === "markdown" ? "markdown" : "plaintext" };
	}
	return undefined;
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structurally validate an LSP `Range`, or `undefined`. */
function asRange(value: unknown): Range | undefined {
	if (!isRecord(value)) return undefined;
	const start = position(value.start);
	const end = position(value.end);
	if (start === undefined || end === undefined) return undefined;
	return { start, end };
}

/** Structurally validate an LSP `Position`, or `undefined`. */
function position(value: unknown): { line: number; character: number } | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.line !== "number" || typeof value.character !== "number") return undefined;
	return { line: value.line, character: value.character };
}
