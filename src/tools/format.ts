/**
 * Result shaping for the tool layer.
 *
 * Two outputs per call:
 *  - `content[0].text` — compact, model-facing prose the model actually reads.
 *  - `details` — an {@link LspEnvelope}, machine-stable for rendering, tests,
 *    and future transports.
 *
 * Model-facing text is always truncated with Pi's own helpers and always says
 * how to narrow the query. A tool that silently returns 40k of JSON teaches the
 * model nothing except to stop calling it.
 *
 * Rendering is deterministic: locations and diagnostics are sorted here, never
 * in the caller, so the same query always produces the same bytes.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type AgentToolResult,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type {
	LspCallHierarchyEntry,
	LspCapabilitiesSummary,
	LspClientStatus,
	LspCodeActionSummary,
	LspDiagnostic,
	LspEnvelope,
	LspLocation,
	LspStatus,
	LspSymbol,
	LspTextEdit,
} from "../types.ts";
import { isSameOrWithin, normalizePath } from "../util/paths.ts";

/** Limits applied to every model-facing result. */
export const RESULT_MAX_LINES = DEFAULT_MAX_LINES;
export const RESULT_MAX_BYTES = DEFAULT_MAX_BYTES;

/** Fallback narrowing guidance, when a caller has nothing more specific. */
export const DEFAULT_TRUNCATION_HINT =
	"Output truncated. Narrow the query; the full result is in `details`.";

/** Narrowing guidance for the unified `lsp` tool. */
export const NARROW_RESULTS_HINT =
	"Output truncated. Narrow the query with `path`, `symbol`, or `query`; the full result is in `details`.";

/** Narrowing guidance for `lsp_diagnostics`. */
export const NARROW_DIAGNOSTICS_HINT =
	"Output truncated. Narrow by `path`, or raise `severity` to filter; the full list is in `details`.";

/** Summary line per failing status. */
const FAILURE_SUMMARIES: Record<Exclude<LspStatus, "success" | "empty">, string> = {
	unsupported: "Unsupported.",
	bad_input: "Invalid request.",
	no_server: "No language server for this request.",
	disabled: "pi-lspconfig is disabled.",
	binary_missing: "Language server binary is missing.",
	error: "Operation failed.",
};

const SEVERITY_RANK: Record<LspDiagnostic["severity"], number> = {
	error: 0,
	warning: 1,
	information: 2,
	hint: 3,
};

export interface CapResult<T> {
	items: T[];
	/** True when items were dropped by `maxResults`. */
	truncated: boolean;
	/** Count before capping. */
	total: number;
}

/** Build an envelope with sensible defaults for the optional fields. */
export function createEnvelope(
	operation: string,
	status: LspStatus,
	partial?: Partial<LspEnvelope>,
): LspEnvelope {
	return {
		...partial,
		operation,
		ok: status === "success" || status === "empty",
		status,
		resultCount: partial?.resultCount ?? 0,
	};
}

/** Stable ordering so identical queries produce identical text. */
export function sortLocations(locations: readonly LspLocation[]): LspLocation[] {
	return [...locations].sort(
		(a, b) => compareText(a.path, b.path) || a.line - b.line || a.character - b.character,
	);
}

/** Cap a result list, reporting whether anything was dropped. */
export function capResults<T>(items: readonly T[], maxResults: number): CapResult<T> {
	const limit = Math.max(1, Math.trunc(maxResults));
	const kept = items.slice(0, limit);
	return { items: kept, truncated: kept.length < items.length, total: items.length };
}

/** Sort rank for a severity label; lower is more severe. */
export function severityRank(severity: LspDiagnostic["severity"]): number {
	return SEVERITY_RANK[severity];
}

/**
 * Keep only diagnostics at least as severe as `minimum`.
 *
 * The parameter is a *minimum*, so `"hint"` (the default) keeps everything and
 * `"error"` keeps errors alone.
 */
export function filterDiagnostics(
	diagnostics: readonly LspDiagnostic[],
	minimum: LspDiagnostic["severity"],
): LspDiagnostic[] {
	const limit = severityRank(minimum);
	return diagnostics.filter((diagnostic) => severityRank(diagnostic.severity) <= limit);
}

/**
 * File-major ordering: files stay contiguous, and within a file the most severe
 * diagnostics come first.
 *
 * Severity-major across files (every error anywhere, then every warning) is the
 * rejected alternative: a reader checks one file at a time, and an interleaved
 * list makes "is this file clean?" unanswerable at a glance.
 */
export function sortDiagnostics(diagnostics: readonly LspDiagnostic[]): LspDiagnostic[] {
	return [...diagnostics].sort(
		(a, b) =>
			compareText(normalizePath(a.path), normalizePath(b.path)) ||
			severityRank(a.severity) - severityRank(b.severity) ||
			a.line - b.line ||
			a.character - b.character,
	);
}

