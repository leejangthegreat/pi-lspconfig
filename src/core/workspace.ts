/**
 * Workspace root resolution with caching and a ceiling.
 *
 * `util/root.ts` holds the pure upward-walk algorithm; this module adds the two
 * pieces of policy the engine needs:
 *
 *  - **A ceiling.** A detected root may never escape the session working
 *    directory. Without this, a stray `$HOME/.git` turns every file under the
 *    home directory into one enormous workspace.
 *  - **A cache.** Root resolution stats directories, which is cheap but not
 *    free; results are keyed by `(serverId, file directory)` and invalidated
 *    when a project file is created or removed.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSameOrWithin, normalizePath } from "../util/paths.ts";
import { resolveRootForFile } from "../util/root.ts";
import type { LspServerSpec, RootCtx } from "../types.ts";

export interface WorkspaceResolver {
	/** Resolve the root for one file. `undefined` means single-file mode. */
	resolve(spec: LspServerSpec, file: string, ctx: RootCtx): Promise<string | undefined>;
	/** Drop cached entries for one file, or everything when omitted. */
	invalidate(file?: string): void;
	/** The ceiling in force for this resolver. */
	readonly ceiling: string;
}

export interface CreateWorkspaceResolverOptions {
	/** Session working directory. */
	cwd: string;
	/** Override for the ceiling. Defaults to {@link computeCeiling}. */
	ceiling?: string;
	/** Override for `os.homedir()`, primarily for tests. */
	homeDir?: string;
}

/**
 * Markers that identify a workspace for ceiling purposes.
 *
 * `.git` covers most repositories; `Cargo.toml` and `go.work` cover the common
 * cases where a workspace sits above the session cwd without a git checkout.
 */
const WORKSPACE_MARKERS: readonly string[] = [".git", "Cargo.toml", "go.work"];

/**
 * Decide how far up the filesystem a root may be detected.
 *
 * Starts at the session cwd. When the cwd sits inside a workspace (a `.git`,
 * `Cargo.toml`, or `go.work` exists above it) the ceiling rises to that
 * workspace so a file in a monorepo package still resolves to the repo root.
 *
 * The home directory is a hard boundary: a stray `$HOME/.git` must not turn the
 * whole home directory into one workspace, so a marker found at or above
 * `os.homedir()` is ignored and the ceiling stays at the cwd.
 */
export function computeCeiling(cwd: string, homeDir: string = homedir()): string {
	const start = normalizePath(realpathBestEffort(cwd));
	const home = normalizePath(realpathBestEffort(homeDir));

	let current = start;
	for (;;) {
		if (WORKSPACE_MARKERS.some((marker) => existsSync(join(current, marker)))) {
			// `isSameOrWithin(home, current)` is true when `current` is the home
			// directory or one of its ancestors — exactly the cases to reject.
			if (!isSameOrWithin(home, current)) return current;
			return start;
		}

		const parent = normalizePath(dirname(current));
		if (parent === current) return start;
		current = parent;
	}
}

export function createWorkspaceResolver(
	options: CreateWorkspaceResolverOptions,
): WorkspaceResolver {
	const cwd = normalizePath(options.cwd);
	const ceiling = normalizePath(options.ceiling ?? computeCeiling(cwd, options.homeDir));
	const cache = new Map<string, string | undefined>();

	// The resolver owns the ceiling; the caller supplies cwd, which a dynamic
	// `rootDir` may inspect.
	const resolve = async (
		spec: LspServerSpec,
		file: string,
		ctx: RootCtx,
	): Promise<string | undefined> => {
		const normalizedFile = normalizePath(file);
		const directory = dirname(normalizedFile);
		const key = `${spec.id}\0${directory}`;

		if (cache.has(key)) return cache.get(key);

		const root = await resolveRootForFile(spec, normalizedFile, {
			cwd: ctx.cwd,
			ceiling,
		});
		cache.set(key, root);
		return root;
	};

	const invalidate = (file?: string): void => {
		if (file === undefined) {
			cache.clear();
			return;
		}
		const suffix = `\0${dirname(normalizePath(file))}`;
		for (const key of [...cache.keys()]) {
			if (key.endsWith(suffix)) cache.delete(key);
		}
	};

	return { resolve, invalidate, ceiling };
}

/** Resolve symlinks when possible; fall back to the literal path. */
function realpathBestEffort(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
