/**
 * Smoke tests against real language servers.
 *
 * Everything here is gated behind `PI_LSP_REAL=1`: the suite must be skipped,
 * not failed, on a machine without toolchains. Each case also skips
 * individually when its binary is absent, and the CI-only guard at the bottom
 * makes sure a green CI run cannot come from four silent skips.
 *
 * The fixtures are tiny projects under `tests/fixtures/real/`, each with its
 * own root marker so root detection lands inside the fixture rather than on
 * the repository's `.git`. Real servers are asynchronous — definition can come
 * back empty while indexing, diagnostics arrive in batches — so every
 * assertion polls until a deadline instead of racing the server.
 */

import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../../src/config/resolve.ts";
import { resolveCommand } from "../../src/core/client/launch.ts";
import { createLSPService, type LSPService } from "../../src/core/service.ts";
import { BUILTIN_SERVERS, BUILTIN_SERVERS_BY_ID } from "../../src/languages/index.ts";
import {
	createLspDiagnosticsTool,
	type LspDiagnosticsToolDeps,
} from "../../src/tools/lsp-diagnostics.ts";
import { createLspTool, type LspToolDeps } from "../../src/tools/lsp.ts";
import type { LspDiagnosticsInput, LspToolInput } from "../../src/tools/schemas.ts";
import type { LspEnvelope } from "../../src/types.ts";
import { DEFAULT_MAX_RESULTS } from "../../src/util/defaults.ts";
import type { Logger } from "../../src/util/logger.ts";

const REAL = process.env.PI_LSP_REAL === "1";
const FIXTURES = fileURLToPath(new URL("../fixtures/real/", import.meta.url));

const SILENT: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

interface RealCase {
	serverId: string;
	/** Binary that must be on `PATH`, as `resolveCommand` sees it. */
	bin: string;
	definition: {
		path: string;
		/** 1-based position of the reference to resolve. */
		line: number;
		character: number;
		expectPath: string;
		expectLine: number;
	};
	diagnostics: { path: string };
}

const CASES: readonly RealCase[] = [
	{
		serverId: "vtsls",
		bin: "vtsls",
		definition: {
			path: "typescript/src/usage.ts",
			line: 3,
			character: 24,
			expectPath: "typescript/src/greet.ts",
			expectLine: 1,
		},
		diagnostics: { path: "typescript/src/broken.ts" },
	},
	{
		serverId: "pyright",
		bin: "pyright-langserver",
		definition: {
			path: "python/usage.py",
			line: 3,
			character: 17,
			expectPath: "python/greet.py",
			expectLine: 1,
		},
		diagnostics: { path: "python/broken.py" },
	},
	{
		serverId: "rust-analyzer",
		bin: "rust-analyzer",
		definition: {
			path: "rust/src/lib.rs",
			line: 8,
			character: 5,
			expectPath: "rust/src/lib.rs",
			expectLine: 3,
		},
		diagnostics: { path: "rust/src/broken.rs" },
	},
	{
		serverId: "gopls",
		bin: "gopls",
		definition: {
			path: "go/greet.go",
			line: 8,
			character: 12,
			expectPath: "go/greet.go",
			expectLine: 3,
		},
		diagnostics: { path: "go/broken.go" },
	},
];

/**
 * Availability is resolved once, at collection time, because `it.skipIf` needs
 * a boolean before any test runs.
 */
const available = new Map<string, boolean>(
	await Promise.all(
		CASES.map(
			async (testCase) =>
				[testCase.serverId, (await resolveCommand(testCase.bin)) !== undefined] as const,
		),
	),
);

/** Every service this file created, so the sweep below can prove none leaks. */
const openServices: LSPService[] = [];
const spawnedPids = new Set<number>();

let shared: LSPService | undefined;

/** One service for the whole file: real servers are expensive to start. */
function service(): LSPService {
	shared ??= createService();
	return shared;
}

function createService(): LSPService {
	const { servers, languageIds } = resolveConfig({}, BUILTIN_SERVERS);
	const created = createLSPService({
		servers,
		cwd: FIXTURES,
		languageIds,
		logger: SILENT,
		initializeTimeoutMs: 60_000,
	});
	openServices.push(created);
	return created;
}

afterAll(async () => {
	// Capture pids before teardown: `shutdown()` clears the fleet's status.
	for (const open of openServices) recordPids(open);
	for (const open of openServices) await open.shutdown().catch(() => {});
	const alive = [...spawnedPids].filter(isAlive);
	for (const pid of alive) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	expect(alive).toEqual([]);
}, 60_000);

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function recordPids(target: LSPService): void {
	for (const entry of target.status()) {
		if (entry.pid !== undefined) spawnedPids.add(entry.pid);
	}
}

