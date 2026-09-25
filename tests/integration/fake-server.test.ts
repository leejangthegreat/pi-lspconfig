import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchLSP } from "../../src/core/client/launch.ts";
import type { LSPProcess } from "../../src/core/client/launch.ts";
import { createLSPConnection, isLSPRequestError } from "../../src/core/client/connection.ts";
import type { LSPConnection } from "../../src/core/client/connection.ts";
import { initializeClient } from "../../src/core/client/initialize.ts";
import type { InitializeOptions } from "../../src/core/client/initialize.ts";
import { createDocumentSynchronizer } from "../../src/core/client/sync.ts";
import { createDiagnosticStore, toSeverityLabel } from "../../src/core/client/diagnostics.ts";
import type { NegotiatedCapabilities } from "../../src/types.ts";
import type { PublishDiagnosticsParams } from "../../src/protocol.ts";

const FAKE_SERVER = fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const TEMP_DIR = mkdtempSync(join(tmpdir(), "pi-lsp-m1-"));

/** Every pid spawned in this file, so the sweep below can prove none survives. */
const spawnedPids = new Set<number>();

function start(args: readonly string[]): LSPProcess {
	const proc = launchLSP({
		command: process.execPath,
		args: [FAKE_SERVER, ...args],
		cwd: REPO_ROOT,
	});
	if (proc.pid !== undefined) spawnedPids.add(proc.pid);
	return proc;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pids can take a moment to be reaped; poll rather than race. */
async function waitForDead(pid: number, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await delay(25);
	}
	return !isAlive(pid);
}

async function expectDead(pid: number | undefined): Promise<void> {
	if (pid === undefined) return;
	expect(await waitForDead(pid)).toBe(true);
}

interface Context {
	proc: LSPProcess;
	connection: LSPConnection;
	caps: NegotiatedCapabilities;
}

/** Start the fake, hand it a live connection, and always tear both down. */
async function withServer(
	args: readonly string[],
	fn: (ctx: Context) => Promise<void>,
	initOptions: Partial<InitializeOptions> = {},
): Promise<number | undefined> {
	const proc = start(args);
	const connection = createLSPConnection(proc);
	connection.listen();
	try {
		const caps = await initializeClient(connection, {
			root: REPO_ROOT,
			timeoutMs: 5000,
			...initOptions,
		});
		await fn({ proc, connection, caps });
	} finally {
		try {
			await connection.sendRequest("shutdown", undefined);
		} catch {
			// The server may already be gone.
		}
		connection.sendNotification("exit", {});
		await proc.kill(200);
		connection.dispose();
	}
	return proc.pid;
}

afterAll(async () => {
	const alive = [...spawnedPids].filter(isAlive);
	// Do not let a failed assertion leave a stray process behind.
	for (const pid of alive) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	rmSync(TEMP_DIR, { recursive: true, force: true });
	expect(alive).toEqual([]);
});

describe("fake LSP server handshake", () => {
	it("completes initialize and reports the advertised encoding and sync kind", async () => {
		const pid = await withServer(["--position-encoding=utf-8", "--sync-kind=2"], async ({ caps }) => {
			expect(caps.positionEncoding).toBe("utf-8");
			expect(caps.syncKind).toBe(2);
			expect(caps.serverCapabilities.definitionProvider).toBeTruthy();
		});
		await expectDead(pid);
	});

	it("defaults to UTF-16 when the server advertises no encoding", async () => {
		const pid = await withServer(["--sync-kind=1"], async ({ caps }) => {
			expect(caps.positionEncoding).toBe("utf-16");
			expect(caps.syncKind).toBe(1);
		});
		await expectDead(pid);
	});

	it("sends the capabilities and workspace root it received", async () => {
		const recordPath = join(TEMP_DIR, "capabilities.json");
		const pid = await withServer([`--record=${recordPath}`], async () => {
			const received = JSON.parse(readFileSync(recordPath, "utf8")) as {
				processId: number;
				rootUri: string;
				clientInfo: { name: string };
				capabilities: { general: { positionEncodings: string[] } };
			};

			expect(received.processId).toBe(process.pid);
			expect(received.rootUri).toBe(pathToFileURL(REPO_ROOT).href);
			expect(received.clientInfo.name).toBe("pi-lspconfig");
			expect(received.capabilities.general.positionEncodings).toContain("utf-16");
		});
		await expectDead(pid);
	});
});

