/**
 * The `lsp_diagnostics` tool.
 *
 * Kept separate from `lsp` because it answers a different question with a
 * different lifecycle: "is this code correct right now?" rather than "where is
 * this symbol?". It is also the tool that most benefits from waiting for a
 * quiet window, since it is normally called immediately after an edit.
 *
 * It does not go through `executeOperation`: diagnostics are pushed by the
 * server into a store, not requested as an operation, so this module reads the
 * store directly and builds the same {@link LspEnvelope} by hand.
 */

import { resolve as resolvePath } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { diagnosticResults } from "../core/results.ts";
import { isLSPServiceError, type LSPService } from "../core/service.ts";
import type { Diagnostic } from "../protocol.ts";
import type { LspDiagnostic, LspEnvelope } from "../types.ts";
import {
	capResults,
	createEnvelope,
	filterDiagnostics,
	NARROW_DIAGNOSTICS_HINT,
	sortDiagnostics,
	toolResult,
} from "./format.ts";
import { LspDiagnosticsParameters, type LspDiagnosticsInput } from "./schemas.ts";
import type { ToolSession } from "./session.ts";

export interface LspDiagnosticsToolDeps {
	/** Read the current session state. Never capture the result. */
	getSession(): ToolSession;
}

const DESCRIPTION = [
	"Report compiler and language-server diagnostics (errors, warnings, hints) for a",
	"file, or for every open document.",
	"",
	"By default this waits for a short quiet window so results reflect the file as it",
	"is on disk now, not the previous revision. Set `waitForFresh` false to read the",
	"cached snapshot immediately.",
].join(" ");

export function createLspDiagnosticsTool(deps: LspDiagnosticsToolDeps) {
	return defineTool<typeof LspDiagnosticsParameters, LspEnvelope>({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: DESCRIPTION,
		promptSnippet: "Type errors and warnings from a language server for a file or workspace",
		promptGuidelines: [
			"After editing a file, call `lsp_diagnostics` on it to confirm the change compiles before moving on.",
			"Use `lsp_diagnostics` with `scope` \"workspace\" to find breakage caused by a signature change.",
		],
		parameters: LspDiagnosticsParameters,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<LspEnvelope>> {
			const session = deps.getSession();

			if (session.service === undefined) {
				return toolResult(
					createEnvelope("lsp_diagnostics", "disabled", {
						hints: ["Remove --lsp-disable to give this session language servers."],
					}),
					ctx.cwd,
					NARROW_DIAGNOSTICS_HINT,
				);
			}

			const scope = params.scope ?? "file";
			if (scope !== "workspace" && (params.path === undefined || params.path.length === 0)) {
				return toolResult(
					createEnvelope("lsp_diagnostics", "bad_input", {
						errors: ['`path` is required unless `scope` is "workspace".'],
						hints: ['Pass `path`, or set `scope: "workspace"`.'],
					}),
					ctx.cwd,
					NARROW_DIAGNOSTICS_HINT,
				);
			}

			const minimum = params.severity ?? "hint";
			const envelope =
				scope === "workspace"
					? await workspaceEnvelope(session.service, params, minimum, session.maxResults)
					: await fileEnvelope(session.service, params, minimum, session.maxResults, signal, ctx.cwd);

			return toolResult(envelope, ctx.cwd, NARROW_DIAGNOSTICS_HINT);
		},
	});
}

/** Diagnostics for one file, waiting for a quiet window unless told not to. */
async function fileEnvelope(
	service: LSPService,
	params: LspDiagnosticsInput,
	minimum: LspDiagnostic["severity"],
	defaultMaxResults: number,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<LspEnvelope> {
	const path = resolvePath(cwd, params.path ?? "");
	const fresh = params.waitForFresh !== false;
	const notes: string[] = [];
	let raw: readonly Diagnostic[];
	let servers: string[] = [];

	try {
		if (fresh) {
			// `describe` names the server even when the wait below fails, and
			// reports a missing binary before anything is spawned.
			servers = [(await service.describe(path)).serverId];
			raw = await service.diagnosticsFor(path, { timeoutMs: params.timeoutMs, signal });
		} else {
			// Must not spawn: `diagnosticsFor` opens the file and starts the
			// server, which is exactly what the caller asked to avoid.
			raw = service.cachedDiagnostics(path);
		}
	} catch (error) {
		return failureEnvelope(error);
	}

	if (raw.length === 0) {
		notes.push(
			fresh
				? "No diagnostics were published for this file within the timeout; the server may still be analysing."
				: "Read from the cached snapshot without syncing the file; retry without `waitForFresh: false` to open it and wait for fresh results.",
		);
	}

	return diagnosticsEnvelope(
		diagnosticResults(raw, path),
		minimum,
		params.maxResults ?? defaultMaxResults,
		notes,
		servers,
	);
}

/** Diagnostics for every document opened in this session. */
async function workspaceEnvelope(
	service: LSPService,
	params: LspDiagnosticsInput,
	minimum: LspDiagnostic["severity"],
	defaultMaxResults: number,
): Promise<LspEnvelope> {
	const notes: string[] = [];
	const all: LspDiagnostic[] = [];

	try {
		const byPath = await service.allDiagnostics();
		for (const [path, diagnostics] of byPath) all.push(...diagnosticResults(diagnostics, path));
		if (byPath.size === 0) {
			notes.push(
				"Workspace scope only reports documents already opened in this session. Query a specific file with `path` to open it.",
			);
		}
	} catch (error) {
		return failureEnvelope(error);
	}

	// No `servers`: a workspace sweep can span several of them.
	return diagnosticsEnvelope(all, minimum, params.maxResults ?? defaultMaxResults, notes);
}

/** Filter, sort, cap, and package a diagnostic list. */
function diagnosticsEnvelope(
	all: readonly LspDiagnostic[],
	minimum: LspDiagnostic["severity"],
	maxResults: number,
	notes: string[],
	servers: readonly string[] = [],
): LspEnvelope {
	const kept = filterDiagnostics(all, minimum);
	const capped = capResults(sortDiagnostics(kept), maxResults);

	if (capped.truncated) {
		notes.push(
			`Showing ${capped.items.length} of ${capped.total} diagnostics; narrow by \`path\` or raise \`maxResults\`.`,
		);
	}
	if (all.length > 0 && kept.length === 0) {
		notes.push(`Filtered out ${all.length} diagnostic(s) below severity '${minimum}'.`);
	}

	return createEnvelope("lsp_diagnostics", capped.items.length > 0 ? "success" : "empty", {
		resultCount: capped.items.length,
		diagnostics: capped.items,
		...(servers.length > 0 ? { servers: [...servers] } : {}),
		...(notes.length > 0 ? { notes } : {}),
	});
}

/** Map a thrown error onto a failure envelope. */
function failureEnvelope(error: unknown): LspEnvelope {
	if (isLSPServiceError(error)) {
		return createEnvelope("lsp_diagnostics", error.status, {
			errors: [error.message],
			...(error.hints.length > 0 ? { hints: [...error.hints] } : {}),
		});
	}

	const message = error instanceof Error ? error.message : String(error);
	return createEnvelope("lsp_diagnostics", "error", { errors: [message] });
}
