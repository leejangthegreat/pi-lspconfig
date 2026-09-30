/**
 * `createInstallRunner` — the opt-in auto-install shell runner.
 *
 * No process is spawned: `spawnProcess` is injected and driven by hand, which
 * is also the only way to exercise the timeout without waiting two minutes.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	createInstallRunner,
	MAX_INSTALL_OUTPUT_CHARS,
	type InstallSpawnFn,
} from "../../../src/core/install.ts";

class FakeChild extends EventEmitter {
	pid: number | undefined = 4242;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
}

function asChild(child: FakeChild): ChildProcess {
	return child as unknown as ChildProcess;
}

describe("createInstallRunner", () => {
	it("runs the command in a shell, in the given cwd, and reports success", async () => {
		const child = new FakeChild();
		const calls: { command: string; options: Parameters<InstallSpawnFn>[1] }[] = [];
		const runner = createInstallRunner({
			spawnProcess: (command, options) => {
				calls.push({ command, options });
				queueMicrotask(() => {
					child.stdout.write("installed\n");
					child.emit("close", 0);
				});
				return asChild(child);
			},
		});

		const outcome = await runner({ command: "npm install -g fake", cwd: "/tmp" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("npm install -g fake");
		expect(calls[0]?.options.shell).toBe(true);
		expect(calls[0]?.options.cwd).toBe("/tmp");
		expect(outcome).toEqual({ ok: true, exitCode: 0, output: "installed" });
	});

	it("combines stderr into the output and reports a non-zero exit", async () => {
		const child = new FakeChild();
		const runner = createInstallRunner({
			spawnProcess: () => {
				queueMicrotask(() => {
					child.stderr.write("npm ERR! 404\n");
					child.emit("close", 1);
				});
				return asChild(child);
			},
		});

		const outcome = await runner({ command: "npm install -g fake", cwd: "/tmp" });

		expect(outcome.ok).toBe(false);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.output).toContain("npm ERR! 404");
	});

	it("keeps the tail of oversized output, where the error is", async () => {
		const child = new FakeChild();
		const runner = createInstallRunner({
			spawnProcess: () => {
				queueMicrotask(() => {
					child.stdout.write("x".repeat(MAX_INSTALL_OUTPUT_CHARS * 2));
					child.stdout.write("\nEACCES: permission denied\n");
					child.emit("close", 1);
				});
				return asChild(child);
			},
		});

		const outcome = await runner({ command: "npm install -g fake", cwd: "/tmp" });

		expect(outcome.output.length).toBeLessThanOrEqual(MAX_INSTALL_OUTPUT_CHARS);
		expect(outcome.output).toContain("EACCES: permission denied");
	});

	it("resolves a timed-out install instead of hanging", async () => {
		const child = new FakeChild();
		// A fake with no pid cannot be signalled; the runner must still settle.
		child.pid = undefined;
		const runner = createInstallRunner({
			spawnProcess: () => {
				// The real process would be killed; the fake just goes away late.
				setTimeout(() => child.emit("close", null), 20);
				return asChild(child);
			},
		});

		const outcome = await runner({ command: "sleep 999", cwd: "/tmp", timeoutMs: 5 });

		expect(outcome.ok).toBe(false);
		expect(outcome.exitCode).toBeNull();
		expect(outcome.output).toContain("timed out after 5ms");
	});

	it("reports a synchronous spawn failure without throwing", async () => {
		const runner = createInstallRunner({
			spawnProcess: () => {
				throw new Error("spawn EACCES");
			},
		});

		const outcome = await runner({ command: "false", cwd: "/tmp" });

		expect(outcome.ok).toBe(false);
		expect(outcome.exitCode).toBeNull();
		expect(outcome.output).toContain("spawn EACCES");
	});

	it("reports an asynchronous spawn error without throwing", async () => {
		const child = new FakeChild();
		const runner = createInstallRunner({
			spawnProcess: () => {
				queueMicrotask(() => child.emit("error", new Error("ENOENT")));
				return asChild(child);
			},
		});

		const outcome = await runner({ command: "nope", cwd: "/tmp" });

		expect(outcome.ok).toBe(false);
		expect(outcome.exitCode).toBeNull();
	});
});
