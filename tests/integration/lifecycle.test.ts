/**
 * M4 — lifecycle, reload, and trust hardening, against real child processes.
 *
 * The reload contract is simulated exactly as the Pi host sequences it:
 * `session_shutdown{reason:"reload"}` on the old runtime, then
 * `session_start{reason:"reload"}` on a fresh one. Both runtimes share this
 * module graph (a real `/reload` re-evaluates it), which is what makes the
 * mtime-based config cache observable here.
 *
 * Pi treats a captured `pi`/`ctx` as stale after the reload boundary, so the
 * shutdown path must complete without touching either. `endSession` takes no
 * `ctx`; the handler-level test below additionally poisons the context to prove
 * nothing reaches through it.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { peekFleetRegistry, releaseFleetRegistry } from "../../src/core/service.ts";
import {
	createSessionState,
	endSession,
	installLifecycle,
	startSession,
	type SessionState,
} from "../../src/extension/lifecycle.ts";
import { BUILTIN_SERVERS } from "../../src/languages/index.ts";
import { DEFAULT_MAX_RESULTS } from "../../src/util/defaults.ts";

const FAKE_SERVER = fileURLToPath(new URL("../fixtures/fake-lsp-server.mjs", import.meta.url));
const BASE = mkdtempSync(join(tmpdir(), "pi-lsp-m4-"));
const FAKE_HOME = join(BASE, "home");

beforeAll(() => {
	mkdirSync(FAKE_HOME, { recursive: true });
	// `loadUserConfig` resolves `homedir()` itself, so the developer's real
	// global configs would otherwise leak into the resolved server table.
	vi.stubEnv("HOME", FAKE_HOME);
});

afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(BASE, { recursive: true, force: true });
});

let projectCounter = 0;

/** A tiny trusted project with a root marker and a source file. */
function createProject(): string {
	const project = join(BASE, `project-${projectCounter++}`);
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "tsconfig.json"), "{}");
	writeFileSync(join(project, "source.ts"), "export const x = 1;\n");
	return project;
}

const configPath = (project: string): string => join(project, "pi-lspconfig.config.ts");

/** A project config pointing the TypeScript server at the fake LSP server. */
function writeConfig(project: string, maxResults?: number): void {
	const lines = [
		"export default {",
		...(maxResults === undefined ? [] : [`\tdefaults: { maxResults: ${maxResults} },`]),
		"\tservers: {",
		`\t\tvtsls: { cmd: ${JSON.stringify([process.execPath, FAKE_SERVER])} },`,
		"\t},",
		"};",
		"",
	];
	writeFileSync(configPath(project), lines.join("\n"));
}

interface FakeHost {
	ctx: ExtensionContext;
	notifications: { message: string; level: string }[];
}

function createHost(cwd: string, projectTrusted: boolean): FakeHost {
	const notifications: { message: string; level: string }[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		isProjectTrusted: () => projectTrusted,
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications };
}

