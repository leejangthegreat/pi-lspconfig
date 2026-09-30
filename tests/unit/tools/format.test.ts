import { describe, expect, it } from "vitest";
import {
	DEFAULT_TRUNCATION_HINT,
	NARROW_RESULTS_HINT,
	RESULT_MAX_LINES,
	capResults,
	createEnvelope,
	filterDiagnostics,
	renderDiagnostics,
	renderEnvelope,
	renderLocations,
	severityRank,
	sortDiagnostics,
	sortLocations,
	truncateForModel,
} from "../../../src/tools/format.ts";
import type { LspDiagnostic, LspLocation } from "../../../src/types.ts";

function location(overrides: Partial<LspLocation> = {}): LspLocation {
	return { path: "/repo/src/a.ts", line: 1, character: 1, ...overrides };
}

function diagnostic(overrides: Partial<LspDiagnostic> = {}): LspDiagnostic {
	return {
		path: "/repo/src/a.ts",
		line: 1,
		character: 1,
		severity: "error",
		message: "boom",
		...overrides,
	};
}

describe("createEnvelope", () => {
	it("fills in the defaults", () => {
		expect(createEnvelope("definition", "success")).toEqual({
			operation: "definition",
			ok: true,
			status: "success",
			resultCount: 0,
		});
	});

	it("treats empty as ok and every failure as not ok", () => {
		expect(createEnvelope("x", "empty").ok).toBe(true);
		expect(createEnvelope("x", "binary_missing").ok).toBe(false);
		expect(createEnvelope("x", "error").ok).toBe(false);
	});

	it("does not let the partial override operation, status, or ok", () => {
		const envelope = createEnvelope("definition", "empty", {
			operation: "hover",
			status: "success",
			ok: false,
			resultCount: 7,
		});

		expect(envelope).toMatchObject({
			operation: "definition",
			status: "empty",
			ok: true,
			resultCount: 7,
		});
	});
});

describe("sortLocations", () => {
	it("orders by path, then line, then character, without mutating the input", () => {
		const input = [
			location({ path: "/b.ts" }),
			location({ path: "/a.ts", line: 9 }),
			location({ path: "/a.ts", line: 2, character: 5 }),
			location({ path: "/a.ts", line: 2, character: 1 }),
		];

		const sorted = sortLocations(input).map((l) => `${l.path}:${l.line}:${l.character}`);

		expect(sorted).toEqual(["/a.ts:2:1", "/a.ts:2:5", "/a.ts:9:1", "/b.ts:1:1"]);
		expect(input[0]?.path).toBe("/b.ts");
	});
});

