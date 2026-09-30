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
import { executeOperation, isLspOperation, type OperationRequest } from "../core/operations.ts";
import type { CallHierarchyItem } from "../protocol.ts";
import type { LspEnvelope } from "../types.ts";
import { createEnvelope, NARROW_RESULTS_HINT, toolResult } from "./format.ts";
import { LspToolParameters } from "./schemas.ts";
import type { ToolSession } from "./session.ts";

export interface LspToolDeps {
	/** Read the current session state. Never capture the result. */
	getSession(): ToolSession;
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
		// Read-only: `rename` with `apply: true` is refused by the engine, so
		// nothing here mutates the workspace.
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<LspEnvelope>> {
			const session = deps.getSession();
			const operation = params.operation;

			if (session.service === undefined) {
				return toolResult(
					createEnvelope(operation, "disabled", {
						hints: ["Remove --lsp-disable to give this session language servers."],
					}),
					ctx.cwd,
					NARROW_RESULTS_HINT,
				);
			}

			if (!isLspOperation(operation)) {
				return toolResult(
					createEnvelope(operation, "bad_input", {
						errors: [`Unknown operation '${String(operation)}'.`],
					}),
					ctx.cwd,
					NARROW_RESULTS_HINT,
				);
			}

			const request: OperationRequest = {
				...params,
				// The schema types this `unknown` on purpose: the model round-trips
				// an opaque item it got from `prepareCallHierarchy`, and only the
				// server can validate it.
				callHierarchyItem: params.callHierarchyItem as CallHierarchyItem | undefined,
			};

			const envelope = await executeOperation(session.service, request, {
				cwd: ctx.cwd,
				signal,
				maxResults: params.maxResults ?? session.maxResults,
				logger: session.logger,
			});

			if (operation === "prepareCallHierarchy" && envelope.payload?.kind === "callHierarchy") {
				envelope.hints = [
					...(envelope.hints ?? []),
					"Pass one item's `item` field back as `callHierarchyItem` for incoming/outgoing calls.",
				];
			}

			return toolResult(envelope, ctx.cwd, NARROW_RESULTS_HINT);
		},
	});
}
