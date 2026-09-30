/**
 * Spawning and terminating language server processes.
 *
 * `SpawnFn` is injectable so the fleet can be driven against an in-process
 * fake server without ever touching `child_process`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_SHUTDOWN_GRACE_MS, INHERITED_ENV_ALLOWLIST } from "../../util/defaults.ts";

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

/**
 * Spawn a language server.
 *
 * On POSIX the child is `detached`, making it the leader of a fresh process
 * group. That is what lets {@link killProcessTree} take down the whole tree
 * with a negative-pid signal; see the contract there. Windows has no process
 * groups, so `taskkill /T` is used instead.
 */
export function launchLSP(spec: SpawnSpec): LSPProcess {
	const child = spawn(spec.command, [...spec.args], {
		cwd: spec.cwd,
		env: buildEnv(spec.env),
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});

	let settled = false;
	let resolveExited!: (code: number | null) => void;
	const exited = new Promise<number | null>((resolve) => {
		resolveExited = resolve;
	});
	// `spawn` failures (ENOENT, EACCES) arrive asynchronously as an `error`
	// event. Without a listener the process would throw uncaught, and because
	// `exit` never fires `exited` would never settle — hanging `kill()`.
	const settle = (code: number | null): void => {
		if (settled) return;
		settled = true;
		resolveExited(code);
	};
	child.once("exit", (code) => settle(code));
	child.once("error", () => settle(null));

	let killPromise: Promise<void> | undefined;
	const kill = (graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> => {
		killPromise ??= (async () => {
			if (settled) return;
			const pid = child.pid;
			if (pid === undefined) {
				await exited;
				return;
			}
			killProcessTree(pid, "SIGTERM");
			if (await raceExit(exited, graceMs)) return;
			killProcessTree(pid, "SIGKILL");
			await exited;
		})();
		return killPromise;
	};

	return {
		child,
		pid: child.pid,
		command: spec.command,
		args: spec.args,
		exited,
		kill,
	};
}

/** Default `SpawnFn`, using `node:child_process` with a restricted environment. */
export const defaultSpawn: SpawnFn = launchLSP;

/**
 * Resolve a command to an absolute path by scanning `PATH` directly.
 *
 * Deliberately does not shell out to `which`/`where`: a subprocess here would
 * break the "unit tests never spawn" rule and fail on images without those
 * helpers. On Windows each `PATHEXT` extension is tried, so `.cmd`/`.ps1`
 * shims resolve.
 *
 * Returns `undefined` when the binary is not on `PATH`, which the tool layer
 * surfaces as `status: "binary_missing"` with an install hint.
 */
export async function resolveCommand(command: string): Promise<string | undefined> {
	if (command.length === 0) return undefined;
	if (isAbsolute(command)) return isExecutable(command) ? command : undefined;

	const pathValue = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? windowsExtensions() : [""];
	for (const directory of pathValue.split(delimiter)) {
		if (directory.length === 0) continue;
		for (const extension of extensions) {
			const candidate = join(directory, command + extension);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

/** `PATHEXT` extensions to try on Windows, most specific first. */
function windowsExtensions(): string[] {
	const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	const seen = new Set<string>();
	const extensions: string[] = [];
	for (const entry of raw.split(";")) {
		const normalized = entry.trim().toLowerCase();
		if (normalized.length === 0 || seen.has(normalized)) continue;
		seen.add(normalized);
		extensions.push(normalized);
	}
	return extensions;
}

/** True when `path` is a regular file the current user may execute. */
function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (process.platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill an entire process tree.
 *
 * Servers such as `rust-analyzer` and `jdtls` spawn children; killing only the
 * direct child leaks them. POSIX uses a negative-pid group kill, Windows uses
 * `taskkill /T`.
 *
 * The group kill assumes `pid` leads its own process group — the contract
 * `launchLSP` satisfies by spawning with `detached: true`. When the pid is not
 * a group leader (or is already gone) this falls back to signalling the pid
 * directly, and never throws.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (!Number.isInteger(pid) || pid <= 0) return;

	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => {});
			killer.unref();
		} catch {
			// Best effort: the process may already be gone.
		}
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		try {
			process.kill(pid, signal);
		} catch {
			// Already reaped, or not ours to signal.
		}
	}
}

/** Resolve `true` once `exited` settles, or `false` after `ms` elapse. */
function raceExit(exited: Promise<number | null>, ms: number): Promise<boolean> {
	if (ms <= 0) return exited.then(() => true, () => true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		timer.unref();
		const done = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		exited.then(done, done);
	});
}

/** Build the child environment from the allowlist plus `extra`. */
export function buildEnv(extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of INHERITED_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (extra !== undefined) {
		for (const [key, value] of Object.entries(extra)) env[key] = value;
	}
	return env;
}
