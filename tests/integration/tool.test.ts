/**
 * The tool surface against a real engine.
 *
 * Two fixtures, deliberately:
 *  - `fake-lsp-server.mjs` (spawned) proves the whole stack — process, framing,
 *    handshake, operation, render — and that no PID survives it.
 *  - `fake-lsp-streams.ts` (in-process) covers what the spawned fake cannot
 *    answer: `documentSymbol`, arbitrary-sized result sets, and observing that
 *    nothing is spawned until the first tool call.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLSPService, type LSPService } from "../../src/core/service.ts";
import { NARROW_RESULTS_HINT, RESULT_MAX_LINES } from "../../src/tools/format.ts";
import {
	createLspDiagnosticsTool,
	type LspDiagnosticsToolDeps,
} from "../../src/tools/lsp-diagnostics.ts";
import { createLspTool, type LspToolDeps } from "../../src/tools/lsp.ts";
import type { LspToolInput } from "../../src/tools/schemas.ts";
import type { LspEnvelope, LspServerSpec } from "../../src/types.ts";
import { DEFAULT_MAX_RESULTS } from "../../src/util/defaults.ts";
import type { Logger } from "../../src/util/logger.ts";
import { createFakeSpawn, type FakeSpawn } from "../fixtures/fake-lsp-streams.ts";

const FAKE_SERVER = fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), "pi-lsp-m3-"));
const ROOT = join(BASE, "project");
const FILE = join(ROOT, "source.ts");
const TARGET = join(ROOT, "target.ts");

const SILENT: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

/** Every pid the fleet ever spawned, so the sweep below can prove none survives. */
const spawnedPids = new Set<number>();
const openServices: LSPService[] = [];

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });
	writeFileSync(join(ROOT, "tsconfig.json"), "{}");
	writeFileSync(FILE, "import { x } from './target';\n");
	writeFileSync(TARGET, "export const x = 1;\n");
});

