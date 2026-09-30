import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireFleetRegistry,
	createLSPService,
	getLSPService,
	peekFleetRegistry,
	releaseFleetRegistry,
	type LSPServiceOptions,
} from "../../../src/core/service.ts";
import { executeOperation } from "../../../src/core/operations.ts";
import type { LspServerSpec } from "../../../src/types.ts";
import type { Logger } from "../../../src/util/logger.ts";
import { createFakeSpawn, delay } from "../../fixtures/fake-lsp-streams.ts";

const SILENT: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const BASE = mkdtempSync(join(tmpdir(), "pi-lsp-fleet-"));
const ROOT_A = join(BASE, "a");
const ROOT_B = join(BASE, "b");
const FILE_A1 = join(ROOT_A, "x.ts");
const FILE_A2 = join(ROOT_A, "y.ts");
const FILE_B = join(ROOT_B, "z.ts");

beforeAll(() => {
	mkdirSync(ROOT_A, { recursive: true });
	mkdirSync(ROOT_B, { recursive: true });
	writeFileSync(join(ROOT_A, "tsconfig.json"), "{}");
	writeFileSync(join(ROOT_B, "tsconfig.json"), "{}");
	writeFileSync(FILE_A1, "export const x = 1;\n");
	writeFileSync(FILE_A2, "export const y = 2;\n");
	writeFileSync(FILE_B, "export const z = 3;\n");
});

afterAll(() => {
	rmSync(BASE, { recursive: true, force: true });
});

/** The fake's `cmd[0]` must be an absolute executable for `resolveCommand`. */
const SPEC: LspServerSpec = {
	id: "fake",
	cmd: [process.execPath, "--stdio"],
	filetypes: ["typescript"],
	rootMarkers: ["tsconfig.json"],
	singleFileSupport: false,
};

const SERVERS = new Map([["fake", SPEC]]);
const LANGUAGE_IDS = new Map([[".ts", "typescript"]]);

/** Ids passed to `acquireFleetRegistry`, released after each test. */
const acquired: string[] = [];

function acquire(runtimeId: string) {
	acquired.push(runtimeId);
	return acquireFleetRegistry(runtimeId);
}

afterEach(async () => {
	// Release in reverse: the last acquire owns the fleet.
	while (acquired.length > 0) {
		await releaseFleetRegistry(acquired.pop() as string);
	}
	const leftover = peekFleetRegistry();
	if (leftover !== undefined) await releaseFleetRegistry(leftover.ownerRuntimeId);
});

function serviceOptions(overrides: Partial<LSPServiceOptions> = {}): LSPServiceOptions {
	return {
		servers: SERVERS,
		cwd: BASE,
		languageIds: LANGUAGE_IDS,
		logger: SILENT,
		...overrides,
	};
}

describe("createLSPService — fleet keying", () => {
	it("shares one process between two files in the same project root", async () => {
		const fake = createFakeSpawn();
		const service = createLSPService(serviceOptions({ spawn: fake.spawn }));

		try {
			await service.touchFile(FILE_A1);
			await service.touchFile(FILE_A2);

			expect(fake.spawned).toHaveLength(1);
			expect(fake.servers).toHaveLength(1);
			expect(service.status()).toHaveLength(1);
			expect(service.status()[0]?.openDocuments).toBe(2);
			expect(service.status()[0]?.state).toBe("ready");
		} finally {
			await service.shutdown();
		}
	});

	it("starts a second process for a second project root", async () => {
		const fake = createFakeSpawn();
		const service = createLSPService(serviceOptions({ spawn: fake.spawn }));

		try {
			await service.touchFile(FILE_A1);
			await service.touchFile(FILE_B);

			expect(fake.spawned).toHaveLength(2);
			expect(service.status().map((entry) => entry.root)).toEqual([ROOT_A, ROOT_B]);
		} finally {
			await service.shutdown();
		}
	});

	it("reports the negotiated capabilities for a path", async () => {
		const fake = createFakeSpawn();
		const service = createLSPService(serviceOptions({ spawn: fake.spawn }));

		try {
			const description = await service.describe(FILE_A1);
			expect(description.serverId).toBe("fake");
			expect(description.root).toBe(ROOT_A);
			expect(description.capabilities.positionEncoding).toBe("utf-16");
			expect(description.capabilities.syncKind).toBe(1);
		} finally {
			await service.shutdown();
		}
	});

	it("shutdown is idempotent and stops the process", async () => {
		const fake = createFakeSpawn();
		const service = createLSPService(serviceOptions({ spawn: fake.spawn }));

		await service.touchFile(FILE_A1);
		expect(fake.servers[0]?.killed).toBe(false);

		await service.shutdown();
		await service.shutdown();

		expect(fake.servers[0]?.killed).toBe(true);
		expect(service.status()).toEqual([]);
	});

	it("returns no_server for an unhandled extension without spawning anything", async () => {
		const fake = createFakeSpawn();
		// No extension mapping at all, so nothing can handle the file.
		const service = createLSPService(
			serviceOptions({ spawn: fake.spawn, languageIds: new Map<string, string>() }),
		);

		try {
			const envelope = await executeOperation(
				service,
				{ operation: "definition", path: FILE_A1, line: 1, character: 1 },
				{ cwd: BASE, maxResults: 100, logger: SILENT },
			);

			expect(envelope.status).toBe("no_server");
			expect(envelope.ok).toBe(false);
			expect(fake.spawned).toEqual([]);
		} finally {
			await service.shutdown();
		}
	});
});

