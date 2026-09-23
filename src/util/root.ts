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

export interface FindRootOptions {
	/** Ordered, highest-priority-first marker filenames. */
	markers: readonly string[];
	/** Do not return anything above this directory. */
	ceiling?: string;
	/** Stop the upward walk at the filesystem root (default `true`). */
	stopAtFileSystemRoot?: boolean;
}

/**
 * Walk up from `startDir` looking for a directory containing any marker.
 *
 * Returns the first match, preferring earlier markers over shallower
 * directories (marker priority beats depth, matching nvim-lspconfig).
 */
export function findRootWithMarkers(
	_startDir: string,
	_options: FindRootOptions,
): Promise<string | undefined> {
	throw new Error("Not implemented: findRootWithMarkers");
}

/** Find the nearest ancestor containing `.git` (file or directory). */
export function findGitAncestor(_startDir: string, _ceiling?: string): Promise<string | undefined> {
	throw new Error("Not implemented: findGitAncestor");
}

/** Find the nearest ancestor containing one of `names` (e.g. `node_modules`, `package.json`). */
export function findAncestorWith(
	_startDir: string,
	_names: readonly string[],
	_ceiling?: string,
): Promise<string | undefined> {
	throw new Error("Not implemented: findAncestorWith");
}

/**
 * Resolve the root for one file against a server spec.
 *
 * Order of precedence: `spec.rootDir` (when present) → `spec.rootMarkers` →
 * `undefined`. Callers fall back to single-file mode when this returns
 * `undefined` and `spec.singleFileSupport` is set.
 */
export function resolveRootForFile(
	_spec: { rootDir?: unknown; rootMarkers?: readonly string[] },
	_file: string,
	_ceiling: string,
): Promise<string | undefined> {
	throw new Error("Not implemented: resolveRootForFile");
}
