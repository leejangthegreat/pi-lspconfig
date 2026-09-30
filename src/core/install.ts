/**
 * One-shot installation of a missing language-server binary.
 *
 * Deliberately separate from `client/launch.ts`: that module's contract is a
 * long-lived, streamed LSP process, while an install is a shell line the user
 * opted into via `autoInstall`, run at most once per server with its output
 * captured for the failure note.
 *
 * The runner never throws and never rejects. A failed install is data — the
 * caller turns it into a `binary_missing` envelope with the installer's last
 * words attached.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { DEFAULT_INSTALL_TIMEOUT_MS, DEFAULT_SHUTDOWN_GRACE_MS } from "../util/defaults.ts";
import { killProcessTree } from "./client/launch.ts";

/** Cap on captured installer output. The tail is kept; errors come last. */
export const MAX_INSTALL_OUTPUT_CHARS = 2_048;

export interface InstallSpec {
	/** Shell command, verbatim from the server spec's `installCommand`. */
	command: string;
	/** Working directory: the session cwd, not the workspace root. */
	cwd: string;
	/** Overrides `DEFAULT_INSTALL_TIMEOUT_MS`. */
	timeoutMs?: number;
}

export interface InstallOutcome {
	ok: boolean;
	/** `null` when the child never reported an exit code (spawn error, kill). */
	exitCode: number | null;
	/** Combined stdout+stderr, tail-truncated. Empty when there was none. */
	output: string;
}

/** Injectable installer, for tests and for a host that wants to run its own. */
export type InstallRunner = (spec: InstallSpec) => Promise<InstallOutcome>;

export interface InstallSpawnOptions {
	shell: true;
	cwd: string;
	/**
	 * The full parent environment, deliberately.
	 *
	 * `INHERITED_ENV_ALLOWLIST` exists to hide the agent's environment from a
	 * third-party language server. This is the user's own opt-in shell line and
	 * needs whatever proxy, registry, or toolchain variables their shell has.
	 */
	env: NodeJS.ProcessEnv;
	detached: boolean;
	windowsHide: boolean;
}

/** Injectable process launcher; the real one adds piped stdio. */
export type InstallSpawnFn = (command: string, options: InstallSpawnOptions) => ChildProcess;

const defaultSpawn: InstallSpawnFn = (command, options) =>
	spawn(command, { ...options, stdio: ["ignore", "pipe", "pipe"] });

export interface InstallRunnerDeps {
	/** Injectable launcher, for tests. */
	spawnProcess?: InstallSpawnFn;
}

/**
 * Build an {@link InstallRunner}.
 *
 * `shell: true` is what makes `installCommand` a command line rather than an
 * argv array: `/bin/sh -c` on POSIX, `ComSpec /d /s /c` on Windows. POSIX
 * children lead their own process group so a timeout can take the whole tree
 * down; Windows has no process groups and `killProcessTree` uses `taskkill`.
 */
export function createInstallRunner(deps: InstallRunnerDeps = {}): InstallRunner {
	const spawnProcess = deps.spawnProcess ?? defaultSpawn;

	return async (spec: InstallSpec): Promise<InstallOutcome> => {
		const timeoutMs = spec.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

		let child: ChildProcess;
		try {
			child = spawnProcess(spec.command, {
				shell: true,
				cwd: spec.cwd,
				env: process.env,
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			// A synchronous spawn failure (bad cwd, EACCES on the shell) must be
			// reported like any other failed install, not thrown at the caller.
			return { ok: false, exitCode: null, output: messageOf(error) };
		}

		let output = "";
		const append = (chunk: unknown): void => {
			output = (output + String(chunk)).slice(-MAX_INSTALL_OUTPUT_CHARS);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const { code, timedOut } = await waitForChild(child, timeoutMs);
		if (timedOut) {
			append(`\ninstall timed out after ${timeoutMs}ms`);
		}

		return { ok: !timedOut && code === 0, exitCode: code, output: output.trim() };
	};
}

/**
 * Resolve once the child has exited.
 *
 * `close` rather than `exit`: the exit event can fire before the piped streams
 * have drained, which would truncate the captured error.
 */
function waitForChild(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;

		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			resolve({ code, timedOut });
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
			// If the kill produces no exit event (already reaped, not ours to
			// signal), settle anyway: a stuck install must not hang a tool call.
			killTimer = setTimeout(() => finish(null), DEFAULT_SHUTDOWN_GRACE_MS);
		}, timeoutMs);

		// A spawn failure (ENOENT, EACCES) arrives asynchronously; without a
		// listener it would throw uncaught and `close` would never fire.
		child.once("error", () => finish(null));
		child.once("close", (code) => finish(code));
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