/** Render locations as `path:line:character` lines with optional previews. */
export function renderLocations(locations: readonly LspLocation[], cwd: string): string {
	return sortLocations(locations)
		.map((location) => {
			const head = `${displayPath(location.path, cwd)}:${location.line}:${location.character}`;
			const preview = location.preview === undefined ? "" : collapseWhitespace(location.preview);
			// One line per location: the preview stays inline so the line count
			// still matches the result count.
			return preview.length === 0 ? head : `${head}  ${preview}`;
		})
		.join("\n");
}

/** Render diagnostics grouped by file, errors first. */
export function renderDiagnostics(diagnostics: readonly LspDiagnostic[], cwd: string): string {
	const lines: string[] = [];
	let currentFile: string | undefined;

	for (const diagnostic of sortDiagnostics(diagnostics)) {
		const file = displayPath(diagnostic.path, cwd);
		if (file !== currentFile) {
			lines.push(file);
			currentFile = file;
		}
		const message = collapseWhitespace(diagnostic.message);
		lines.push(
			`  ${diagnostic.line}:${diagnostic.character}: ${diagnostic.severity}: ${message}${originSuffix(diagnostic)}`,
		);
	}
	return lines.join("\n");
}

/** Render the human-facing summary for an envelope, including notes and hints. */
export function renderEnvelope(envelope: LspEnvelope, cwd: string): string {
	const sections = [summaryLine(envelope), bodyFor(envelope, cwd)];
	sections.push(...(envelope.notes ?? []).map((note) => `note: ${note}`));
	sections.push(...(envelope.errors ?? []).map((error) => `error: ${error}`));
	sections.push(...(envelope.hints ?? []).map((hint) => `hint: ${hint}`));
	return sections.filter((section) => section.length > 0).join("\n");
}

/**
 * Render, truncate, and package an envelope as a tool result.
 *
 * The truncation hint is recorded in `details.hints` *after* rendering, so
 * re-rendering the envelope does not print it twice.
 */
export function toolResult(
	envelope: LspEnvelope,
	cwd: string,
	hint: string,
): AgentToolResult<LspEnvelope> {
	const truncated = truncateForModel(renderEnvelope(envelope, cwd), { hint });
	if (truncated.truncated && truncated.hint !== undefined) {
		envelope.hints = [...(envelope.hints ?? []), truncated.hint];
	}
	return { content: [{ type: "text", text: truncated.text }], details: envelope };
}

export interface TruncatedText {
	text: string;
	truncated: boolean;
	/** Appended guidance naming the narrowing options, when truncation occurred. */
	hint?: string;
}

/**
 * Truncate model-facing text and append a narrowing hint.
 *
 * The hint is the important half: it tells the model to raise `maxResults`
 * is *not* the fix, and that narrowing by `path`/`symbol`/`query` is.
 *
 * The appended hint may push the result past `maxBytes`; that is intended, and
 * a test asserting `text.length <= maxBytes` would be wrong.
 */
export function truncateForModel(
	text: string,
	options?: { maxLines?: number; maxBytes?: number; hint?: string },
): TruncatedText {
	const result = truncateHead(text, {
		maxLines: options?.maxLines ?? RESULT_MAX_LINES,
		maxBytes: options?.maxBytes ?? RESULT_MAX_BYTES,
	});
	if (!result.truncated) return { text, truncated: false };

	const hint = options?.hint ?? DEFAULT_TRUNCATION_HINT;
	return { text: `${result.content}\n\n${hint}`, truncated: true, hint };
}

/** One-line summary of what the envelope holds, or `""` when the body says it. */
function summaryLine(envelope: LspEnvelope): string {
	if (envelope.status !== "success" && envelope.status !== "empty") {
		return FAILURE_SUMMARIES[envelope.status];
	}
	if (envelope.status === "empty") {
		if (envelope.operation === "lsp_diagnostics") return "No diagnostics.";
		if (envelope.operation === "status") return "No language servers are running.";
		return "No results.";
	}

	const payload = envelope.payload;
	if (payload === undefined) {
		if (envelope.locations !== undefined) return `${count(envelope.locations.length, "location")}.`;
		if (envelope.diagnostics !== undefined) {
			return `${count(envelope.diagnostics.length, "diagnostic")}.`;
		}
		return "Done.";
	}

	switch (payload.kind) {
		case "text":
			// The text is the body; a summary would only repeat it.
			return "";
		case "symbols":
			return `${count(payload.symbols.length, "symbol")}.`;
		case "edits":
			return `${count(payload.edits.length, "edit")}.`;
		case "codeActions":
			return `${count(payload.actions.length, "code action")}.`;
		case "callHierarchy":
			return `${count(payload.items.length, "call-hierarchy item")}.`;
		case "capabilities":
			return `Server ${payload.summary.serverId} (${payload.summary.positionEncoding}, sync ${payload.summary.syncKind}).`;
		case "status":
			return `${count(payload.clients.length, "client")}.`;
	}
}

