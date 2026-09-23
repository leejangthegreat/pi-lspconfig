import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESULTS } from "../../../src/config/defaults.ts";
import { mergeServerSpec, resolveConfig, resolveLanguageIds } from "../../../src/config/resolve.ts";
import { BUILTIN_SERVERS, EXTENSION_TO_LANGUAGE_ID } from "../../../src/languages/index.ts";
import type { LspServerSpec } from "../../../src/types.ts";

const BASE: LspServerSpec = {
	id: "pyright",
	cmd: ["pyright-langserver", "--stdio"],
	filetypes: ["python"],
	rootMarkers: ["a", "b", "c", "d"],
	settings: {
		python: {
			analysis: {
				typeCheckingMode: "standard",
				inlayHints: { variableTypes: true },
			},
		},
	},
};

function settingsOf(spec: LspServerSpec): Record<string, any> {
	return spec.settings as Record<string, any>;
}

describe("mergeServerSpec", () => {
	it("returns a new spec, preserves id, and does not mutate the base", () => {
		const merged = mergeServerSpec(BASE, {
			settings: { python: { analysis: { typeCheckingMode: "strict" } } },
		});

		expect(merged).not.toBe(BASE);
		expect(merged.id).toBe("pyright");
		expect(settingsOf(merged).python.analysis.typeCheckingMode).toBe("strict");
		expect(settingsOf(merged).python.analysis.inlayHints).toEqual({ variableTypes: true });
		expect(settingsOf(BASE).python.analysis.typeCheckingMode).toBe("standard");
	});

	it("replaces arrays wholesale", () => {
		const merged = mergeServerSpec(BASE, { rootMarkers: ["x"] });
		expect(merged.rootMarkers).toEqual(["x"]);
	});

	it("replaces built-in cmd and rootDir functions rather than wrapping them", () => {
		const baseRoot = (file: string) => `${file}/base`;
		const overrideRoot = (file: string) => `${file}/override`;
		const baseCmd = () => ["base"];
		const overrideCmd = () => ["override"];

		const synthetic: LspServerSpec = {
			id: "synthetic",
			cmd: baseCmd,
			filetypes: ["x"],
			rootDir: baseRoot,
		};

		const merged = mergeServerSpec(synthetic, { cmd: overrideCmd, rootDir: overrideRoot });

		expect(merged.cmd).toBe(overrideCmd);
		expect(merged.rootDir).toBe(overrideRoot);
		expect(merged.rootDir).not.toBe(baseRoot);
	});
});

describe("resolveLanguageIds", () => {
	it("copies the built-in map and lets user overrides win", () => {
		const resolved = resolveLanguageIds(
			{ languageIds: { ".mts": "custom", ".vue": "vue" } },
			EXTENSION_TO_LANGUAGE_ID,
		);

		expect(resolved.get(".mts")).toBe("custom");
		expect(resolved.get(".vue")).toBe("vue");
		expect(resolved.get(".py")).toBe("python");
	});

	it("returns a mutable copy when there are no overrides", () => {
		const resolved = resolveLanguageIds({}, EXTENSION_TO_LANGUAGE_ID);
		resolved.set(".x", "x");

		expect(resolved.get(".x")).toBe("x");
		expect(resolved.size).toBe(Object.keys(EXTENSION_TO_LANGUAGE_ID).length + 1);
	});
});