afterAll(async () => {
	for (const service of openServices) {
		await service.shutdown().catch(() => {});
		recordPids(service);
	}
	const alive = [...spawnedPids].filter(isAlive);
	for (const pid of alive) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	rmSync(BASE, { recursive: true, force: true });
	expect(alive).toEqual([]);
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function recordPids(service: LSPService): void {
	for (const entry of service.status()) {
		if (entry.pid !== undefined) spawnedPids.add(entry.pid);
	}
}

function specFor(extraArgs: readonly string[] = [], cmd?: string[]): LspServerSpec {
	return {
		id: "fake",
		cmd: cmd ?? [process.execPath, FAKE_SERVER, ...extraArgs],
		filetypes: ["typescript"],
		rootMarkers: ["tsconfig.json"],
		singleFileSupport: false,
	};
}

function createService(spec: LspServerSpec, spawn?: FakeSpawn["spawn"]): LSPService {
	const service = createLSPService({
		servers: new Map([["fake", spec]]),
		cwd: ROOT,
		languageIds: new Map([[".ts", "typescript"]]),
		logger: SILENT,
		...(spawn === undefined ? {} : { spawn }),
	});
	openServices.push(service);
	return service;
}

function context(): ExtensionContext {
	return { cwd: ROOT } as unknown as ExtensionContext;
}

function depsFor(service: LSPService): LspToolDeps & LspDiagnosticsToolDeps {
	return { getSession: () => ({ service, logger: SILENT, maxResults: DEFAULT_MAX_RESULTS }) };
}

async function runLsp(
	service: LSPService,
	params: LspToolInput,
): Promise<AgentToolResult<LspEnvelope>> {
	return createLspTool(depsFor(service)).execute("call-1", params, undefined, undefined, context());
}

async function runDiagnostics(
	service: LSPService,
	params: Parameters<ReturnType<typeof createLspDiagnosticsTool>["execute"]>[1],
): Promise<AgentToolResult<LspEnvelope>> {
	return createLspDiagnosticsTool(depsFor(service)).execute(
		"call-1",
		params,
		undefined,
		undefined,
		context(),
	);
}

function textOf(result: AgentToolResult<LspEnvelope>): string {
	const first = result.content[0];
	if (first === undefined || first.type !== "text") throw new Error("expected text content");
	return first.text;
}

describe("lsp tool against a spawned fake server", () => {
	it("answers a definition with path:line:character and a success envelope", async () => {
		const service = createService(specFor([`--definition=${TARGET}:3:4`]));

		const result = await runLsp(service, {
			operation: "definition",
			path: "source.ts",
			line: 1,
			character: 1,
		});
		recordPids(service);

		expect(textOf(result)).toBe("1 location.\ntarget.ts:4:5");
		expect(result.details.status).toBe("success");
		expect(result.details.resultCount).toBe(1);
		expect(result.details.servers).toEqual(["fake"]);
		expect(result.details.locations?.[0]).toMatchObject({ path: TARGET, line: 4, character: 5 });
	});

	it("reports a missing binary instead of hanging or crashing", async () => {
		const service = createService(
			specFor([], ["pi-lspconfig-definitely-not-on-path", "--stdio"]),
		);

		const result = await runLsp(service, {
			operation: "definition",
			path: "source.ts",
			line: 1,
			character: 1,
		});

		expect(result.details.status).toBe("binary_missing");
		expect(textOf(result)).toContain("fake");
		expect(textOf(result)).toContain("Install it, or override 'cmd'");
		// The failure is recorded without ever spawning a process.
		expect(service.status()[0]).toMatchObject({ state: "failed", pid: undefined });
	});
});

describe("lsp_diagnostics against a spawned fake server", () => {
	it("reports the published diagnostic for a file", async () => {
		const service = createService(specFor(["--diagnostics-on-open"]));

		const result = await runDiagnostics(service, { path: "source.ts" });
		recordPids(service);

		expect(result.details.status).toBe("success");
		expect(result.details.servers).toEqual(["fake"]);
		expect(result.details.diagnostics).toEqual([
			{
				path: FILE,
				line: 1,
				character: 1,
				severity: "error",
				message: "fake diagnostic",
				code: "fake-error",
				source: "fake-lsp",
			},
		]);
		expect(textOf(result)).toBe("1 diagnostic.\nsource.ts\n  1:1: error: fake diagnostic [fake-lsp fake-error]");
	});

	it("reports the same diagnostic for a workspace sweep once the file is open", async () => {
		const service = createService(specFor(["--diagnostics-on-open"]));

		await runDiagnostics(service, { path: "source.ts" });
		const result = await runDiagnostics(service, { scope: "workspace" });
		recordPids(service);

		expect(result.details.status).toBe("success");
		expect(result.details.diagnostics?.[0]?.message).toBe("fake diagnostic");
		expect(textOf(result)).toContain("source.ts");
	});
});

describe("lsp tool against the in-process fake", () => {
	it("resolves `symbol` + `occurrence` to the same result as an explicit position", async () => {
		const fake = createFakeSpawn({
			handlers: {
				"textDocument/documentSymbol": () => [
					{ name: "foo", kind: 12, range: zero(0, 0), selectionRange: zero(0, 0) },
					{ name: "foo", kind: 12, range: zero(9, 2), selectionRange: zero(9, 2) },
				],
				// Echo the position the engine asked for, so the assertion
				// compares requests rather than a canned constant.
				"textDocument/definition": (params: unknown) => {
					const { position } = params as { position: { line: number; character: number } };
					return {
						uri: pathToFileURL(FILE).href,
						range: {
							start: position,
							end: { line: position.line, character: position.character + 1 },
						},
					};
				},
			},
		});
		const service = createService(specFor(), fake.spawn);

		const bySymbol = await runLsp(service, {
			operation: "definition",
			path: "source.ts",
			symbol: "foo",
			occurrence: 2,
		});
		const byPosition = await runLsp(service, {
			operation: "definition",
			path: "source.ts",
			line: 10,
			character: 3,
		});

		expect(textOf(bySymbol)).toBe("1 location.\nsource.ts:10:3");
		expect(textOf(bySymbol)).toBe(textOf(byPosition));
		expect(bySymbol.details.locations).toEqual(byPosition.details.locations);
	});

	it("truncates a 5,000-location result and says how to narrow it", async () => {
		const fake = createFakeSpawn({
			handlers: {
				"textDocument/definition": () =>
					Array.from({ length: 5000 }, (_, index) => ({
						uri: pathToFileURL(TARGET).href,
						range: {
							start: { line: index, character: 0 },
							end: { line: index, character: 1 },
						},
					})),
			},
		});
		const service = createService(specFor(), fake.spawn);

		const result = await runLsp(service, {
			operation: "definition",
			path: "source.ts",
			line: 1,
			character: 1,
			maxResults: 5000,
		});

		expect(result.details.resultCount).toBe(5000);
		expect(textOf(result)).toContain("target.ts:1:1");
		expect(textOf(result)).toContain(NARROW_RESULTS_HINT);
		expect(textOf(result)).not.toContain("target.ts:5000:1");
		expect(textOf(result).split("\n")).toHaveLength(RESULT_MAX_LINES + 2);
		expect(result.details.hints).toContain(NARROW_RESULTS_HINT);
	});

	it("spawns nothing until the first tool call", async () => {
		const fake = createFakeSpawn();
		const service = createService(specFor(), fake.spawn);

		expect(fake.spawned).toEqual([]);
		expect(service.status()).toEqual([]);

		const result = await runLsp(service, {
			operation: "definition",
			path: "source.ts",
			line: 1,
			character: 1,
		});

		expect(fake.spawned).toHaveLength(1);
		expect(result.details.status).toBe("empty");
	});
});

/** A zero-width 0-based range, the shape servers send on the wire. */
function zero(line: number, character: number) {
	return { start: { line, character }, end: { line, character } };
}