/** A `pi` that records handlers and reports default flag values. */
function fakePi(): {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		getFlag: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

const startEvent = (reason: SessionStartEvent["reason"]): SessionStartEvent => ({
	type: "session_start",
	reason,
});

const shutdownEvent = (reason: SessionShutdownEvent["reason"]): SessionShutdownEvent => ({
	type: "session_shutdown",
	reason,
});

/** Run one `session_start` and return the runtime state plus the host. */
async function start(
	cwd: string,
	reason: SessionStartEvent["reason"],
	projectTrusted = true,
): Promise<{ state: SessionState; host: FakeHost }> {
	const state = createSessionState();
	const host = createHost(cwd, projectTrusted);
	await startSession(state, startEvent(reason), host.ctx);
	return { state, host };
}

function requireService(state: SessionState) {
	const service = state.service;
	if (service === undefined) throw new Error("session did not bind a service");
	return service;
}

/** Every pid a test observed, so the sweep below can prove none survives. */
const spawnedPids = new Set<number>();

function track(state: SessionState): number {
	const pid = state.service?.status()[0]?.pid;
	if (pid === undefined) throw new Error("session did not start a server");
	spawnedPids.add(pid);
	return pid;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDead(pid: number, timeoutMs = 4000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

afterEach(async () => {
	// Tear down whatever a failed assertion left behind, then prove no pid
	// survived the test.
	const registry = peekFleetRegistry();
	if (registry !== undefined) await releaseFleetRegistry(registry.ownerRuntimeId);
	for (const pid of spawnedPids) await waitForDead(pid);

	const survivors = [...spawnedPids].filter(isAlive);
	for (const pid of survivors) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	spawnedPids.clear();
	expect(survivors).toEqual([]);
});

describe("session lifecycle", () => {
	it("hands the fleet across a reload instead of restarting it, and stops it on quit", async () => {
		const project = createProject();
		writeConfig(project);
		const file = join(project, "source.ts");

		const first = await start(project, "startup");
		const service = requireService(first.state);
		await service.touchFile(file);
		const pid = track(first.state);

		await endSession(first.state, shutdownEvent("reload"));

		// The old runtime is scrubbed before the await, so it holds nothing it
		// could use across the reload boundary, and the process stays warm.
		expect(first.state.service).toBeUndefined();
		expect(first.state.registry).toBeUndefined();
		expect(isAlive(pid)).toBe(true);

		const second = await start(project, "reload");
		expect(second.state.service).toBe(service);

		await requireService(second.state).touchFile(file);
		expect(second.state.service?.status()[0]?.pid).toBe(pid);

		await endSession(second.state, shutdownEvent("quit"));

		expect(await waitForDead(pid)).toBe(true);
		expect(second.state.service).toBeUndefined();
		expect(second.state.registry).toBeUndefined();
	});

	it("re-reads a config file changed on disk between sessions", async () => {
		const project = createProject();
		writeConfig(project, 10);
		const file = join(project, "source.ts");

		const first = await start(project, "startup");
		expect(first.state.config?.maxResults).toBe(10);
		const service = requireService(first.state);
		await service.touchFile(file);
		const pid = track(first.state);

		// Rewrite the config and give it a strictly newer mtime, so a cache hit
		// cannot be right by accident.
		writeConfig(project, 20);
		const future = new Date(Date.now() + 5_000);
		utimesSync(configPath(project), future, future);

		await endSession(first.state, shutdownEvent("reload"));
		const second = await start(project, "reload");

		expect(second.state.config?.maxResults).toBe(20);
		// `defaults` is not part of the fleet signature, so the warm server is
		// adopted rather than restarted.
		expect(second.state.service).toBe(service);
		expect(second.state.service?.status()[0]?.pid).toBe(pid);

		await endSession(second.state, shutdownEvent("quit"));
		expect(await waitForDead(pid)).toBe(true);
	});

	it("does not load project configs when the project is untrusted, and reports once", async () => {
		const project = createProject();
		writeConfig(project, 99);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(project, ".pi", "pi-lspconfig.config.ts"),
			"export default { defaults: { maxResults: 98 } };\n",
		);

		const { state, host } = await start(project, "startup", false);

		expect(state.config?.maxResults).toBe(DEFAULT_MAX_RESULTS);
		expect(state.config?.servers.size).toBe(BUILTIN_SERVERS.length);

		// One notification for two skipped files: the user made one trust
		// decision, not two.
		const skipped = host.notifications.filter((entry) => entry.message.includes("not trusted"));
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.message).toContain(configPath(project));
		expect(skipped[0]?.message).toContain(join(project, ".pi", "pi-lspconfig.config.ts"));
	});

	it("collects a config that throws on import and still starts with the built-ins", async () => {
		const project = createProject();
		writeFileSync(configPath(project), "throw new Error('config exploded');\n");

		const { state, host } = await start(project, "startup");

		expect(state.config?.servers.size).toBe(BUILTIN_SERVERS.length);
		expect(state.service).toBeDefined();

		const reported = host.notifications.filter((entry) => entry.message.includes("config exploded"));
		expect(reported).toHaveLength(1);
		expect(reported[0]?.level).toBe("warning");
		expect(reported[0]?.message).toContain(configPath(project));
	});

	it("endSession is idempotent", async () => {
		const project = createProject();
		writeConfig(project);

		const { state } = await start(project, "startup");
		await requireService(state).touchFile(join(project, "source.ts"));
		const pid = track(state);

		await endSession(state, shutdownEvent("quit"));
		await endSession(state, shutdownEvent("quit"));

		expect(await waitForDead(pid)).toBe(true);

		// A runtime that never started a session is safe to end too.
		await endSession(createSessionState(), shutdownEvent("quit"));
	});
});

describe("reload through the registered handlers", () => {
	it("runs the shutdown/start sequence without touching the stale context", async () => {
		const project = createProject();
		writeConfig(project);
		const file = join(project, "source.ts");

		// Runtime 1 — a real extension instance.
		const first = fakePi();
		const state = createSessionState();
		installLifecycle(first.pi, state);
		await first.handlers.get("session_start")?.(startEvent("startup"), createHost(project, true).ctx);

		const service = requireService(state);
		await service.touchFile(file);
		const pid = track(state);

		// `session_shutdown{reason:"reload"}` is the last thing the old runtime
		// sees before Pi invalidates it. Any `ctx` access here throws in a real
		// session, so hand it one that throws in the test too.
		const failures: unknown[] = [];
		state.logger = {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: (_message, error) => failures.push(error),
		};
		const stale = new Proxy(
			{},
			{
				get: () => {
					throw new Error("stale ctx used after reload");
				},
			},
		);
		await first.handlers.get("session_shutdown")?.(shutdownEvent("reload"), stale);

		expect(failures).toEqual([]);
		expect(state.service).toBeUndefined();
		expect(state.registry).toBeUndefined();
		expect(isAlive(pid)).toBe(true);

		// Runtime 2 — a fresh module graph would build the same handlers.
		const second = fakePi();
		const successor = createSessionState();
		installLifecycle(second.pi, successor);
		await second.handlers.get("session_start")?.(startEvent("reload"), createHost(project, true).ctx);

		expect(successor.service).toBe(service);
		await requireService(successor).touchFile(file);
		expect(successor.service?.status()[0]?.pid).toBe(pid);

		await second.handlers.get("session_shutdown")?.(shutdownEvent("quit"), undefined);
		expect(await waitForDead(pid)).toBe(true);
	});
});
