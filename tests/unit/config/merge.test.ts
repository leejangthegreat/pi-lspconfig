import { describe, expect, it } from "vitest";
import { collectDeletedKeys, deepMerge, isPlainObject } from "../../../src/util/merge.ts";

describe("isPlainObject", () => {
	it("accepts object literals and null-prototype objects", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject({ a: { b: 1 } })).toBe(true);
		expect(isPlainObject(Object.create(null))).toBe(true);
	});

	it("rejects arrays, null, primitives, and non-plain objects", () => {
		const rejected: unknown[] = [
			[],
			null,
			undefined,
			"s",
			1,
			true,
			() => {},
			new Date(),
			/x/,
			new Map(),
			new (class {})(),
		];
		for (const value of rejected) {
			expect(isPlainObject(value)).toBe(false);
		}
	});
});

describe("deepMerge", () => {
	it("does not mutate either input", () => {
		const base = Object.freeze({
			a: Object.freeze({ b: 1, c: 2 }),
			list: Object.freeze([1, 2, 3]),
		});
		const override = Object.freeze({ a: Object.freeze({ c: 3 }), list: Object.freeze([9]) });

		expect(() => deepMerge(base, override)).not.toThrow();
		expect(base).toEqual({ a: { b: 1, c: 2 }, list: [1, 2, 3] });
		expect(override).toEqual({ a: { c: 3 }, list: [9] });
	});

	it("does not alias nested objects from either input", () => {
		const base = { nested: { a: 1 } };
		const override = { other: { b: 2 } };
		const result = deepMerge(base, override) as {
			nested: { a: number };
			other: { b: number };
		};

		result.nested.a = 99;
		result.other.b = 99;

		expect(base.nested.a).toBe(1);
		expect(override.other.b).toBe(2);
	});

	it("merges nested objects and keeps omitted siblings", () => {
		const base = {
			settings: { python: { analysis: { typeCheckingMode: "standard", inlayHints: { variableTypes: true } } } },
			cmd: ["a"],
		};
		const override = { settings: { python: { analysis: { typeCheckingMode: "strict" } } } };

		const result = deepMerge(base, override);

		expect(result.settings.python.analysis.typeCheckingMode).toBe("strict");
		expect(result.settings.python.analysis.inlayHints).toEqual({ variableTypes: true });
		expect(result.cmd).toEqual(["a"]);
	});

	it("replaces arrays wholesale", () => {
		const result = deepMerge({ rootMarkers: ["a", "b", "c", "d"] }, { rootMarkers: ["x", "y"] });
		expect(result.rootMarkers).toEqual(["x", "y"]);
	});

	it("replaces functions by identity and never composes them", () => {
		const baseFn = (value: number) => value + 1;
		const overrideFn = (value: number) => value + 2;

		const result = deepMerge({ fn: baseFn }, { fn: overrideFn });

		expect(result.fn).toBe(overrideFn);
		expect(result.fn).not.toBe(baseFn);
	});

	it("keeps the default for undefined and deletes for null", () => {
		const base = { a: 1, b: 2, nested: { c: 3, d: 4 } };

		const result = deepMerge(base, { a: undefined, b: null, nested: { d: null } });

		expect(result.a).toBe(1);
		expect("b" in result).toBe(false);
		expect(result.nested).toEqual({ c: 3 });
		expect("d" in result.nested).toBe(false);
	});

	it("replaces a non-object base value with a plain-object override", () => {
		const base: Record<string, unknown> = { list: [1, 2], missing: undefined };
		const result = deepMerge(base, { list: { nested: true }, missing: { added: true } });

		expect(result.list).toEqual({ nested: true });
		expect(result.missing).toEqual({ added: true });
	});

	it("returns a fresh deep-equal clone for an empty override", () => {
		const base = { a: { b: 1 } };
		const result = deepMerge(base, {});

		expect(result).toEqual(base);
		expect(result).not.toBe(base);
		expect(result.a).not.toBe(base.a);
	});
});

describe("collectDeletedKeys", () => {
	it("returns an empty list when nothing is deleted", () => {
		expect(collectDeletedKeys({})).toEqual([]);
		expect(collectDeletedKeys({ a: 1, b: { c: 2 } })).toEqual([]);
	});

	it("reports dotted paths for nested deletions", () => {
		expect(collectDeletedKeys({ a: null, b: { c: null, d: 1 } })).toEqual(["a", "b.c"]);
		expect(
			collectDeletedKeys({ settings: { python: { analysis: { inlayHints: null } } } }),
		).toEqual(["settings.python.analysis.inlayHints"]);
	});

	it("does not descend into arrays", () => {
		expect(collectDeletedKeys({ a: [{ b: null }] })).toEqual([]);
	});

	it("ignores undefined, primitives, and functions", () => {
		expect(collectDeletedKeys({ a: undefined, b: 1, c: () => {} })).toEqual([]);
	});
});