/** The rendered result itself, without summary, notes, errors, or hints. */
function bodyFor(envelope: LspEnvelope, cwd: string): string {
	if (envelope.locations !== undefined && envelope.locations.length > 0) {
		return renderLocations(envelope.locations, cwd);
	}
	if (envelope.diagnostics !== undefined && envelope.diagnostics.length > 0) {
		return renderDiagnostics(envelope.diagnostics, cwd);
	}

	const payload = envelope.payload;
	if (payload === undefined) return "";

	switch (payload.kind) {
		case "text":
			return payload.text;
		case "symbols":
			return renderSymbols(payload.symbols, cwd, 0);
		case "edits":
			return payload.edits.map((edit) => renderEdit(edit, cwd)).join("\n");
		case "codeActions":
			return payload.actions.map(renderCodeAction).join("\n");
		case "callHierarchy":
			return renderCallHierarchy(payload.items, cwd, envelope.operation);
		case "capabilities":
			return renderCapabilities(payload.summary);
		case "status":
			return payload.clients.map((client) => renderClient(client, cwd)).join("\n");
	}
}

function renderSymbols(symbols: readonly LspSymbol[], cwd: string, depth: number): string {
	const indent = "  ".repeat(depth);
	return symbols
		.map((symbol) => {
			const head = `${indent}${symbol.kind} ${symbol.name} ${displayPath(symbol.path, cwd)}:${symbol.line}:${symbol.character}`;
			const detail = symbol.detail === undefined ? "" : ` (${collapseWhitespace(symbol.detail)})`;
			const children =
				symbol.children === undefined || symbol.children.length === 0
					? ""
					: `\n${renderSymbols(symbol.children, cwd, depth + 1)}`;
			return `${head}${detail}${children}`;
		})
		.join("\n");
}

function renderEdit(edit: LspTextEdit, cwd: string): string {
	const range = `${displayPath(edit.path, cwd)}:${edit.line}:${edit.character}-${edit.endLine}:${edit.endCharacter}`;
	// `JSON.stringify` keeps a multi-line replacement on one line.
	return `${range} ${JSON.stringify(edit.newText)}`;
}

function renderCodeAction(action: LspCodeActionSummary): string {
	const kind = action.kind ?? "action";
	const preferred = action.isPreferred === true ? " (preferred)" : "";
	return `${kind} ${JSON.stringify(action.title)}${preferred}`;
}

function renderCallHierarchy(
	items: readonly LspCallHierarchyEntry[],
	cwd: string,
	operation: string,
): string {
	const lines: string[] = [];
	for (const item of items) {
		const detail = item.detail === undefined ? "" : ` (${collapseWhitespace(item.detail)})`;
		lines.push(
			`${item.kind} ${item.name} ${displayPath(item.path, cwd)}:${item.line}:${item.character}${detail}`,
		);
		// Only `prepareCallHierarchy` output is meant to be handed back, and the
		// raw item is bulky — print it only where the model needs to copy it.
		if (operation === "prepareCallHierarchy" && item.item !== undefined) {
			lines.push(`  item: ${JSON.stringify(item.item)}`);
		}
		for (const range of item.fromRanges ?? []) {
			lines.push(`  at ${displayPath(range.path, cwd)}:${range.line}:${range.character}`);
		}
	}
	return lines.join("\n");
}

function renderCapabilities(summary: LspCapabilitiesSummary): string {
	const lines = [`operations: ${summary.operations.join(", ")}`];
	if (summary.executeCommands.length > 0) {
		lines.push(`commands: ${summary.executeCommands.join(", ")}`);
	}
	return lines.join("\n");
}

function renderClient(client: LspClientStatus, cwd: string): string {
	const root = client.root === undefined ? "(no root)" : displayPath(client.root, cwd);
	const pid = client.pid === undefined ? "-" : String(client.pid);
	const lastError = client.lastError === undefined ? "" : ` error ${client.lastError}`;
	return `${client.serverId} ${client.state} root ${root} pid ${pid} documents ${client.openDocuments} diagnostics ${client.diagnosticCount}${lastError}`;
}

/** `cwd`-relative when the path lives inside it, absolute otherwise. */
function displayPath(path: string, cwd: string): string {
	if (path.length === 0 || cwd.length === 0 || !isSameOrWithin(path, cwd)) return normalizePath(path);

	const normalized = normalizePath(path);
	const base = normalizePath(cwd);
	if (normalized === base) return ".";
	const prefix = base.endsWith("/") ? base : `${base}/`;
	return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

/** ` [source code]`, ` [code]`, ` [source]`, or nothing. */
function originSuffix(diagnostic: LspDiagnostic): string {
	const parts: string[] = [];
	if (diagnostic.source !== undefined && diagnostic.source.length > 0) parts.push(diagnostic.source);
	if (diagnostic.code !== undefined && diagnostic.code.length > 0) parts.push(diagnostic.code);
	return parts.length === 0 ? "" : ` [${parts.join(" ")}]`;
}

/** Collapse every whitespace run to a single space. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Code-unit comparison, so ordering never depends on the host locale. */
function compareText(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export { truncateHead, formatSize, type TruncationResult };
