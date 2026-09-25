import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeOperation } from "../../src/core/operations.ts";
import { createLSPService, type LSPService } from "../../src/core/service.ts";
import type { LspServerSpec } from "../../src/types.ts";
import type { Logger } from "../../src/util/logger.ts";

const FAKE_SERVER = fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), "pi-lsp-m2-"));
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

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });
	writeFileSync(join(ROOT, "tsconfig.json"), "{}");
	writeFileSync(FILE, "import { x } from './target';\n");
	writeFileSync(TARGET, "export const x = 1;\n");
});

afterAll(async () => {
	// Tear the fleet down first, then prove no pid survived, then clean up.
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

async function waitForDead(pid: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

function specFor(extraArgs: readonly string[] = []): LspServerSpec {
	return {
		id: "fake",
		cmd: [process.execPath, FAKE_SERVER, ...extraArgs],
		filetypes: ["typescript"],
		rootMarkers: ["tsconfig.json"],
		singleFileSupport: false,
	};
}

function createService(extraArgs: readonly string[] = []): LSPService {
	return createLSPService({
		servers: new Map([["fake", specFor(extraArgs)]]),
		cwd: ROOT,
		languageIds: new Map([[".ts", "typescript"]]),
		logger: SILENT,
	});
}

/** Record every pid the service reports, so the afterAll sweep covers them. */
function recordPids(service: LSPService): void {
	for (const entry of service.status()) {
		if (entry.pid !== undefined) spawnedPids.add(entry.pid);
	}
}

const openServices: LSPService[] = [];

describe("LSPService against a spawned fake server", () => {
	it("round-trips a definition operation end to end", async () => {
		const service = createService([`--definition=${TARGET}:3:4`]);
		openServices.push(service);

		const envelope = await executeOperation(
			service,
			{ operation: "definition", path: FILE, line: 1, character: 1 },
			{ cwd: ROOT, maxResults: 100, logger: SILENT },
		);
		recordPids(service);

		expect(envelope.status).toBe("success");
		expect(envelope.ok).toBe(true);
		expect(envelope.resultCount).toBe(1);
		expect(envelope.servers).toEqual(["fake"]);
		expect(envelope.locations?.[0]).toMatchObject({ path: TARGET, line: 4, character: 5 });
	});

	it("returns unsupported when the server lacks the capability", async () => {
		const service = createService();
		openServices.push(service);

		// The fake advertises `definitionProvider` but not `signatureHelpProvider`.
		const envelope = await executeOperation(
			service,
			{ operation: "signatureHelp", path: FILE, line: 1, character: 1 },
			{ cwd: ROOT, maxResults: 100, logger: SILENT },
		);
		recordPids(service);

		expect(envelope.status).toBe("unsupported");
		expect(envelope.errors?.[0]).toContain("does not support 'signatureHelp'");
	});

	it("collects diagnostics published after didOpen", async () => {
		const service = createService(["--diagnostics-on-open"]);
		openServices.push(service);

		const diagnostics = await service.diagnosticsFor(FILE, { quietMs: 80, timeoutMs: 3000 });
		recordPids(service);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.severity).toBe(1);
		expect(diagnostics[0]?.message).toBe("fake diagnostic");
	});

	it("restarts a server and starts a fresh one on the next request", async () => {
		const service = createService();
		openServices.push(service);

		await service.describe(FILE);
		recordPids(service);
		const firstPid = service.status()[0]?.pid;
		expect(firstPid).toBeDefined();

		await service.restart("fake");
		expect(service.status()).toEqual([]);
		expect(await waitForDead(firstPid as number)).toBe(true);

		await service.describe(FILE);
		recordPids(service);
		const secondPid = service.status()[0]?.pid;
		expect(secondPid).toBeDefined();
		expect(secondPid).not.toBe(firstPid);
	});

	it("stops every process on shutdown", async () => {
		const service = createService();
		await service.describe(FILE);
		recordPids(service);
		const pid = service.status()[0]?.pid as number;

		await service.shutdown();

		expect(await waitForDead(pid)).toBe(true);
		expect(service.status()).toEqual([]);
	});
});