describe("capResults", () => {
	it("reports the pre-cap total", () => {
		expect(capResults([1, 2, 3], 5)).toEqual({ items: [1, 2, 3], truncated: false, total: 3 });
		expect(capResults([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: true, total: 3 });
	});

	it("never caps below one", () => {
		expect(capResults([1, 2, 3], 0)).toEqual({ items: [1], truncated: true, total: 3 });
	});
});

describe("renderLocations", () => {
	it("renders sorted, cwd-relative, one line per location", () => {
		const text = renderLocations(
			[location({ line: 4, character: 5 }), location({ line: 2, character: 1 })],
			"/repo",
		);

		expect(text).toBe("src/a.ts:2:1\nsrc/a.ts:4:5");
	});

	it("keeps a path outside the cwd absolute", () => {
		expect(renderLocations([location({ path: "/elsewhere/b.ts" })], "/repo")).toBe(
			"/elsewhere/b.ts:1:1",
		);
	});

	it("keeps a collapsed preview on the same line", () => {
		expect(renderLocations([location({ preview: "export const\n   x = 1;" })], "/repo")).toBe(
			"src/a.ts:1:1  export const x = 1;",
		);
	});

	it("renders nothing for no locations", () => {
		expect(renderLocations([], "/repo")).toBe("");
	});
});

describe("renderDiagnostics", () => {
	it("puts errors before warnings within a file", () => {
		const text = renderDiagnostics(
			[
				diagnostic({ severity: "warning", line: 5, message: "unused" }),
				diagnostic({ severity: "error", line: 2 }),
			],
			"/repo",
		);

		expect(text).toBe("src/a.ts\n  2:1: error: boom\n  5:1: warning: unused");
	});

	it("keeps each file contiguous instead of interleaving severities", () => {
		const text = renderDiagnostics(
			[
				diagnostic({ path: "/repo/src/b.ts", severity: "error" }),
				diagnostic({ path: "/repo/src/a.ts", severity: "warning", line: 5 }),
				diagnostic({ path: "/repo/src/a.ts", severity: "error", line: 2 }),
			],
			"/repo",
		);

		expect(text).toBe(
			["src/a.ts", "  2:1: error: boom", "  5:1: warning: boom", "src/b.ts", "  1:1: error: boom"].join(
				"\n",
			),
		);
		// File-major: b.ts follows every a.ts line.
		expect(text.indexOf("src/b.ts")).toBeGreaterThan(text.lastIndexOf("src/a.ts"));
	});

	it("collapses message newlines and shows source and code", () => {
		expect(
			renderDiagnostics(
				[diagnostic({ message: "line one\n  line two", source: "ts", code: "2322" })],
				"/repo",
			),
		).toBe("src/a.ts\n  1:1: error: line one line two [ts 2322]");
		expect(renderDiagnostics([diagnostic({ code: "2322" })], "/repo")).toBe(
			"src/a.ts\n  1:1: error: boom [2322]",
		);
		expect(renderDiagnostics([diagnostic({ source: "ts" })], "/repo")).toBe(
			"src/a.ts\n  1:1: error: boom [ts]",
		);
	});

	it("renders nothing for no diagnostics", () => {
		expect(renderDiagnostics([], "/repo")).toBe("");
	});
});

describe("filterDiagnostics", () => {
	it("treats the argument as a minimum severity", () => {
		const all = [
			diagnostic({ severity: "error" }),
			diagnostic({ severity: "warning" }),
			diagnostic({ severity: "information" }),
			diagnostic({ severity: "hint" }),
		];

		expect(filterDiagnostics(all, "hint")).toHaveLength(4);
		expect(filterDiagnostics(all, "warning").map((d) => d.severity)).toEqual(["error", "warning"]);
		expect(filterDiagnostics(all, "error").map((d) => d.severity)).toEqual(["error"]);
	});

	it("ranks error most severe", () => {
		expect(severityRank("error")).toBeLessThan(severityRank("warning"));
		expect(severityRank("warning")).toBeLessThan(severityRank("information"));
		expect(severityRank("information")).toBeLessThan(severityRank("hint"));
	});
});

describe("sortDiagnostics", () => {
	it("does not mutate the input", () => {
		const input = [diagnostic({ line: 5 }), diagnostic({ line: 1 })];
		const sorted = sortDiagnostics(input);

		expect(sorted.map((d) => d.line)).toEqual([1, 5]);
		expect(input.map((d) => d.line)).toEqual([5, 1]);
	});
});

describe("renderEnvelope", () => {
	it("renders a successful location result", () => {
		const envelope = createEnvelope("definition", "success", {
			resultCount: 1,
			locations: [location({ line: 4, character: 5 })],
		});

		expect(renderEnvelope(envelope, "/repo")).toBe("1 location.\nsrc/a.ts:4:5");
	});

	it("renders an empty result with its notes", () => {
		const envelope = createEnvelope("definition", "empty", { notes: ["Nothing matched."] });

		expect(renderEnvelope(envelope, "/repo")).toBe("No results.\nnote: Nothing matched.");
	});

	it("says no diagnostics for an empty lsp_diagnostics result", () => {
		expect(renderEnvelope(createEnvelope("lsp_diagnostics", "empty"), "/repo")).toBe(
			"No diagnostics.",
		);
	});

	it("says nothing is running for an empty status result", () => {
		expect(renderEnvelope(createEnvelope("status", "empty"), "/repo")).toBe(
			"No language servers are running.",
		);
	});

	it("names the server and the install hint for binary_missing", () => {
		const envelope = createEnvelope("definition", "binary_missing", {
			errors: ["pyright: 'pyright-langserver' was not found on PATH."],
			hints: ["Install it, or override 'cmd' for 'pyright' in pi-lspconfig.config.ts."],
		});

		const text = renderEnvelope(envelope, "/repo");

		expect(text).toContain("Language server binary is missing.");
		expect(text).toContain("pyright");
		expect(text).toContain("Install");
	});

	it("renders every failure status without throwing", () => {
		for (const status of [
			"unsupported",
			"bad_input",
			"no_server",
			"disabled",
			"binary_missing",
			"error",
		] as const) {
			expect(renderEnvelope(createEnvelope("definition", status), "/repo").length).toBeGreaterThan(0);
		}
	});

	it("renders a text payload without a summary line", () => {
		const envelope = createEnvelope("hover", "success", {
			resultCount: 1,
			payload: { kind: "text", text: "const x: number", format: "markdown" },
		});

		expect(renderEnvelope(envelope, "/repo")).toBe("const x: number");
	});

	it("renders nested symbols with two-space indentation", () => {
		const envelope = createEnvelope("documentSymbol", "success", {
			resultCount: 1,
			payload: {
				kind: "symbols",
				symbols: [
					{
						name: "foo",
						kind: "function",
						path: "/repo/src/a.ts",
						line: 3,
						character: 1,
						children: [
							{ name: "bar", kind: "method", path: "/repo/src/a.ts", line: 5, character: 3 },
						],
					},
				],
			},
		});

		expect(renderEnvelope(envelope, "/repo")).toBe(
			"1 symbol.\nfunction foo src/a.ts:3:1\n  method bar src/a.ts:5:3",
		);
	});

	it("renders rename edits", () => {
		const envelope = createEnvelope("rename", "success", {
			resultCount: 1,
			payload: {
				kind: "edits",
				edits: [
					{
						path: "/repo/src/a.ts",
						line: 1,
						character: 1,
						endLine: 1,
						endCharacter: 4,
						newText: "bar",
					},
				],
			},
		});

		expect(renderEnvelope(envelope, "/repo")).toBe('1 edit.\nsrc/a.ts:1:1-1:4 "bar"');
	});

	it("renders code actions", () => {
		const envelope = createEnvelope("codeAction", "success", {
			resultCount: 1,
			payload: {
				kind: "codeActions",
				actions: [{ title: "Fix import", kind: "quickfix", isPreferred: true }],
			},
		});

		expect(renderEnvelope(envelope, "/repo")).toBe('1 code action.\nquickfix "Fix import" (preferred)');
	});

	it("prints the raw item for prepareCallHierarchy so it can be passed back", () => {
		const item = {
			name: "f",
			kind: 12,
			uri: "file:///repo/src/a.ts",
			range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
			selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
		};
		const envelope = createEnvelope("prepareCallHierarchy", "success", {
			resultCount: 1,
			payload: {
				kind: "callHierarchy",
				items: [
					{
						name: "f",
						kind: "function",
						path: "/repo/src/a.ts",
						line: 3,
						character: 1,
						item,
						fromRanges: [location({ line: 9, character: 2 })],
					},
				],
			},
		});

		const text = renderEnvelope(envelope, "/repo");

		expect(text).toBe(
			[
				"1 call-hierarchy item.",
				"function f src/a.ts:3:1",
				`  item: ${JSON.stringify(item)}`,
				"  at src/a.ts:9:2",
			].join("\n"),
		);
	});

	it("omits the raw item for incoming and outgoing calls", () => {
		const envelope = createEnvelope("incomingCalls", "success", {
			resultCount: 1,
			payload: {
				kind: "callHierarchy",
				items: [
					{
						name: "f",
						kind: "function",
						path: "/repo/src/a.ts",
						line: 3,
						character: 1,
						item: { name: "f" },
					},
				],
			},
		});

		expect(renderEnvelope(envelope, "/repo")).toBe("1 call-hierarchy item.\nfunction f src/a.ts:3:1");
	});

	it("renders capabilities", () => {
		const envelope = createEnvelope("capabilities", "success", {
			resultCount: 1,
			payload: {
				kind: "capabilities",
				summary: {
					serverId: "fake",
					positionEncoding: "utf-16",
					syncKind: 2,
					operations: ["definition", "references"],
					executeCommands: ["fake.command"],
				},
			},
		});

		expect(renderEnvelope(envelope, "/repo")).toBe(
			[
				"Server fake (utf-16, sync 2).",
				"operations: definition, references",
				"commands: fake.command",
			].join("\n"),
		);
	});

	it("renders client status", () => {
		const envelope = createEnvelope("status", "success", {
			resultCount: 1,
			payload: {
				kind: "status",
				clients: [
					{
						serverId: "fake",
						root: "/repo",
						pid: 123,
						state: "ready",
						openDocuments: 1,
						diagnosticCount: 2,
					},
				],
			},
		});

		expect(renderEnvelope(envelope, "/repo")).toBe(
			"1 client.\nfake ready root . pid 123 documents 1 diagnostics 2",
		);
	});

	it("orders notes, then errors, then hints", () => {
		const envelope = createEnvelope("definition", "error", {
			notes: ["note one"],
			errors: ["error one"],
			hints: ["hint one"],
		});

		expect(renderEnvelope(envelope, "/repo")).toBe(
			["Operation failed.", "note: note one", "error: error one", "hint: hint one"].join("\n"),
		);
	});
});

describe("truncateForModel", () => {
	it("returns the text untouched when it fits", () => {
		const result = truncateForModel("short");

		expect(result).toEqual({ text: "short", truncated: false });
		expect(result).not.toHaveProperty("hint");
	});

	it("appends the given hint when truncated", () => {
		const text = Array.from({ length: RESULT_MAX_LINES + 10 }, (_, index) => `line ${index}`).join("\n");

		const result = truncateForModel(text, { hint: NARROW_RESULTS_HINT });

		expect(result.truncated).toBe(true);
		expect(result.hint).toBe(NARROW_RESULTS_HINT);
		expect(result.text.endsWith(NARROW_RESULTS_HINT)).toBe(true);
		expect(result.text).toContain("line 0");
		expect(result.text).not.toContain(`line ${RESULT_MAX_LINES + 9}`);
	});

	it("falls back to the default hint", () => {
		const text = Array.from({ length: RESULT_MAX_LINES + 1 }, (_, index) => `line ${index}`).join("\n");

		expect(truncateForModel(text).hint).toBe(DEFAULT_TRUNCATION_HINT);
	});

	it("truncates a 5,000-location result to RESULT_MAX_LINES with a narrowing hint", () => {
		const locations = Array.from({ length: 5000 }, (_, index) => location({ line: index + 1 }));

		const result = truncateForModel(renderLocations(locations, "/repo"), {
			hint: NARROW_RESULTS_HINT,
		});

		expect(result.truncated).toBe(true);
		expect(result.text).toContain("src/a.ts:1:1");
		expect(result.text).not.toContain("src/a.ts:5000:1");
		expect(result.text).toContain(NARROW_RESULTS_HINT);
		// The rendered body plus the blank separator and the hint line.
		expect(result.text.split("\n")).toHaveLength(RESULT_MAX_LINES + 2);
	});
});
