/**
 * Spawning and terminating language server processes.
 *
 * `SpawnFn` is injectable so the fleet can be driven against an in-process
 * fake server without ever touching `child_process`.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface SpawnSpec {
	/** Executable, already resolved (may be an absolute path). */
	command: string;
	args: readonly string[];
	/** Working directory. Normally the resolved workspace root, or `ctx.cwd`. */
	cwd: string;
	/** Extra environment variables, merged over the inherited allowlist. */
	env?: Readonly<Record<string, string>>;
}

/** A live language server process plus the streams the JSON-RPC connection reads. */
export interface LSPProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly pid: number | undefined;
	readonly command: string;
	readonly args: readonly string[];
	/** Resolves with the exit code once the process is gone. */
	readonly exited: Promise<number | null>;
	/**
	 * Terminate the process tree: SIGTERM, then SIGKILL after `graceMs`.
	 * Idempotent — repeated calls await the same teardown.
	 */
	kill(graceMs?: number): Promise<void>;
}

/** Injectable process launcher. */
export type SpawnFn = (spec: SpawnSpec) => LSPProcess;

/** Spawn a language server. Resolves `~`/relative commands against `PATH`. */
export function launchLSP(_spec: SpawnSpec): LSPProcess {
	throw new Error("Not implemented: launchLSP");
}

/** Default `SpawnFn`, using `node:child_process` with a restricted environment. */
export const defaultSpawn: SpawnFn = () => {
	throw new Error("Not implemented: defaultSpawn");
};

/**
 * Resolve a command to an absolute path using `which` (POSIX) / `where`
 * (Windows), honouring `.cmd`/`.ps1` shims.
 *
 * Returns `undefined` when the binary is not on `PATH`, which the tool layer
 * surfaces as `status: "binary_missing"` with an install hint.
 */
export function resolveCommand(_command: string): Promise<string | undefined> {
	throw new Error("Not implemented: resolveCommand");
}

/**
 * Kill an entire process tree.
 *
 * Servers such as `rust-analyzer` and `jdtls` spawn children; killing only the
 * direct child leaks them. POSIX uses a negative-pid group kill, Windows uses
 * `taskkill /T`.
 */
export function killProcessTree(_pid: number, _signal: NodeJS.Signals): void {
	throw new Error("Not implemented: killProcessTree");
}
