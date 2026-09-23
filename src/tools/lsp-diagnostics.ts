/**
 * The `lsp_diagnostics` tool.
 *
 * Kept separate from `lsp` because it answers a different question with a
 * different lifecycle: "is this code correct right now?" rather than "where is
 * this symbol?". It is also the tool that most benefits from waiting for a
 * quiet window, since it is normally called immediately after an edit.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { LSPService } from "../core/service.ts";
import type { LspEnvelope } from "../types.ts";
import type { Logger } from "../util/logger.ts";
import { LspDiagnosticsParameters } from "./schemas.ts";

export interface LspDiagnosticsToolDeps {
	/** Resolve the LSP service for a working directory, or `undefined` when disabled. */
	getService(cwd: string): LSPService | undefined;
	logger: Logger;
	/** Default wait for fresh results, in milliseconds. */
	defaultTimeoutMs?: number;
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
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<LspEnvelope>> {
			throw new Error("Not implemented: lsp_diagnostics tool execute");
		},
	});
}
