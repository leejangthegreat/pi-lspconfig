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
}

/**
 * Decide how far up the filesystem a root may be detected.
 *
 * Starts at the session cwd. When the cwd sits inside a workspace (a `.git`,
 * `Cargo.toml`, or `go.work` exists above it) the ceiling rises to that
 * workspace so a file in a monorepo package still resolves to the repo root.
 */
export function computeCeiling(_cwd: string): string {
	throw new Error("Not implemented: computeCeiling");
}

export function createWorkspaceResolver(
	_options: CreateWorkspaceResolverOptions,
): WorkspaceResolver {
	throw new Error("Not implemented: createWorkspaceResolver");
}
