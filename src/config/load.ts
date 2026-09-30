/**
 * Discovery and loading of `pi-lspconfig.config.*` files.
 *
 * Loading happens in `session_start`, never in the extension factory:
 *  - the factory may run with no session at all, and
 *  - the factory always runs *before* project trust is resolved, so
 *    `ctx.isProjectTrusted()` is `false` there.
 *
 * Config files are executable code, and a server spec can name an arbitrary
 * binary to spawn. That is the feature — but it is also why project-scoped
 * files are skipped unless the project is trusted.
 *
 * A validated config is cached by path *and mtime*: a file edited between
 * sessions is re-read, an untouched one is not re-transformed by jiti.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { Jiti } from "jiti";
import type { LspconfigUserConfig } from "../types.ts";
import { deepMerge } from "../util/merge.ts";
import { validateUserConfig } from "./schema.ts";

export type ConfigScope = "global" | "project";

export interface ConfigFileCandidate {
	/** Absolute path to a candidate config file. */
	path: string;
	scope: ConfigScope;
}

export interface ConfigLoadError {
	file: string;
	message: string;
}

export interface LoadedUserConfig {
	/** Merged result of every file that loaded successfully, in precedence order. */
	config: LspconfigUserConfig;
	/** Files that contributed, lowest precedence first. */
	files: string[];
	/**
	 * Existing project-scoped files that were not loaded because the project is
	 * untrusted. At most one per directory, matching what would have loaded.
	 */
	skipped: string[];
	/** Files that existed but failed to load or validate. Loading continues past these. */
	errors: ConfigLoadError[];
}

/** Loads a config file's default export. Injected so unit tests do no I/O. */
export type ConfigModuleLoader = (path: string) => Promise<unknown>;

/** The file metadata the loader needs to decide whether a cache entry is fresh. */
export interface ConfigFileInfo {
	/** Last modification time in milliseconds, as reported by `fs.stat`. */
	mtimeMs: number;
}

/**
 * Probe a candidate path. Returns `undefined` when the file does not exist,
 * which is the common case for most of the twenty candidate locations.
 */
export type ConfigFileProbe = (path: string) => ConfigFileInfo | undefined;

export interface LoadUserConfigOptions {
	/** Session working directory. */
	cwd: string;
	/** Override for `os.homedir()`, primarily for tests. */
	homeDir?: string;
	/** When false, project-scoped candidates are skipped entirely. */
	projectTrusted: boolean;
	/** Ignore the mtime cache and re-read every candidate. */
	force?: boolean;
	/** Override the module loader. Defaults to jiti. */
	loadModule?: ConfigModuleLoader;
	/** Override the filesystem probe. Defaults to `fs.statSync`. */
	probeFile?: ConfigFileProbe;
}

/** Recognised config file basenames, in the order they are probed. */
export const CONFIG_BASENAMES: readonly string[] = [
	"pi-lspconfig.config.ts",
	"pi-lspconfig.config.mts",
	"pi-lspconfig.config.js",
	"pi-lspconfig.config.mjs",
	"pi-lspconfig.config.cjs",
];

/**
 * Basenames probed inside the XDG directory `<home>/.config/pi-lspconfig/`.
 *
 * The directory already names the tool, so a bare `config.<ext>` is used there
 * rather than the fully-qualified `pi-lspconfig.config.<ext>`.
 */
export const XDG_CONFIG_BASENAMES: readonly string[] = [
	"config.ts",
	"config.mts",
	"config.js",
	"config.mjs",
	"config.cjs",
];

/**
 * Candidate config locations, lowest precedence first.
 *
 * ```
 * <home>/.config/pi-lspconfig/config.<ext>   global
 * <home>/.pi/pi-lspconfig.config.<ext>       global
 * <cwd>/pi-lspconfig.config.<ext>            project
 * <cwd>/.pi/pi-lspconfig.config.<ext>        project
 * ```
 *
 * Project candidates are still returned when `projectTrusted` is false; the
 * caller filters them so it can report what was skipped.
 */
