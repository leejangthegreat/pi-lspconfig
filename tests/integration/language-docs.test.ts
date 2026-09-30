/**
 * The docs generator as a CLI: jiti loading, file writing, idempotency.
 *
 * Spawns `node scripts/gen-language-docs.mjs`, which makes this an integration
 * test. The child is awaited to exit, so no PID survives the test; nothing is
 * written inside the repository — the output goes to a temp directory and is
 * compared with the checked-in file to catch drift.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const SCRIPT = join(REPO_ROOT, "scripts", "gen-language-docs.mjs");
const CHECKED_IN = join(REPO_ROOT, "docs", "languages.md");

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-lsp-docs-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("gen-language-docs.mjs", () => {
	it("writes the same bytes on every run and matches the checked-in file", async () => {
		const first = join(dir, "first.md");
		const second = join(dir, "second.md");

		await execFileAsync(process.execPath, [SCRIPT, "--out", first]);
		await execFileAsync(process.execPath, [SCRIPT, "--out", second]);

		const generated = readFileSync(first, "utf8");
		expect(readFileSync(second, "utf8")).toBe(generated);
		expect(readFileSync(CHECKED_IN, "utf8")).toBe(generated);
	});

	it("rejects an unknown argument", async () => {
		await expect(execFileAsync(process.execPath, [SCRIPT, "--nope"])).rejects.toThrow();
	});
});