function context(): ExtensionContext {
	return { cwd: FIXTURES } as unknown as ExtensionContext;
}

function depsFor(target: LSPService): LspToolDeps & LspDiagnosticsToolDeps {
	return {
		getSession: () => ({ service: target, logger: SILENT, maxResults: DEFAULT_MAX_RESULTS }),
	};
}

async function runLsp(
	target: LSPService,
	params: LspToolInput,
): Promise<AgentToolResult<LspEnvelope>> {
	return createLspTool(depsFor(target)).execute("call-1", params, undefined, undefined, context());
}

async function runDiagnostics(
	target: LSPService,
	params: LspDiagnosticsInput,
): Promise<AgentToolResult<LspEnvelope>> {
	return createLspDiagnosticsTool(depsFor(target)).execute(
		"call-1",
		params,
		undefined,
		undefined,
		context(),
	);
}

/** Retry `attempt` until `done` holds or the deadline passes. */
async function until<T>(
	attempt: () => Promise<T>,
	done: (value: T) => boolean,
	deadlineMs = 120_000,
): Promise<T> {
	const deadline = Date.now() + deadlineMs;
	let value = await attempt();
	while (!done(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		value = await attempt();
	}
	return value;
}

describe.skipIf(!REAL)("real language servers", () => {
	describe.each(CASES)("$serverId", (testCase) => {
		it.skipIf(!available.get(testCase.serverId))(
			"resolves a definition to the expected file and line",
			async () => {
				const expectPath = join(FIXTURES, testCase.definition.expectPath);
				const result = await until(
					() =>
						runLsp(service(), {
							operation: "definition",
							path: testCase.definition.path,
							line: testCase.definition.line,
							character: testCase.definition.character,
						}),
					// Poll for the expected target, not merely for *a* target: a
					// server answers from a partially loaded project first, and
					// vtsls points at the import until the project is loaded.
					(envelope) =>
						envelope.details.locations?.[0]?.path === expectPath &&
						envelope.details.locations?.[0]?.line === testCase.definition.expectLine,
				);

				expect(result.details.status, JSON.stringify(result.details)).toBe("success");
				expect(result.details.locations?.[0]?.path).toBe(expectPath);
				expect(result.details.locations?.[0]?.line).toBe(testCase.definition.expectLine);
			},
			180_000,
		);

		it.skipIf(!available.get(testCase.serverId))(
			"reports the deliberate type error",
			async () => {
				const result = await until(
					() =>
						runDiagnostics(service(), {
							path: testCase.diagnostics.path,
							severity: "error",
							timeoutMs: 30_000,
						}),
					(envelope) => (envelope.details.diagnostics?.length ?? 0) > 0,
				);

				const errors = (result.details.diagnostics ?? []).filter(
					(diagnostic) => diagnostic.severity === "error",
				);
				expect(errors.length, JSON.stringify(result.details)).toBeGreaterThan(0);
				expect(errors[0]?.path).toBe(join(FIXTURES, testCase.diagnostics.path));
			},
			180_000,
		);
	});

	describe("a missing binary", () => {
		for (const testCase of CASES) {
			it(`is reported as binary_missing with the install command for ${testCase.serverId}`, async () => {
				const spec = BUILTIN_SERVERS_BY_ID.get(testCase.serverId);
				const installCommand = spec?.installCommand ?? "";
				expect(installCommand).not.toBe("");

				// The real spec with its binary replaced: no process is spawned,
				// so this stays fast even though it lives in the gated suite.
				const { servers, languageIds } = resolveConfig(
					{
						servers: {
							[testCase.serverId]: { cmd: [`pi-lspconfig-missing-${testCase.serverId}`] },
						},
					},
					BUILTIN_SERVERS,
				);
				const created = createLSPService({ servers, cwd: FIXTURES, languageIds, logger: SILENT });
				openServices.push(created);

				try {
					const result = await runLsp(created, {
						operation: "definition",
						path: testCase.definition.path,
						line: 1,
						character: 1,
					});

					expect(result.details.status).toBe("binary_missing");
					expect(result.details.hints?.join("\n")).toContain(installCommand);
					expect(created.status()[0]).toMatchObject({ state: "failed", pid: undefined });
				} finally {
					await created.shutdown();
				}
			});
		}
	});

	// CI installs all four toolchains, so a missing one is a broken workflow,
	// not a reason to skip. Locally, per-case skips above stay in charge.
	describe.runIf(process.env.CI === "true")("toolchain presence", () => {
		for (const testCase of CASES) {
			it(`has ${testCase.bin} on PATH`, () => {
				expect(available.get(testCase.serverId), `${testCase.bin} is not installed`).toBe(true);
			});
		}
	});
});