export function configFileCandidates(cwd: string, homeDir: string): ConfigFileCandidate[] {
	const candidates: ConfigFileCandidate[] = [];

	const push = (dir: string, scope: ConfigScope, basenames: readonly string[]): void => {
		for (const basename of basenames) {
			candidates.push({ path: join(dir, basename), scope });
		}
	};

	push(join(homeDir, ".config", "pi-lspconfig"), "global", XDG_CONFIG_BASENAMES);
	push(join(homeDir, ".pi"), "global", CONFIG_BASENAMES);
	push(cwd, "project", CONFIG_BASENAMES);
	push(join(cwd, ".pi"), "project", CONFIG_BASENAMES);

	return candidates;
}

/** A validated config plus the mtime it was read at. */
interface CachedConfig {
	mtimeMs: number;
	config: LspconfigUserConfig;
}

/** Validated configs by resolved path. Cleared by {@link invalidateConfigCache}. */
const configCache = new Map<string, CachedConfig>();

/** Lazy jiti instance. Recreated after invalidation to drop its module cache. */
let jiti: Jiti | undefined;

/** The package entry point, so a config may `import { defineConfig } from "pi-lspconfig"`. */
const PACKAGE_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

function getJiti(): Jiti {
	jiti ??= createJiti(import.meta.url, {
		// Re-read source on every import; `configCache` is the only memo. Without
		// this, `force` and `invalidateConfigCache` would still return jiti's
		// cached module and an edited config would never take effect.
		moduleCache: false,
		// Config loads are rare, so skip jiti's filesystem transform cache and
		// keep loading side-effect free.
		fsCache: false,
		alias: { "pi-lspconfig": PACKAGE_ENTRY },
	});
	return jiti;
}

async function defaultLoadModule(path: string): Promise<unknown> {
	return getJiti().import(path, { default: true });
}

function defaultProbeFile(path: string): ConfigFileInfo | undefined {
	try {
		return { mtimeMs: statSync(path).mtimeMs };
	} catch {
		return undefined;
	}
}

/**
 * Drop every cached config module and mtime entry.
 *
 * The mtime cache already re-reads an edited file at the next load, so this is
 * the escape hatch for "re-read everything": used by tests, and safe to call
 * from anywhere because it cannot throw.
 */
export function invalidateConfigCache(): void {
	configCache.clear();
	jiti = undefined;
}

/**
 * Discover, load, validate, and merge every applicable config file.
 *
 * Individual failures are collected into `errors` rather than thrown, so a
 * broken project config cannot prevent the session from starting.
 *
 * At most one file per directory is loaded: the first existing basename in
 * probe order wins, and a broken `.ts` does not fall through to a sibling
 * `.js`.
 */
export async function loadUserConfig(options: LoadUserConfigOptions): Promise<LoadedUserConfig> {
	const { cwd, projectTrusted, force = false } = options;
	const homeDir = options.homeDir ?? homedir();
	const loadModule = options.loadModule ?? defaultLoadModule;
	const probeFile = options.probeFile ?? defaultProbeFile;

	const files: string[] = [];
	const skipped: string[] = [];
	const errors: ConfigLoadError[] = [];
	const selectedDirs = new Set<string>();
	let merged: LspconfigUserConfig = {};

	for (const candidate of configFileCandidates(cwd, homeDir)) {
		const dir = dirname(candidate.path);
		if (selectedDirs.has(dir)) continue;

		const info = probeFile(candidate.path);
		if (info === undefined) continue;
		selectedDirs.add(dir);

		// The file exists but must not be read; report it so the user can see
		// why their project config had no effect.
		if (candidate.scope === "project" && !projectTrusted) {
			skipped.push(candidate.path);
			continue;
		}

		const cached = force ? undefined : configCache.get(candidate.path);
		let config = cached !== undefined && cached.mtimeMs === info.mtimeMs ? cached.config : undefined;

		if (config === undefined) {
			let raw: unknown;
			try {
				raw = await loadModule(candidate.path);
			} catch (error) {
				configCache.delete(candidate.path);
				errors.push({ file: candidate.path, message: errorMessage(error) });
				continue;
			}

			const validated = validateUserConfig(raw);
			if (!validated.ok) {
				configCache.delete(candidate.path);
				errors.push({ file: candidate.path, message: validated.errors.join("; ") });
				continue;
			}

			config = validated.config;
			configCache.set(candidate.path, { mtimeMs: info.mtimeMs, config });
		}

		files.push(candidate.path);
		merged = deepMerge(merged, config);
	}

	return { config: merged, files, skipped, errors };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