describe("createLSPService — missing binary", () => {
	const MISSING = ["pi-lspconfig-definitely-not-on-path"];

	async function envelopeFor(spec: LspServerSpec) {
		const fake = createFakeSpawn();
		const service = createLSPService(
			serviceOptions({ servers: new Map([["fake", spec]]), spawn: fake.spawn }),
		);
		try {
			const envelope = await executeOperation(
				service,
				{ operation: "definition", path: FILE_A1, line: 1, character: 1 },
				{ cwd: BASE, maxResults: 100, logger: SILENT },
			);
			return { envelope, fake };
		} finally {
			await service.shutdown();
		}
	}

	it("names the install command in the hints when the spec declares one", async () => {
		const { envelope, fake } = await envelopeFor({
			...SPEC,
			cmd: MISSING,
			installCommand: "npm install -g fake-server",
		});

		expect(envelope.status).toBe("binary_missing");
		expect(envelope.hints).toContain("Install it with: npm install -g fake-server");
		// A missing binary is diagnosed before anything is spawned.
		expect(fake.spawned).toEqual([]);
	});

	it("falls back to the override hint when the spec declares no install command", async () => {
		const { envelope } = await envelopeFor({ ...SPEC, cmd: MISSING });

		expect(envelope.status).toBe("binary_missing");
		expect(envelope.hints).toEqual([
			"Install it, or override 'cmd' for 'fake' in pi-lspconfig.config.ts.",
		]);
	});
});

describe("getLSPService", () => {
	it("returns the same instance for the same cwd and table", () => {
		acquire("r1");
		const first = getLSPService(serviceOptions());
		const second = getLSPService(serviceOptions());
		expect(second).toBe(first);
	});

	it("replaces the service when the server table changes", () => {
		acquire("r1");
		const first = getLSPService(serviceOptions());

		const otherServers = new Map<string, LspServerSpec>([
			["other", { id: "other", cmd: [process.execPath], filetypes: ["typescript"] }],
		]);
		const second = getLSPService(serviceOptions({ servers: otherServers }));

		expect(second).not.toBe(first);
	});
});

describe("fleet registry handoff", () => {
	it("adopts a surviving fleet and cancels the predecessor's deferred teardown", async () => {
		const fake = createFakeSpawn();
		const r1 = acquire("r1");
		const service = getLSPService(serviceOptions({ spawn: fake.spawn }));
		await service.touchFile(FILE_A1);
		expect(fake.servers).toHaveLength(1);

		await releaseFleetRegistry("r1", { handoff: true, graceMs: 40 });
		expect(fake.servers[0]?.killed).toBe(false);

		const generationBefore = r1.generation;
		const r2 = acquire("r2");
		expect(r2.services.get(BASE)).toBe(service);
		expect(r2.generation).toBeGreaterThan(generationBefore);

		// The successor's acquire must cancel the pending teardown.
		await delay(80);
		expect(fake.servers[0]?.killed).toBe(false);
	});

	it("tears the fleet down after the grace window when nobody adopts it", async () => {
		const fake = createFakeSpawn();
		acquire("r1");
		const service = getLSPService(serviceOptions({ spawn: fake.spawn }));
		await service.touchFile(FILE_A1);

		await releaseFleetRegistry("r1", { handoff: true, graceMs: 30 });
		expect(fake.servers[0]?.killed).toBe(false);

		await delay(70);
		expect(fake.servers[0]?.killed).toBe(true);
		expect(peekFleetRegistry()).toBeUndefined();
	});

	it("tears the fleet down immediately without handoff", async () => {
		const fake = createFakeSpawn();
		acquire("r1");
		const service = getLSPService(serviceOptions({ spawn: fake.spawn }));
		await service.touchFile(FILE_A1);

		await releaseFleetRegistry("r1");

		expect(fake.servers[0]?.killed).toBe(true);
		expect(peekFleetRegistry()).toBeUndefined();
	});

	it("ignores a release from a runtime that no longer owns the fleet", async () => {
		const fake = createFakeSpawn();
		acquire("r1");
		const service = getLSPService(serviceOptions({ spawn: fake.spawn }));
		await service.touchFile(FILE_A1);

		acquire("r2");
		await releaseFleetRegistry("r1");

		expect(fake.servers[0]?.killed).toBe(false);
		expect(peekFleetRegistry()?.ownerRuntimeId).toBe("r2");
	});
});
