import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCeiling, createWorkspaceResolver } from "../../../src/core/workspace.ts";
import type { LspServerSpec } from "../../../src/types.ts";

const HOME = mkdtempSync(join(tmpdir(), "pi-lsp-home-"));
const MONOREPO = join(HOME, "repo");
const PACKAGE = join(MONOREPO, "packages", "foo");
const PACKAGE_FILE = join(PACKAGE, "src", "a.ts");
const OTHER_FILE = join(PACKAGE, "src", "b.ts");

const PLAIN = mkdtempSync(join(tmpdir(), "pi-lsp-plain-"));

beforeAll(() => {
	mkdirSync(join(MONOREPO, ".git"), { recursive: true });
	mkdirSync(join(PACKAGE, "src"), { recursive: true });
	writeFileSync(join(PACKAGE, "tsconfig.json"), "{}");
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(PLAIN, { recursive: true, force: true });
});

describe("computeCeiling", () => {
	it("rises to the enclosing workspace so a monorepo package resolves to the repo root", () => {
		expect(computeCeiling(PACKAGE, HOME)).toBe(MONOREPO);
	});

	it("stays at the cwd when the only marker is the home directory itself", () => {
		// A stray `$HOME/.git` (a dotfiles repo) must not turn all of `$HOME`
		// into one workspace.
		mkdirSync(join(HOME, ".git"), { recursive: true });
		const project = join(HOME, "project");
		mkdirSync(project, { recursive: true });

		expect(computeCeiling(project, HOME)).toBe(project);
		rmSync(join(HOME, ".git"), { recursive: true, force: true });
	});

	it("falls back to the cwd when no marker exists", () => {
		expect(computeCeiling(PLAIN, PLAIN)).toBe(PLAIN);
	});
});

describe("createWorkspaceResolver", () => {
	function countingSpec(onResolve: (file: string) => string | undefined): LspServerSpec {
		return {
			id: "counting",
			cmd: ["counting"],
			filetypes: ["typescript"],
			rootDir: (file) => onResolve(file),
		};
	}

	it("resolves a root and caches it per (serverId, directory)", async () => {
		let calls = 0;
		const resolver = createWorkspaceResolver({ cwd: HOME, homeDir: HOME });
		const spec = countingSpec(() => {
			calls++;
			return MONOREPO;
		});

		const ctx = { cwd: HOME, ceiling: resolver.ceiling };
		expect(await resolver.resolve(spec, PACKAGE_FILE, ctx)).toBe(MONOREPO);
		expect(await resolver.resolve(spec, OTHER_FILE, ctx)).toBe(MONOREPO);
		expect(calls).toBe(1);
	});

	it("drops a directory's cache entry on invalidate(file)", async () => {
		let calls = 0;
		const resolver = createWorkspaceResolver({ cwd: HOME, homeDir: HOME });
		const spec = countingSpec(() => {
			calls++;
			return MONOREPO;
		});
		const ctx = { cwd: HOME, ceiling: resolver.ceiling };

		await resolver.resolve(spec, PACKAGE_FILE, ctx);
		resolver.invalidate(PACKAGE_FILE);
		await resolver.resolve(spec, PACKAGE_FILE, ctx);
		expect(calls).toBe(2);
	});

	it("clears every entry on invalidate()", async () => {
		let calls = 0;
		const resolver = createWorkspaceResolver({ cwd: HOME, homeDir: HOME });
		const spec = countingSpec(() => {
			calls++;
			return MONOREPO;
		});
		const ctx = { cwd: HOME, ceiling: resolver.ceiling };

		await resolver.resolve(spec, PACKAGE_FILE, ctx);
		await resolver.resolve(spec, OTHER_FILE, ctx);
		resolver.invalidate();
		await resolver.resolve(spec, PACKAGE_FILE, ctx);
		expect(calls).toBe(2);
	});

	it("honours an explicit ceiling override", async () => {
		const resolver = createWorkspaceResolver({ cwd: HOME, ceiling: PACKAGE });
		expect(resolver.ceiling).toBe(PACKAGE);

		const spec: LspServerSpec = {
			id: "markers",
			cmd: ["x"],
			filetypes: ["typescript"],
			rootMarkers: ["tsconfig.json"],
		};
		const ctx = { cwd: HOME, ceiling: resolver.ceiling };
		expect(await resolver.resolve(spec, PACKAGE_FILE, ctx)).toBe(PACKAGE);
	});

	it("returns undefined for a file outside the ceiling", async () => {
		const resolver = createWorkspaceResolver({ cwd: MONOREPO, ceiling: PACKAGE });
		const spec: LspServerSpec = {
			id: "markers",
			cmd: ["x"],
			filetypes: ["typescript"],
			rootMarkers: ["tsconfig.json"],
		};
		const ctx = { cwd: MONOREPO, ceiling: resolver.ceiling };
		expect(await resolver.resolve(spec, join(MONOREPO, "outside.ts"), ctx)).toBeUndefined();
	});
});
