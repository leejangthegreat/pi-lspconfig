/**
 * Workspace root detection.
 *
 * Two strategies, mirroring nvim-lspconfig:
 *  - declarative `rootMarkers`, searched upward from the file's directory
 *  - an async `rootDir` escape hatch supplied by the server spec
 *
 * Results are always clamped to a ceiling (normally the session cwd) so a stray
 * marker in `$HOME` cannot turn the whole home directory into a workspace.
 */

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSameOrWithin, normalizePath } from "./paths.ts";
import type { LspServerSpec, RootCtx } from "../types.ts";

export interface FindRootOptions {
	/** Ordered, highest-priority-first marker filenames. */
	markers: readonly string[];
	/** Do not return anything above this directory. */
	ceiling?: string;
	/**
	 * Accepted for parity with the callers that pass it explicitly; the walk
	 * always terminates at the filesystem root, because `dirname` has no
	 * ancestor above it to offer.
	 */
	stopAtFileSystemRoot?: boolean;
}

/**
 * Walk up from `startDir` looking for a directory containing any marker.
 *
 * Returns the first match, preferring earlier markers over shallower
 * directories (marker priority beats depth, matching nvim-lspconfig).
 */
export async function findRootWithMarkers(
	startDir: string,
	options: FindRootOptions,
): Promise<string | undefined> {
	if (options.markers.length === 0) return undefined;

	const dirs = ancestorDirs(startDir, options.ceiling);
	for (const marker of options.markers) {
		for (const dir of dirs) {
			if (await pathExists(join(dir, marker))) return dir;
		}
	}
	return undefined;
}

/** Find the nearest ancestor containing `.git` (file or directory). */
export function findGitAncestor(startDir: string, ceiling?: string): Promise<string | undefined> {
	return findAncestorWith(startDir, [".git"], ceiling);
}

/** Find the nearest ancestor containing one of `names` (e.g. `node_modules`, `package.json`). */
export async function findAncestorWith(
	startDir: string,
	names: readonly string[],
	ceiling?: string,
): Promise<string | undefined> {
	for (const dir of ancestorDirs(startDir, ceiling)) {
		for (const name of names) {
			if (await pathExists(join(dir, name))) return dir;
		}
	}
	return undefined;
}

/** The parts of a server spec that participate in root detection. */
export interface RootSpec {
	rootDir?: LspServerSpec["rootDir"];
	rootMarkers?: readonly string[];
}

/**
 * Resolve the root for one file against a server spec.
 *
 * Order of precedence: `spec.rootDir` (when present) → `spec.rootMarkers` →
 * `undefined`. Callers fall back to single-file mode when this returns
 * `undefined` and `spec.singleFileSupport` is set.
 *
 * `ctx` carries both the session cwd (which a dynamic `rootDir` may inspect)
 * and the ceiling a detected root may not escape.
 */
export async function resolveRootForFile(
	spec: RootSpec,
	file: string,
	ctx: RootCtx,
): Promise<string | undefined> {
	const ceiling = normalizePath(ctx.ceiling);

	if (typeof spec.rootDir === "function") {
		const resolved = await spec.rootDir(file, ctx);
		if (resolved === undefined) return undefined;
		// A dynamic resolver is trusted to find a root, not to leave the ceiling.
		return isSameOrWithin(resolved, ceiling) ? normalizePath(resolved) : ceiling;
	}

	if (spec.rootMarkers !== undefined && spec.rootMarkers.length > 0) {
		return findRootWithMarkers(dirname(normalizePath(file)), {
			markers: spec.rootMarkers,
			ceiling,
		});
	}

	return undefined;
}

/**
 * Directories to probe, nearest first, ending at `ceiling` (inclusive) or the
 * filesystem root.
 *
 * When `startDir` already sits outside `ceiling` the list is empty: a root may
 * not be detected for a file that is itself out of bounds.
 */
function ancestorDirs(startDir: string, ceiling: string | undefined): string[] {
	const start = normalizePath(startDir);
	const boundary = ceiling === undefined ? undefined : normalizePath(ceiling);

	if (boundary !== undefined && !isSameOrWithin(start, boundary)) return [];

	const dirs: string[] = [];
	let current = start;
	for (;;) {
		dirs.push(current);
		if (boundary !== undefined && current === boundary) break;

		const parent = normalizePath(dirname(current));
		// `dirname` is idempotent at the filesystem root (`/` → `/`), so this is
		// where the walk ends regardless of `stopAtFileSystemRoot`.
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

/** True when `path` exists, as a file or a directory (a `.git` file counts). */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
