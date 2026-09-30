import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../../../src/config/resolve.ts";
import { createSessionState } from "../../../src/extension/lifecycle.ts";
import { createToolDeps, registerLspTools } from "../../../src/extension/register.ts";
import { DEFAULT_MAX_RESULTS } from "../../../src/util/defaults.ts";
import { createLogger } from "../../../src/util/logger.ts";
import { createServiceStub } from "../tools/service-stub.ts";

/** A `pi` that records registrations instead of performing them. */
function fakePi(): { pi: ExtensionAPI; tools: { name: string }[] } {
	const tools: { name: string }[] = [];
	const pi = {
		registerTool: (tool: { name: string }) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function resolvedConfig(maxResults: number): ResolvedConfig {
	return {
		servers: new Map(),
		disabled: new Set(),
		languageIds: new Map(),
		maxResults,
		notes: [],
	};
}

describe("createToolDeps", () => {
	it("reads the session on every call instead of capturing it", () => {
		const state = createSessionState();
		const deps = createToolDeps(state);

		const before = deps.getSession();
		expect(before.service).toBeUndefined();
		expect(before.maxResults).toBe(DEFAULT_MAX_RESULTS);

		// Everything the tools need appears only at `session_start`.
		const stub = createServiceStub();
		const logger = createLogger({ level: "debug" });
		state.service = stub.service;
		state.logger = logger;
		state.config = resolvedConfig(42);

		const after = deps.getSession();
		expect(after.service).toBe(stub.service);
		expect(after.logger).toBe(logger);
		expect(after.maxResults).toBe(42);
		// A fresh snapshot each call, not a cached object.
		expect(after).not.toBe(before);
	});

	it("falls back to the default cap when no config is resolved", () => {
		const state = createSessionState();
		state.config = undefined;

		expect(createToolDeps(state).getSession().maxResults).toBe(DEFAULT_MAX_RESULTS);
	});
});

describe("registerLspTools", () => {
	it("registers both tools and starts nothing", () => {
		const state = createSessionState();
		const { pi, tools } = fakePi();

		registerLspTools(pi, state);

		expect(tools.map((tool) => tool.name)).toEqual(["lsp", "lsp_diagnostics"]);
		// Registration is a declaration: no service, no fleet, no processes.
		expect(state.service).toBeUndefined();
		expect(state.registry).toBeUndefined();
	});
});