describe("document synchronisation over the wire", () => {
	it("sends didOpen, didChange, and didClose with increasing versions", async () => {
		const versionsPath = join(TEMP_DIR, "versions.jsonl");
		const file = join(TEMP_DIR, "sync.ts");

		const pid = await withServer(
			["--sync-kind=2", `--record-versions=${versionsPath}`],
			async ({ connection, caps }) => {
				const sync = createDocumentSynchronizer({
					connection,
					syncKind: caps.syncKind,
					languageIdFor: () => "typescript",
					positionEncoding: caps.positionEncoding,
				});

				await sync.touch(file, { content: "const a = 1;\n" });
				await sync.touch(file, { content: "const a = 2;\n" });
				await sync.touch(file, { content: "const a = 2;\nconst b = 3;\n" });
				await sync.close(file);

				// Notifications are fire-and-forget. JSON-RPC preserves order on one
				// stream, so a round-trip proves the fake handled everything before it.
				await connection.sendRequest("textDocument/definition", {
					textDocument: { uri: pathToFileURL(file).href },
					position: { line: 0, character: 0 },
				});

				const events = readFileSync(versionsPath, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as { method: string; version?: number });

				expect(events.map((event) => event.method)).toEqual([
					"textDocument/didOpen",
					"textDocument/didChange",
					"textDocument/didChange",
					"textDocument/didClose",
				]);

				const versions = events
					.filter((event) => event.version !== undefined)
					.map((event) => event.version as number);
				expect(versions).toEqual([1, 2, 3]);
				for (let i = 1; i < versions.length; i++) {
					expect(versions[i]).toBeGreaterThan(versions[i - 1] as number);
				}
			},
		);
		await expectDead(pid);
	});
});

describe("requests", () => {
	it("round-trips a definition request and returns the canned location", async () => {
		const target = join(TEMP_DIR, "target.ts");
		const file = join(TEMP_DIR, "source.ts");

		const pid = await withServer([`--definition=${target}:3:4`], async ({ connection, caps }) => {
			const sync = createDocumentSynchronizer({
				connection,
				syncKind: caps.syncKind,
				languageIdFor: () => "typescript",
			});
			await sync.touch(file, { content: "const a = 1;\n" });

			const location = await connection.sendRequest<{
				uri: string;
				range: { start: { line: number; character: number } };
			}>("textDocument/definition", {
				textDocument: { uri: pathToFileURL(file).href },
				position: { line: 0, character: 0 },
			});

			expect(location.uri).toBe(pathToFileURL(target).href);
			expect(location.range.start).toEqual({ line: 3, character: 4 });
		});
		await expectDead(pid);
	});

	it("rejects with an LSPRequestError carrying the JSON-RPC code", async () => {
		const pid = await withServer([], async ({ connection }) => {
			let caught: unknown;
			try {
				await connection.sendRequest("textDocument/unknown", {});
			} catch (error) {
				caught = error;
			}

			expect(isLSPRequestError(caught)).toBe(true);
			expect((caught as { code: number }).code).toBe(-32601);
		});
		await expectDead(pid);
	});
});

describe("diagnostics", () => {
	it("collects diagnostics published after didOpen", async () => {
		const file = join(TEMP_DIR, "diagnostics.ts");

		const pid = await withServer(["--diagnostics-on-open"], async ({ connection, caps }) => {
			const store = createDiagnosticStore();
			connection.onNotification("textDocument/publishDiagnostics", (params) => {
				store.onPublish(params as PublishDiagnosticsParams);
			});

			const sync = createDocumentSynchronizer({
				connection,
				syncKind: caps.syncKind,
				languageIdFor: () => "typescript",
			});
			await sync.touch(file, { content: "const broken = ;\n" });

			const diagnostics = await store.waitFor(file, { quietMs: 80, timeoutMs: 3000 });

			expect(diagnostics).toHaveLength(1);
			expect(toSeverityLabel(diagnostics[0]?.severity)).toBe("error");
			expect(store.counts()).toEqual({ files: 1, total: 1 });
		});
		await expectDead(pid);
	});
});

describe("process lifecycle", () => {
	it("escalates SIGTERM to SIGKILL when the server ignores SIGTERM", async () => {
		const proc = start(["--ignore-sigterm"]);
		const connection = createLSPConnection(proc);
		connection.listen();

		try {
			await initializeClient(connection, { root: REPO_ROOT, timeoutMs: 5000 });
			const pid = proc.pid;
			expect(pid).toBeDefined();

			// A plain SIGTERM is deliberately ignored, proving the process survives it.
			process.kill(pid as number, "SIGTERM");
			await delay(200);
			expect(isAlive(pid as number)).toBe(true);

			// Only the SIGKILL escalation ends it.
			await proc.kill(150);
			expect(await waitForDead(pid as number)).toBe(true);
		} finally {
			await proc.kill(150);
			connection.dispose();
		}

		await expectDead(proc.pid);
	});

	it("times out when the server never answers initialize", async () => {
		const proc = start(["--hang-on-initialize"]);
		const connection = createLSPConnection(proc);
		connection.listen();

		try {
			await expect(
				initializeClient(connection, { root: REPO_ROOT, timeoutMs: 150 }),
			).rejects.toThrow(/timed out/);
		} finally {
			await proc.kill(150);
			connection.dispose();
		}

		await expectDead(proc.pid);
	});
});
