/**
 * The unified `lsp` tool.
 *
 * One tool rather than eighteen. Every operation shares the same
 * `path`/position/`symbol` inputs and the same envelope output, so the model
 * pays for one description instead of eighteen, and adding an operation costs
 * nothing in context.
 *
 * This module is host-neutral apart from Pi's *pure* helpers (`defineTool`) and
 * type-only imports. It never calls `pi.*`; the extension layer injects an
 * {@link LspToolDeps} resolver instead.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { LSPService } from "../core/service.ts";
import type { LspEnvelope } from "../types.ts";
import type { Logger } from "../util/logger.ts";
import { LspToolParameters } from "./schemas.ts";

export interface LspToolDeps {
	/** Resolve the LSP service for a working directory, or `undefined` when disabled. */
	getService(cwd: string): LSPService | undefined;
	logger: Logger;
	/** Effective result cap. Defaults to `DEFAULT_MAX_RESULTS` from `util/defaults.ts`. */
	maxResults?: number;
}

const DESCRIPTION = [
	"Query a language server for semantic code intelligence: definitions, references,",
	"implementations, hover types, document/workspace symbols, code actions, rename,",
	"and call hierarchies.",
	"",
	"Prefer this over `grep` when you need a symbol's real definition or every true",
	"reference — text search cannot distinguish a declaration from a comment, string,",
	"or an unrelated same-named symbol.",
	"",
	"Positions are 1-based. When you do not know the column, pass `symbol` (plus",
	"`occurrence` if the name repeats) instead of guessing `character`.",
].join(" ");

export function createLspTool(deps: LspToolDeps) {
	return defineTool<typeof LspToolParameters, LspEnvelope>({
		name: "lsp",
		label: "Language Server",
		description: DESCRIPTION,
		promptSnippet:
			"Semantic code navigation via language servers (definitions, references, symbols, rename)",
		promptGuidelines: [
			"Use `lsp` with operation `definition` or `references` before grepping when locating a symbol's real definition or all of its true usages.",
			"When a file and symbol name are known but the column is not, pass `symbol` instead of `character`.",
			"Use `lsp` operation `documentSymbol` to understand a file's structure before reading it in full.",
			"For `rename`, leave `apply` false first and inspect the preview before applying.",
		],
		parameters: LspToolParameters,
		// Mutating operations (rename with apply) are serialised by the dispatcher;
		// read-only queries are safe to run alongside other tool calls.
		executionMode: "parallel",
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<LspEnvelope>> {
			throw new Error("Not implemented: lsp tool execute");
		},
	});
}
