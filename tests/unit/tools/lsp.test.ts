import { describe, expect, it } from "vitest";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LSPServiceError, type LSPService } from "../../../src/core/service.ts";
import type { LspEnvelope } from "../../../src/types.ts";
import { createLspTool, type LspToolDeps } from "../../../src/tools/lsp.ts";
import type { LspToolInput } from "../../../src/tools/schemas.ts";
import { createServiceStub, SILENT_LOGGER } from "./service-stub.ts";

/** A zero-width 0-based range, the shape servers send on the wire. */
function zero(line: number, character: number) {
	return { start: { line, character }, end: { line, character } };
}

function context(cwd = "/repo"): ExtensionContext {
	// The tool reads only `cwd` from the context.
	return { cwd } as unknown as ExtensionContext;
}

function depsFor(service: LSPService | undefined, maxResults = 100): LspToolDeps {
	return { getSession: () => ({ service, logger: SILENT_LOGGER, maxResults }) };
}

async function run(
	params: LspToolInput,
	deps: LspToolDeps,
	cwd = "/repo",
): Promise<AgentToolResult<LspEnvelope>> {
	const tool = createLspTool(deps);
	return tool.execute("call-1", params, undefined, undefined, context(cwd));
}

function textOf(result: AgentToolResult<LspEnvelope>): string {
	const first = result.content[0];
	if (first === undefined || first.type !== "text") throw new Error("expected text content");
	return first.text;
}

describe("lsp tool", () => {
	it("reports disabled when no service is bound", async () => {
		const result = await run(
			{ operation: "definition", path: "src/a.ts", line: 1, character: 1 },
			depsFor(undefined),
		);

		expect(result.details.status).toBe("disabled");
		expect(result.details.ok).toBe(false);
		expect(textOf(result)).toContain("disabled");
	});

	it("renders a definition as path:line:character with a success envelope", async () => {
		const stub = createServiceStub({
			responses: {
				"textDocument/definition": {
					uri: "file:///repo/src/a.ts",
					range: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } },
				},
			},
		});

		const result = await run(
			{ operation: "definition", path: "src/a.ts", line: 1, character: 1 },
			depsFor(stub.service),
		);

		expect(textOf(result)).toBe("1 location.\nsrc/a.ts:10:3");
		expect(result.details.status).toBe("success");
		expect(result.details.resultCount).toBe(1);
		expect(result.details.locations?.[0]).toMatchObject({
			path: "/repo/src/a.ts",
			line: 10,
			character: 3,
		});
	});

	it("resolves `symbol` + `occurrence` to the same result as an explicit position", async () => {
		const stub = createServiceStub({
			responses: {
				"textDocument/documentSymbol": [
					{ name: "foo", kind: 12, range: zero(0, 0), selectionRange: zero(0, 0) },
					{ name: "foo", kind: 12, range: zero(9, 2), selectionRange: zero(9, 2) },
				],
				// Echo the requested position, so the assertion compares what the
				// engine asked for rather than a canned constant.
				"textDocument/definition": (params: unknown) => {
					const { position } = params as { position: { line: number; character: number } };
					return {
						uri: "file:///repo/src/a.ts",
						range: { start: position, end: { line: position.line, character: position.character + 1 } },
					};
				},
			},
		});

		const bySymbol = await run(
			{ operation: "definition", path: "src/a.ts", symbol: "foo", occurrence: 2 },
			depsFor(stub.service),
		);
		const byPosition = await run(
			{ operation: "definition", path: "src/a.ts", line: 10, character: 3 },
			depsFor(stub.service),
		);

		expect(textOf(bySymbol)).toBe("1 location.\nsrc/a.ts:10:3");
		expect(textOf(bySymbol)).toBe(textOf(byPosition));
		expect(bySymbol.details.locations).toEqual(byPosition.details.locations);
	});

	it("returns bad_input for a missing position rather than throwing", async () => {
		const stub = createServiceStub();

		const result = await run({ operation: "definition", path: "src/a.ts" }, depsFor(stub.service));

		expect(result.details.status).toBe("bad_input");
		expect(result.details.errors?.[0]).toContain("requires a position");
		expect(stub.calls).toEqual([]);
	});

	it("caps results at the session maxResults", async () => {
		const stub = createServiceStub({
			responses: {
				"textDocument/definition": [0, 1, 2, 3, 4].map((index) => ({
					uri: "file:///repo/src/a.ts",
					range: zero(index, 0),
				})),
			},
		});

		const result = await run(
			{ operation: "definition", path: "src/a.ts", line: 1, character: 1 },
			depsFor(stub.service, 2),
		);

		expect(result.details.resultCount).toBe(2);
		expect(result.details.notes?.join(" ")).toContain("narrow the query");
	});

	it("tells the model to pass the call-hierarchy item back", async () => {
		const node = {
			name: "f",
			kind: 12,
			uri: "file:///repo/src/a.ts",
			range: zero(2, 0),
			selectionRange: zero(2, 0),
		};
		const stub = createServiceStub({
			responses: { "textDocument/prepareCallHierarchy": [node] },
		});

		const result = await run(
			{ operation: "prepareCallHierarchy", path: "src/a.ts", line: 1, character: 1 },
			depsFor(stub.service),
		);

		expect(result.details.payload?.kind).toBe("callHierarchy");
		expect(textOf(result)).toContain(`item: ${JSON.stringify(node)}`);
		expect(result.details.hints?.join(" ")).toContain("callHierarchyItem");
	});

	it("maps a service failure onto the envelope status", async () => {
		const stub = createServiceStub({
			describeError: new LSPServiceError("no_server", "nothing handles .ts here", ["Add a server."]),
		});

		const result = await run(
			{ operation: "definition", path: "src/a.ts", line: 1, character: 1 },
			depsFor(stub.service),
		);

		expect(result.details.status).toBe("no_server");
		expect(result.details.errors).toEqual(["nothing handles .ts here"]);
		expect(textOf(result)).toContain("Add a server.");
	});

	it("carries a details envelope on every path", async () => {
		const stub = createServiceStub({
			describeError: new LSPServiceError("no_server", "nothing handles it"),
		});
		const cases: LspToolInput[] = [
			{ operation: "definition", path: "src/a.ts", line: 1, character: 1 },
			{ operation: "definition", path: "src/a.ts" },
			{ operation: "workspaceSymbol", query: "foo" },
			{ operation: "status" },
		];

		for (const params of cases) {
			const result = await run(params, depsFor(stub.service));
			expect(result.details).toBeDefined();
			expect(result.details.operation).toBe(params.operation);
			expect(textOf(result).length).toBeGreaterThan(0);
		}

		const disabled = await run(cases[0] as LspToolInput, depsFor(undefined));
		expect(disabled.details.status).toBe("disabled");
	});
});
