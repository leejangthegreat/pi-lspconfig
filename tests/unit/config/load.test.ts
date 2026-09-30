import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_BASENAMES,
	configFileCandidates,
	invalidateConfigCache,
	loadUserConfig,
	XDG_CONFIG_BASENAMES,
} from "../../../src/config/load.ts";
import { resolveConfig } from "../../../src/config/resolve.ts";
import { BUILTIN_SERVERS } from "../../../src/languages/index.ts";

const CWD = "/proj";
const HOME = "/home/u";

const modules = new Map<string, unknown>();
const existing = new Set<string>();
const mtimes = new Map<string, number>();
const loadModule = vi.fn(async (path: string) => modules.get(path));
/** Probe double: `existing` decides existence, `mtimes` the modification time. */
const probeFile = (path: string) => (existing.has(path) ? { mtimeMs: mtimes.get(path) ?? 1 } : undefined);

const projectFile = (basename = "pi-lspconfig.config.ts") => join(CWD, basename);
const xdgFile = (basename = "config.ts") => join(HOME, ".config", "pi-lspconfig", basename);
const homePiFile = (basename = "pi-lspconfig.config.ts") => join(HOME, ".pi", basename);
const cwdPiFile = (basename = "pi-lspconfig.config.ts") => join(CWD, ".pi", basename);

const load = (overrides: Partial<Parameters<typeof loadUserConfig>[0]> = {}) =>
	loadUserConfig({ cwd: CWD, homeDir: HOME, projectTrusted: true, loadModule, probeFile, ...overrides });

beforeEach(() => {
	modules.clear();
	existing.clear();
	mtimes.clear();
	loadModule.mockClear();
	invalidateConfigCache();
});

describe("configFileCandidates", () => {
	it("returns every candidate lowest precedence first", () => {
		const expected = [
			...XDG_CONFIG_BASENAMES.map((basename) => ({
				path: join(HOME, ".config", "pi-lspconfig", basename),
				scope: "global" as const,
			})),
			...CONFIG_BASENAMES.map((basename) => ({
				path: join(HOME, ".pi", basename),
				scope: "global" as const,
			})),
			...CONFIG_BASENAMES.map((basename) => ({
				path: join(CWD, basename),
				scope: "project" as const,
			})),
			...CONFIG_BASENAMES.map((basename) => ({
				path: join(CWD, ".pi", basename),
				scope: "project" as const,
			})),
		];

		expect(configFileCandidates(CWD, HOME)).toEqual(expected);
	});
});

