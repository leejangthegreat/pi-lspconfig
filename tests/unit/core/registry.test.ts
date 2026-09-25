import { describe, expect, it } from "vitest";
import {
	createServerResolver,
	detectLanguageId,
	extensionOf,
} from "../../../src/core/registry.ts";
import { EXTENSION_TO_LANGUAGE_ID } from "../../../src/languages/index.ts";
import type { LspServerSpec } from "../../../src/types.ts";

const LANGUAGE_IDS = new Map(Object.entries(EXTENSION_TO_LANGUAGE_ID));

describe("extensionOf", () => {
	it("returns the last lower-cased extension", () => {
		expect(extensionOf("a.ts")).toBe(".ts");
		expect(extensionOf("foo.test.ts")).toBe(".ts");
		expect(extensionOf("archive.tar.gz")).toBe(".gz");
		expect(extensionOf("A.TS")).toBe(".ts");
	});

	it("handles both path separators", () => {
		expect(extensionOf("/repo/src/a.ts")).toBe(".ts");
		expect(extensionOf("C:\\repo\\src\\a.ts")).toBe(".ts");
	});

	it("returns undefined for extensionless names and dotfiles", () => {
		expect(extensionOf("Makefile")).toBeUndefined();
		expect(extensionOf(".gitignore")).toBeUndefined();
		expect(extensionOf("a")).toBeUndefined();
	});
});

describe("detectLanguageId", () => {
	it("uses the last dot so multi-dot names still resolve", () => {
		expect(detectLanguageId("foo.test.ts", LANGUAGE_IDS)).toBe("typescript");
		expect(detectLanguageId("component.tsx", LANGUAGE_IDS)).toBe("typescriptreact");
		expect(detectLanguageId("main.rs", LANGUAGE_IDS)).toBe("rust");
	});

	it("does not misdetect an unregistered extension", () => {
		expect(detectLanguageId("package.json", LANGUAGE_IDS)).toBeUndefined();
		expect(detectLanguageId("Cargo.lock", LANGUAGE_IDS)).toBeUndefined();
	});

	it("falls back to well-known extensionless filenames", () => {
		expect(detectLanguageId("Dockerfile", LANGUAGE_IDS)).toBe("dockerfile");
		expect(detectLanguageId("Makefile", LANGUAGE_IDS)).toBe("makefile");
	});

	it("returns undefined for a dotfile", () => {
		expect(detectLanguageId(".gitignore", LANGUAGE_IDS)).toBeUndefined();
	});

	it("honours a user override", () => {
		const overridden = new Map(LANGUAGE_IDS);
		overridden.set(".mts", "custom");
		expect(detectLanguageId("a.mts", overridden)).toBe("custom");
	});
});

describe("createServerResolver", () => {
	const a: LspServerSpec = { id: "a", cmd: ["a"], filetypes: ["typescript"] };
	const b: LspServerSpec = { id: "b", cmd: ["b"], filetypes: ["typescript", "python"] };
	const c: LspServerSpec = { id: "c", cmd: ["c"], filetypes: ["python"] };
	const servers = new Map([
		["a", a],
		["b", b],
		["c", c],
	]);

	it("returns every server for a language in table order", () => {
		const resolver = createServerResolver({ servers, languageIds: LANGUAGE_IDS });
		expect(resolver.serversFor("x.ts").map((spec) => spec.id)).toEqual(["a", "b"]);
		expect(resolver.serversFor("x.py").map((spec) => spec.id)).toEqual(["b", "c"]);
	});

	it("resolves to the first server that handles the language", () => {
		const resolver = createServerResolver({ servers, languageIds: LANGUAGE_IDS });
		expect(resolver.resolve("x.ts")?.server.id).toBe("a");
		expect(resolver.resolve("x.py")?.server.id).toBe("b");
		expect(resolver.resolve("x.ts")?.languageId).toBe("typescript");
	});

	it("returns undefined for an unhandled extension", () => {
		const resolver = createServerResolver({ servers, languageIds: LANGUAGE_IDS });
		expect(resolver.resolve("x.unknown")).toBeUndefined();
		expect(resolver.serversFor("x.unknown")).toEqual([]);
	});

	it("omits disabled servers from selection and from all()", () => {
		const resolver = createServerResolver({
			servers,
			languageIds: LANGUAGE_IDS,
			disabled: new Set(["a"]),
		});
		expect(resolver.resolve("x.ts")?.server.id).toBe("b");
		expect(resolver.all().map((spec) => spec.id)).toEqual(["b", "c"]);
	});
});
