import { describe, expect, it } from "vitest";
import { diagnosticResults } from "../../../src/core/results.ts";
import type { Diagnostic } from "../../../src/protocol.ts";

/** A wire diagnostic with a 0-based range. */
function wire(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return {
		range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
		message: "boom",
		...overrides,
	};
}

describe("diagnosticResults", () => {
	it("converts the 0-based wire range to 1-based positions", () => {
		const [result] = diagnosticResults([wire()], "/repo/a.ts");

		expect(result).toEqual({
			path: "/repo/a.ts",
			line: 3,
			character: 5,
			severity: "error",
			message: "boom",
		});
	});

	it("labels every severity, defaulting a missing one to error", () => {
		const severities = diagnosticResults(
			[
				wire({ severity: 1 }),
				wire({ severity: 2 }),
				wire({ severity: 3 }),
				wire({ severity: 4 }),
				wire(),
			],
			"/repo/a.ts",
		).map((diagnostic) => diagnostic.severity);

		expect(severities).toEqual(["error", "warning", "information", "hint", "error"]);
	});

	it("stringifies a numeric code and keeps the source", () => {
		const [result] = diagnosticResults([wire({ code: 2322, source: "ts" })], "/repo/a.ts");

		expect(result?.code).toBe("2322");
		expect(result?.source).toBe("ts");
	});

	it("omits absent optional fields rather than setting them undefined", () => {
		const [result] = diagnosticResults([wire()], "/repo/a.ts");

		expect(result).not.toHaveProperty("code");
		expect(result).not.toHaveProperty("source");
	});

	it("returns an empty list for no diagnostics", () => {
		expect(diagnosticResults([], "/repo/a.ts")).toEqual([]);
	});
});