describe("loadUserConfig", () => {
	it("returns an empty result when no candidate exists", async () => {
		const loaded = await load();

		expect(loaded).toEqual({ config: {}, files: [], skipped: [], errors: [] });
		expect(loadModule).not.toHaveBeenCalled();
	});

	it("loads a trusted project file", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, { languageIds: { ".vue": "vue" } });

		const loaded = await load();

		expect(loaded.files).toEqual([path]);
		expect(loaded.config).toEqual({ languageIds: { ".vue": "vue" } });
	});

	it("skips project files when the project is untrusted", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, { disabledServers: ["gopls"] });

		const loaded = await load({ projectTrusted: false });

		expect(loaded.files).toEqual([]);
		expect(loaded.skipped).toEqual([path]);
		expect(loadModule).not.toHaveBeenCalled();
	});

	it("reports one skipped file per directory, matching what would have loaded", async () => {
		const root = projectFile();
		const sibling = projectFile("pi-lspconfig.config.js");
		const nested = cwdPiFile();
		existing.add(root);
		existing.add(sibling);
		existing.add(nested);

		const loaded = await load({ projectTrusted: false });

		expect(loaded.skipped).toEqual([root, nested]);
		expect(loadModule).not.toHaveBeenCalled();
	});

	it("does not report a global file as skipped when untrusted", async () => {
		const path = xdgFile();
		existing.add(path);
		modules.set(path, { disabledServers: ["gopls"] });

		const loaded = await load({ projectTrusted: false });

		expect(loaded.skipped).toEqual([]);
		expect(loaded.files).toEqual([path]);
	});

	it("loads global files even when the project is untrusted", async () => {
		const path = xdgFile();
		existing.add(path);
		modules.set(path, { disabledServers: ["gopls"] });

		const loaded = await load({ projectTrusted: false });

		expect(loaded.files).toEqual([path]);
	});

	it("loads only the first existing basename per directory", async () => {
		const ts = projectFile("pi-lspconfig.config.ts");
		const js = projectFile("pi-lspconfig.config.js");
		existing.add(ts);
		existing.add(js);
		modules.set(ts, { languageIds: { ".a": "a" } });
		modules.set(js, { languageIds: { ".b": "b" } });

		const loaded = await load();

		expect(loaded.files).toEqual([ts]);
		expect(loadModule).toHaveBeenCalledTimes(1);
		expect(loadModule).toHaveBeenCalledWith(ts);
	});

	it("lets a project file override a global file", async () => {
		const global = xdgFile();
		const project = projectFile();
		existing.add(global);
		existing.add(project);
		modules.set(global, { defaults: { maxResults: 10 }, languageIds: { ".a": "global" } });
		modules.set(project, { defaults: { maxResults: 20 }, languageIds: { ".b": "project" } });

		const loaded = await load();

		expect(loaded.files).toEqual([global, project]);
		expect(loaded.config.defaults).toEqual({ maxResults: 20 });
		expect(loaded.config.languageIds).toEqual({ ".a": "global", ".b": "project" });
	});

	it("deep-merges servers and replaces disabledServers across files", async () => {
		const global = xdgFile();
		const project = projectFile();
		existing.add(global);
		existing.add(project);
		modules.set(global, {
			servers: { pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } } },
			disabledServers: ["gopls"],
		});
		modules.set(project, {
			servers: { pyright: { settings: { python: { analysis: { autoSearchPaths: false } } } } },
			disabledServers: ["rust-analyzer"],
		});

		const loaded = await load();

		expect(loaded.config.servers?.pyright?.settings).toEqual({
			python: { analysis: { typeCheckingMode: "strict", autoSearchPaths: false } },
		});
		expect(loaded.config.disabledServers).toEqual(["rust-analyzer"]);
	});

	it("collects a validation error and keeps loading other files", async () => {
		const global = xdgFile();
		const project = projectFile();
		existing.add(global);
		existing.add(project);
		modules.set(global, { languageIds: { ".a": "a" } });
		modules.set(project, { servers: { pyright: { cmd: "pyright-langserver" } } });

		const loaded = await load();

		expect(loaded.files).toEqual([global]);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]?.file).toBe(project);
		expect(loaded.errors[0]?.message).toContain("cmd");
	});

	it("collects a loader failure without throwing", async () => {
		const path = projectFile();
		existing.add(path);
		const throwing = vi.fn(async () => {
			throw new Error("boom");
		});

		const loaded = await load({ loadModule: throwing });

		expect(loaded.files).toEqual([]);
		expect(loaded.errors).toEqual([{ file: path, message: "boom" }]);
	});

	it("produces a ServerTable containing every built-in", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, {
			servers: { pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } } },
		});

		const loaded = await load();
		const resolved = resolveConfig(loaded.config, BUILTIN_SERVERS);

		expect(resolved.servers.size).toBe(BUILTIN_SERVERS.length);
	});

	it("caches a successful load until invalidated", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, { languageIds: { ".a": "a" } });

		await load();
		await load();

		expect(loadModule).toHaveBeenCalledTimes(1);
	});

	it("re-reads a file whose mtime changed, and only that file", async () => {
		const global = xdgFile();
		const project = projectFile();
		existing.add(global);
		existing.add(project);
		modules.set(global, { defaults: { maxResults: 10 } });
		modules.set(project, { languageIds: { ".a": "a" } });

		await load();
		expect(loadModule).toHaveBeenCalledTimes(2); // global + project

		// A newer mtime on the project file invalidates only its cache entry.
		modules.set(project, { languageIds: { ".b": "b" } });
		mtimes.set(project, 2);

		const loaded = await load();

		expect(loadModule).toHaveBeenCalledTimes(3);
		expect(loadModule).toHaveBeenLastCalledWith(project);
		expect(loaded.config.languageIds).toEqual({ ".b": "b" });
		expect(loaded.config.defaults).toEqual({ maxResults: 10 });
	});

	it("reuses the cache while the mtime is unchanged", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, { defaults: { maxResults: 10 } });

		await load();
		// Different content under the same mtime must not be observed: the file
		// was not rewritten as far as the filesystem is concerned.
		modules.set(path, { defaults: { maxResults: 20 } });
		const loaded = await load();

		expect(loadModule).toHaveBeenCalledTimes(1);
		expect(loaded.config.defaults).toEqual({ maxResults: 10 });
	});

	it("re-reads on force and after invalidateConfigCache", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, { languageIds: { ".a": "a" } });

		await load();
		await load({ force: true });
		expect(loadModule).toHaveBeenCalledTimes(2);

		invalidateConfigCache();
		await load();
		expect(loadModule).toHaveBeenCalledTimes(3);
	});

	it("does not cache a failed load", async () => {
		const path = projectFile();
		existing.add(path);
		modules.set(path, { servers: { pyright: { cmd: "bad" } } });

		await load();
		await load();

		expect(loadModule).toHaveBeenCalledTimes(2);
	});

	it("loads a shared directory once when cwd equals homeDir", async () => {
		const shared = cwdPiFile();
		existing.add(shared);
		modules.set(shared, { languageIds: { ".a": "a" } });

		const loaded = await load({ homeDir: CWD });

		expect(loadModule).toHaveBeenCalledTimes(1);
		expect(loaded.files).toEqual([shared]);
	});

	it("uses the home .pi directory candidate", async () => {
		const path = homePiFile();
		existing.add(path);
		modules.set(path, { languageIds: { ".a": "a" } });

		const loaded = await load();

		expect(loaded.files).toEqual([path]);
	});
});
