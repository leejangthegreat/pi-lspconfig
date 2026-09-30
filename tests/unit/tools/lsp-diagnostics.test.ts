import { describe, expect, it } from "vitest";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LSPServiceError, type LSPService } from "../../../src/core/service.ts";
import type { Diagnostic } from "../../../src/protocol.ts";
import type { LspEnvelope } from "../../../src/types.ts";
import {
	createLspDiagnosticsTool,
	type LspDiagnosticsToolDeps,
} from "../../../src/tools/lsp-diagnostics.ts";
import type { LspDiagnosticsInput } from "../../../src/tools/schemas.ts";
import { createServiceStub, SILENT_LOGGER } from "./service-stub.ts";

/** A wire diagnostic with a 0-based range. */
function wire(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1,
		message: "boom",
		...overrides,
	};
}

function context(cwd = "/repo"): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

function depsFor(service: LSPService | undefined, maxResults = 100): LspDiagnosticsToolDeps {
	return { getSession: () => ({ service, logger: SILENT_LOGGER, maxResults }) };
}

async function run(
	params: LspDiagnosticsInput,
	deps: LspDiagnosticsToolDeps,
	cwd = "/repo",
): Promise<AgentToolResult<LspEnvelope>> {
	const tool = createLspDiagnosticsTool(deps);
	return tool.execute("call-1", params, undefined, undefined, context(cwd));
}

function textOf(result: AgentToolResult<LspEnvelope>): string {
	const first = result.content[0];
	if (first === undefined || first.type !== "text") throw new Error("expected text content");
	return first.text;
}

describe("lsp_diagnostics tool", () => {
	it("reports disabled when no service is bound", async () => {
		const result = await run({ path: "src/a.ts" }, depsFor(undefined));

		expect(result.details.status).toBe("disabled");
		expect(textOf(result)).toContain("disabled");
	});

	it("requires a path unless the scope is workspace", async () => {
		const stub = createServiceStub();

		const result = await run({}, depsFor(stub.service));

		expect(result.details.status).toBe("bad_input");
		expect(result.details.errors).toEqual(['`path` is required unless `scope` is "workspace".']);
		expect(stub.described).toEqual([]);
	});

	it("returns file diagnostics, errors first, resolved against the cwd", async () => {
		const stub = createServiceStub({
			diagnostics: [
				wire({ range: { start: { line: 4, character: 1 }, end: { line: 4, character: 2 } }, severity: 2, message: "unused" }),
				wire({ message: "boom", source: "ts", code: 2322 }),
			],
		});

		const result = await run({ path: "src/a.ts" }, depsFor(stub.service));

		expect(stub.described).toEqual(["/repo/src/a.ts"]);
		expect(stub.diagnosed).toEqual(["/repo/src/a.ts"]);
		expect(result.details.status).toBe("success");
		expect(result.details.servers).toEqual(["fake"]);
		expect(result.details.diagnostics?.map((d) => d.severity)).toEqual(["error", "warning"]);
		expect(textOf(result)).toBe(
			[
				"2 diagnostics.",
				"src/a.ts",
				"  1:1: error: boom [ts 2322]",
				"  5:2: warning: unused",
			].join("\n"),
		);
	});

	it("notes that a waited, empty result may still be analysing", async () => {
		const stub = createServiceStub();

		const result = await run({ path: "src/a.ts" }, depsFor(stub.service));

		expect(result.details.status).toBe("empty");
		expect(textOf(result)).toContain("No diagnostics.");
		expect(result.details.notes?.join(" ")).toContain("may still be analysing");
	});

	it("reads the cached snapshot without spawning when waitForFresh is false", async () => {
		const stub = createServiceStub({ cached: [wire()] });

		const result = await run({ path: "src/a.ts", waitForFresh: false }, depsFor(stub.service));

		expect(result.details.status).toBe("success");
		expect(result.details.diagnostics).toHaveLength(1);
		// Neither `describe` nor `diagnosticsFor` may run: both would start a server.
		expect(stub.described).toEqual([]);
		expect(stub.diagnosed).toEqual([]);
	});

	it("notes the ambiguity of an empty cached snapshot", async () => {
		const stub = createServiceStub();

		const result = await run({ path: "src/a.ts", waitForFresh: false }, depsFor(stub.service));

		expect(result.details.notes?.join(" ")).toContain("cached snapshot");
	});

	it("groups workspace diagnostics by file without spawning", async () => {
		const stub = createServiceStub({
			allDiagnostics: new Map([
				["/repo/src/b.ts", [wire({ message: "b" })]],
				["/repo/src/a.ts", [wire({ message: "a" })]],
			]),
		});

		const result = await run({ scope: "workspace" }, depsFor(stub.service));

		expect(result.details.status).toBe("success");
		expect(result.details.servers).toBeUndefined();
		expect(stub.described).toEqual([]);
		expect(stub.diagnosed).toEqual([]);
		expect(textOf(result)).toBe(
			["2 diagnostics.", "src/a.ts", "  1:1: error: a", "src/b.ts", "  1:1: error: b"].join("\n"),
		);
	});

	it("says that an empty workspace sweep only covers open documents", async () => {
		const stub = createServiceStub();

		const result = await run({ scope: "workspace" }, depsFor(stub.service));

		expect(result.details.status).toBe("empty");
		expect(result.details.notes?.join(" ")).toContain("already opened in this session");
	});

	it("reports what a severity filter removed", async () => {
		const stub = createServiceStub({
			diagnostics: [wire({ severity: 2 }), wire({ severity: 3 })],
		});

		const result = await run({ path: "src/a.ts", severity: "error" }, depsFor(stub.service));

		expect(result.details.status).toBe("empty");
		expect(result.details.diagnostics).toEqual([]);
		expect(result.details.notes?.join(" ")).toContain("Filtered out 2 diagnostic(s)");
	});

	it("caps the list and says how many were dropped", async () => {
		const stub = createServiceStub({
			diagnostics: [wire({ message: "a" }), wire({ message: "b" }), wire({ message: "c" })],
		});

		const result = await run({ path: "src/a.ts", maxResults: 2 }, depsFor(stub.service));

		expect(result.details.resultCount).toBe(2);
		expect(result.details.notes?.join(" ")).toContain("Showing 2 of 3");
	});

	it("maps a service failure onto the envelope status", async () => {
		const stub = createServiceStub({
			describeError: new LSPServiceError("binary_missing", "fake: command 'nope' was not found on PATH.", [
				"Install it, or override 'cmd' for 'fake' in pi-lspconfig.config.ts.",
			]),
		});

		const result = await run({ path: "src/a.ts" }, depsFor(stub.service));

		expect(result.details.status).toBe("binary_missing");
		expect(textOf(result)).toContain("Install it");
	});

	it("maps an unexpected throw onto an error envelope", async () => {
		const stub = createServiceStub({ diagnosticsError: new Error("store exploded") });

		const result = await run({ path: "src/a.ts" }, depsFor(stub.service));

		expect(result.details.status).toBe("error");
		expect(result.details.errors).toEqual(["store exploded"]);
	});
});