describe("resolveConfig", () => {
	it("includes every built-in and does not alias the catalog", () => {
		const resolved = resolveConfig({}, BUILTIN_SERVERS);

		expect(resolved.servers.size).toBe(BUILTIN_SERVERS.length);
		for (const server of BUILTIN_SERVERS) {
			expect(resolved.servers.has(server.id)).toBe(true);
		}

		const vtsls = resolved.servers.get("vtsls")!;
		(vtsls.rootMarkers as string[]).push("injected");
		const catalog = BUILTIN_SERVERS.find((server) => server.id === "vtsls")!;
		expect(catalog.rootMarkers).not.toContain("injected");
	});

	it("merges a matching id onto the built-in and notes the override", () => {
		const resolved = resolveConfig(
			{ servers: { pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } } } },
			BUILTIN_SERVERS,
		);
		const pyright = resolved.servers.get("pyright")!;

		expect(settingsOf(pyright).python.analysis.typeCheckingMode).toBe("strict");
		expect(settingsOf(pyright).python.analysis.autoSearchPaths).toBe(true);
		expect(resolved.notes).toContain("pyright: overridden");
	});

	it("notes deleted nested keys", () => {
		const resolved = resolveConfig(
			{ servers: { pyright: { settings: { python: { analysis: { inlayHints: null } } } } } },
			BUILTIN_SERVERS,
		);
		const pyright = resolved.servers.get("pyright")!;

		expect(resolved.notes).toContain("pyright: removed settings.python.analysis.inlayHints");
		expect(settingsOf(pyright).python.analysis.inlayHints).toBeUndefined();
	});

	it("adds a new server when cmd and filetypes are present", () => {
		const resolved = resolveConfig(
			{ servers: { mylang: { cmd: ["mylang-ls", "--stdio"], filetypes: ["mylang"] } } },
			BUILTIN_SERVERS,
		);
		const spec = resolved.servers.get("mylang")!;

		expect(spec.id).toBe("mylang");
		expect(spec.filetypes).toEqual(["mylang"]);
		expect(resolved.notes).toContain("mylang: added");
	});

	it("keeps a new server without filetypes but notes that it matches no file", () => {
		const resolved = resolveConfig({ servers: { mylang: { cmd: ["mylang-ls"] } } }, BUILTIN_SERVERS);

		expect(resolved.servers.get("mylang")?.filetypes).toEqual([]);
		expect(resolved.notes).toContain("mylang: added (no filetypes)");
	});

	it("skips a new server without cmd", () => {
		const resolved = resolveConfig({ servers: { broken: { filetypes: ["x"] } } }, BUILTIN_SERVERS);

		expect(resolved.servers.has("broken")).toBe(false);
		expect(resolved.notes).toContain("broken: skipped (missing cmd)");
	});

	it("omits disabled servers and records every disabled id", () => {
		const resolved = resolveConfig(
			{ disabledServers: ["gopls", "never-existed"] },
			BUILTIN_SERVERS,
		);

		expect(resolved.servers.has("gopls")).toBe(false);
		expect(resolved.servers.has("vtsls")).toBe(true);
		expect(resolved.disabled.has("gopls")).toBe(true);
		expect(resolved.disabled.has("never-existed")).toBe(true);
		expect(resolved.notes).toContain("gopls: disabled");
	});

	it("ignores a user entry for a disabled built-in", () => {
		const resolved = resolveConfig(
			{ disabledServers: ["gopls"], servers: { gopls: { settings: { gopls: { staticcheck: false } } } } },
			BUILTIN_SERVERS,
		);

		expect(resolved.servers.has("gopls")).toBe(false);
	});

	it("resolves languageIds with user overrides winning", () => {
		const resolved = resolveConfig({ languageIds: { ".mts": "custom" } }, BUILTIN_SERVERS);

		expect(resolved.languageIds.get(".mts")).toBe("custom");
		expect(resolved.languageIds.get(".py")).toBe("python");
	});

	it("resolves maxResults, defaulting when unset", () => {
		expect(resolveConfig({}, BUILTIN_SERVERS).maxResults).toBe(DEFAULT_MAX_RESULTS);
		expect(resolveConfig({ defaults: { maxResults: 7 } }, BUILTIN_SERVERS).maxResults).toBe(7);
	});

	it("applies initializeTimeoutMs as a fallback, with a per-server value winning", () => {
		const resolved = resolveConfig(
			{
				defaults: { initializeTimeoutMs: 5000 },
				servers: { pyright: { initializeTimeoutMs: 1234 } },
			},
			BUILTIN_SERVERS,
		);

		expect(resolved.servers.get("pyright")?.initializeTimeoutMs).toBe(1234);
		expect(resolved.servers.get("vtsls")?.initializeTimeoutMs).toBe(5000);
	});
});
