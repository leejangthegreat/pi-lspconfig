/**
 * Opt-in auto-install, end to end through the fleet.
 *
 * The install runner is injected and "installs" by creating an executable in a
 * temp bin directory that is prepended to `PATH` — the same contract
 * `resolveCommand` gives a real installer. The LSP process itself is the
 * in-process fake, so nothing is spawned.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { executeOperation } from "../../../src/core/operations.ts";
import { createLSPService, type LSPServiceOptions } from "../../../src/core/service.ts";
import type { InstallOutcome, InstallSpec } from "../../../src/core/install.ts";
import type { LspServerSpec } from "../../../src/types.ts";
import type { Logger } from "../../../src/util/logger.ts";
import { createFakeSpawn } from "../../fixtures/fake-lsp-streams.ts";

const SILENT: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const BASE = mkdtempSync(join(tmpdir(), "pi-lsp-autoininstall-"));
const ROOT_A = join(BASE, "a");
const ROOT_B = join(BASE, "b");
const BIN_DIR = join(BASE, "bin");
const BIN = join(BIN_DIR, "pi-lspconfig-fake-installable");
const FILE_A = join(ROOT_A, "x.ts");
const FILE_B = join(ROOT_B, "y.ts");
const ORIGINAL_PATH = process.env.PATH;

beforeAll(() => {
	for (const dir of [ROOT_A, ROOT_B, BIN_DIR]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(ROOT_A, "tsconfig.json"), "{}");
	writeFileSync(join(ROOT_B, "tsconfig.json"), "{}");
	writeFileSync(FILE_A, "export const x = 1;\n");
	writeFileSync(FILE_B, "export const y = 2;\n");
	process.env.PATH = `${BIN_DIR}${delimiter}${ORIGINAL_PATH ?? ""}`;
});

afterAll(() => {
	process.env.PATH = ORIGINAL_PATH;
	rmSync(BASE, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(BIN, { force: true });
});

interface InstallLog {
	calls: InstallSpec[];
}

/** A runner that "installs" by making the binary executable. */
function fakeRunner(log: InstallLog, outcome?: Partial<InstallOutcome>) {
	return async (spec: InstallSpec): Promise<InstallOutcome> => {
		log.calls.push(spec);
		if (outcome?.ok !== false) {
			writeFileSync(BIN, "#!/bin/sh\nexit 0\n");
			chmodSync(BIN, 0o755);
		}
		return { ok: true, exitCode: 0, output: "installed", ...outcome };
	};
}

function spec(overrides: Partial<LspServerSpec> = {}): LspServerSpec {
	return {
		id: "fake",
		cmd: [BIN, "--stdio"],
		filetypes: ["typescript"],
		rootMarkers: ["tsconfig.json"],
		installCommand: "fake install",
		...overrides,
	};
}

function options(server: LspServerSpec, overrides: Partial<LSPServiceOptions> = {}): LSPServiceOptions {
	return {
		servers: new Map([[server.id, server]]),
		cwd: BASE,
		languageIds: new Map([[".ts", "typescript"]]),
		logger: SILENT,
		...overrides,
	};
}

async function definitionFor(service: Parameters<typeof executeOperation>[0], path: string) {
	return executeOperation(
		service,
		{ operation: "definition", path, line: 1, character: 1 },
		{ cwd: BASE, maxResults: 100, logger: SILENT },
	);
}

describe("auto-install", () => {
	it("installs once and retries the launch", async () => {
		const fake = createFakeSpawn();
		const log: InstallLog = { calls: [] };
		const service = createLSPService(
			options(spec({ autoInstall: true }), { spawn: fake.spawn, installRunner: fakeRunner(log) }),
		);

		try {
			const envelope = await definitionFor(service, FILE_A);

			expect(log.calls).toHaveLength(1);
			expect(log.calls[0]?.command).toBe("fake install");
			expect(fake.spawned).toHaveLength(1);
			expect(service.status()[0]?.state).toBe("ready");
			expect(envelope.status).not.toBe("binary_missing");
		} finally {
			await service.shutdown();
		}
	});

	it("shares one attempt across roots and across calls", async () => {
		const fake = createFakeSpawn();
		const log: InstallLog = { calls: [] };
		const service = createLSPService(
			options(spec({ autoInstall: true }), { spawn: fake.spawn, installRunner: fakeRunner(log) }),
		);

		try {
			await definitionFor(service, FILE_A);
			await definitionFor(service, FILE_A);
			await definitionFor(service, FILE_B);

			expect(log.calls).toHaveLength(1);
		} finally {
			await service.shutdown();
		}
	});

	it("never installs without autoInstall", async () => {
		const fake = createFakeSpawn();
		const log: InstallLog = { calls: [] };
		const service = createLSPService(
			options(spec(), { spawn: fake.spawn, installRunner: fakeRunner(log) }),
		);

		try {
			const envelope = await definitionFor(service, FILE_A);

			expect(log.calls).toHaveLength(0);
			expect(fake.spawned).toEqual([]);
			expect(envelope.status).toBe("binary_missing");
		} finally {
			await service.shutdown();
		}
	});

	it("reports the installer's last line when the install fails", async () => {
		const fake = createFakeSpawn();
		const log: InstallLog = { calls: [] };
		const service = createLSPService(
			options(spec({ autoInstall: true }), {
				spawn: fake.spawn,
				installRunner: fakeRunner(log, {
					ok: false,
					exitCode: 1,
					output: "npm ERR! 404\nnpm ERR! not found\n",
				}),
			}),
		);

		try {
			const envelope = await definitionFor(service, FILE_A);

			expect(envelope.status).toBe("binary_missing");
			expect(envelope.servers).toEqual(["fake"]);
			expect(envelope.notes).toEqual(["Automatic install exited 1: npm ERR! not found"]);
			expect(envelope.hints).toContain("Install it with: fake install");

			// A second call reports the same failure without re-running install.
			await definitionFor(service, FILE_A);
			expect(log.calls).toHaveLength(1);
		} finally {
			await service.shutdown();
		}
	});
});
