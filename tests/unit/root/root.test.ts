import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findAncestorWith,
	findGitAncestor,
	findRootWithMarkers,
	resolveRootForFile,
} from "../../../src/util/root.ts";

const BASE = mkdtempSync(join(tmpdir(), "pi-lsp-root-"));

const REPO = join(BASE, "repo");
const PACKAGE = join(REPO, "packages", "foo");
const SOURCE_DIR = join(PACKAGE, "src");
const SOURCE_FILE = join(SOURCE_DIR, "a.ts");

const GIT_DIR_PROJECT = join(BASE, "gitdir");
const GIT_FILE_PROJECT = join(BASE, "gitfile");

beforeAll(() => {
	mkdirSync(join(REPO, ".git"), { recursive: true });
	writeFileSync(join(REPO, "tsconfig.json"), "{}");
	writeFileSync(join(REPO, "package.json"), "{}");

	mkdirSync(SOURCE_DIR, { recursive: true });
	writeFileSync(join(PACKAGE, "package.json"), "{}");

	mkdirSync(join(GIT_DIR_PROJECT, ".git"), { recursive: true });
	mkdirSync(join(GIT_FILE_PROJECT, "sub"), { recursive: true });
	// A worktree/submodule checkout has `.git` as a *file*, not a directory.
	writeFileSync(join(GIT_FILE_PROJECT, ".git"), "gitdir: ../elsewhere\n");
});

afterAll(() => {
	rmSync(BASE, { recursive: true, force: true });
});

describe("findRootWithMarkers", () => {
	it("prefers a higher-priority marker over a closer lower-priority one", async () => {
		// `package.json` sits in the file's own package; `tsconfig.json` is two
		// levels up at the repo root. Priority wins over depth.
		const root = await findRootWithMarkers(SOURCE_DIR, {
			markers: ["tsconfig.json", "package.json"],
			ceiling: BASE,
		});
		expect(root).toBe(REPO);
	});

	it("takes the nearer directory when the marker order is reversed", async () => {
		const root = await findRootWithMarkers(SOURCE_DIR, {
			markers: ["package.json", "tsconfig.json"],
			ceiling: BASE,
		});
		expect(root).toBe(PACKAGE);
	});

	it("stops at the ceiling and returns undefined when the marker is above it", async () => {
		const root = await findRootWithMarkers(SOURCE_DIR, {
			markers: ["tsconfig.json"],
			ceiling: PACKAGE,
		});
		expect(root).toBeUndefined();
	});

	it("returns undefined when the start directory is outside the ceiling", async () => {
		const root = await findRootWithMarkers(REPO, {
			markers: ["package.json"],
			ceiling: PACKAGE,
		});
		expect(root).toBeUndefined();
	});

	it("returns undefined for an empty marker list", async () => {
		expect(await findRootWithMarkers(SOURCE_DIR, { markers: [], ceiling: BASE })).toBeUndefined();
	});
});

describe("findAncestorWith / findGitAncestor", () => {
	it("returns the nearest ancestor containing any name", async () => {
		expect(await findAncestorWith(SOURCE_DIR, ["package.json"], BASE)).toBe(PACKAGE);
	});

	it("recognises a `.git` directory", async () => {
		expect(await findGitAncestor(join(GIT_DIR_PROJECT, "deep"), BASE)).toBe(GIT_DIR_PROJECT);
	});

	it("recognises a `.git` file", async () => {
		expect(await findGitAncestor(join(GIT_FILE_PROJECT, "sub"), BASE)).toBe(GIT_FILE_PROJECT);
	});
});

describe("resolveRootForFile", () => {
	it("uses rootMarkers when there is no rootDir", async () => {
		const root = await resolveRootForFile(
			{ rootMarkers: ["tsconfig.json", "package.json"] },
			SOURCE_FILE,
			{ cwd: BASE, ceiling: BASE },
		);
		expect(root).toBe(REPO);
	});

	it("prefers a dynamic rootDir over rootMarkers", async () => {
		const root = await resolveRootForFile(
			{ rootDir: () => PACKAGE, rootMarkers: ["tsconfig.json"] },
			SOURCE_FILE,
			{ cwd: BASE, ceiling: BASE },
		);
		expect(root).toBe(PACKAGE);
	});

	it("clamps a dynamic rootDir that escapes the ceiling", async () => {
		const root = await resolveRootForFile({ rootDir: () => "/" }, SOURCE_FILE, {
			cwd: BASE,
			ceiling: REPO,
		});
		expect(root).toBe(REPO);
	});

	it("returns undefined when rootDir declines", async () => {
		expect(
			await resolveRootForFile({ rootDir: () => undefined }, SOURCE_FILE, {
				cwd: BASE,
				ceiling: BASE,
			}),
		).toBeUndefined();
	});

	it("returns undefined when the spec has no root strategy", async () => {
		expect(
			await resolveRootForFile({}, SOURCE_FILE, { cwd: BASE, ceiling: BASE }),
		).toBeUndefined();
	});
});
