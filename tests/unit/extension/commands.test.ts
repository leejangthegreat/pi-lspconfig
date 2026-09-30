import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../../src/config/resolve.ts";
import {
	configCommand,
	listCommand,
	restartCommand,
	statusCommand,
} from "../../../src/extension/commands.ts";
import { createSessionState, type SessionState } from "../../../src/extension/lifecycle.ts";
import type { LspServerSpec } from "../../../src/types.ts";
import { createServiceStub, type ServiceStubOptions } from "../tools/service-stub.ts";

function spec(id: string, overrides: Partial<LspServerSpec> = {}): LspServerSpec {
	return { id, cmd: ["fake-ls", "--stdio"], filetypes: ["typescript"], ...overrides };
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		servers: new Map(),
		disabled: new Set(),
		languageIds: new Map(),
		maxResults: 100,
		notes: [],
		...overrides,
	};
}

function stateWith(options: {
	config?: ResolvedConfig;
	service?: ServiceStubOptions;
	disabled?: boolean;
} = {}): SessionState {
	const state = createSessionState();
	state.flags = { disabled: options.disabled === true, logLevel: "off" };
	state.config = options.config;
	state.service = options.service === undefined ? undefined : createServiceStub(options.service).service;
	return state;
}

describe("/lsp-status", () => {
	it("says when the extension is disabled", () => {
		expect(statusCommand(stateWith({ disabled: true })).message).toContain("--lsp-disable");
	});

	it("says when no service is bound", () => {
		expect(statusCommand(stateWith()).message).toContain("no language server is running");
	});

	it("says when nothing has started yet", () => {
		const state = stateWith({ service: {} });

		expect(statusCommand(state).message).toContain("start on first use");
	});

	it("lists every running client", () => {
		const state = stateWith({
			service: {
				status: [
					{
						serverId: "fake",
						root: "/repo",
						pid: 123,
						state: "ready",
						openDocuments: 2,
						diagnosticCount: 3,
					},
					{
						serverId: "other",
						root: undefined,
						pid: undefined,
						state: "starting",
						openDocuments: 0,
						diagnosticCount: 0,
						lastError: "boom",
					},
				],
			},
		});

		expect(statusCommand(state).message).toBe(
			[
				"pi-lspconfig: 2 language servers running",
				"  fake  ready  root /repo  pid 123  documents 2  diagnostics 3",
				"  other  starting  root (none)  pid -  documents 0  diagnostics 0  error boom",
			].join("\n"),
		);
	});
});

describe("/lsp-restart", () => {
	it("rejects an unknown server instead of restarting nothing", async () => {
		const stub = createServiceStub({ allServers: [spec("fake")] });
		const state = createSessionState();
		state.service = stub.service;

		const outcome = await restartCommand(state, "nope");

		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("unknown server 'nope'");
		expect(stub.restarted).toEqual([]);
	});

	it("restarts one server by id", async () => {
		const stub = createServiceStub({ allServers: [spec("fake")] });
		const state = createSessionState();
		state.service = stub.service;

		const outcome = await restartCommand(state, " fake ");

		expect(outcome.level).toBe("info");
		expect(outcome.message).toContain("restarted 'fake'");
		expect(stub.restarted).toEqual(["fake"]);
	});

	it("restarts everything and reports how many were running", async () => {
		const stub = createServiceStub({
			status: [
				{ serverId: "fake", root: "/repo", pid: 1, state: "ready", openDocuments: 0, diagnosticCount: 0 },
			],
		});
		const state = createSessionState();
		state.service = stub.service;

		const outcome = await restartCommand(state, "  ");

		expect(outcome.message).toContain("restarted 1 language server");
		expect(stub.restarted).toEqual([undefined]);
	});

	it("says so when nothing was running", async () => {
		const state = stateWith({ service: {} });

		expect((await restartCommand(state, "")).message).toContain("no language servers were running");
	});

	it("reports a restart failure as a warning", async () => {
		const stub = createServiceStub({ restartError: new Error("kill failed") });
		const state = createSessionState();
		state.service = stub.service;

		const outcome = await restartCommand(state, "");

		expect(outcome.level).toBe("warning");
		expect(outcome.message).toContain("restart failed: kill failed");
	});
});

describe("/lsp-list", () => {
	it("says when the config was never resolved", () => {
		expect(listCommand(stateWith()).message).toContain("configuration has not been resolved");
	});

	it("says when nothing is configured", () => {
		expect(listCommand(stateWith({ config: config() })).message).toContain(
			"no language servers are configured",
		);
	});

	it("lists servers, their filetypes, their command, and the disabled set", () => {
		const state = stateWith({
			config: config({
				servers: new Map([
					["fake", spec("fake", { filetypes: ["typescript", "javascript"] })],
					["dynamic", spec("dynamic", { cmd: () => ["x"], filetypes: [] })],
				]),
				disabled: new Set(["gopls"]),
			}),
		});

		expect(listCommand(state).message).toBe(
			[
				"pi-lspconfig: 2 language servers configured",
				"  fake  typescript, javascript  fake-ls --stdio",
				"  dynamic  (no filetypes)  (dynamic cmd)",
				"  disabled: gopls",
			].join("\n"),
		);
	});
});

describe("/lsp-config", () => {
	it("says when the config was never resolved", () => {
		expect(configCommand(stateWith(), "fake").message).toContain("configuration has not been resolved");
	});

	it("explains its usage and lists the known servers", () => {
		const state = stateWith({ config: config({ servers: new Map([["fake", spec("fake")]]) }) });

		expect(configCommand(state, "").message).toContain("usage: /lsp-config <server>");
		expect(configCommand(state, "nope").message).toContain("unknown server 'nope'");
	});

	it("dumps the merged spec and that server's notes", () => {
		const state = stateWith({
			config: config({
				servers: new Map([
					[
						"fake",
						spec("fake", {
							rootMarkers: ["tsconfig.json", ".git"],
							singleFileSupport: true,
							initializeTimeoutMs: 15_000,
							settings: { strict: true },
						}),
					],
				]),
				notes: ["fake: overridden", "fake: removed settings.strict", "other: added"],
			}),
		});

		expect(configCommand(state, "fake").message).toBe(
			[
				"pi-lspconfig: fake",
				"  cmd: fake-ls --stdio",
				"  filetypes: typescript",
				"  rootMarkers: tsconfig.json, .git",
				"  singleFileSupport: true",
				"  initializeTimeoutMs: 15000",
				'  settings: {"strict":true}',
				"  notes: fake: overridden; fake: removed settings.strict",
			].join("\n"),
		);
	});
});
