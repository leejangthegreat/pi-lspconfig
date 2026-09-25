import { describe, expect, it } from "vitest";
import {
	detectExecuteCommands,
	negotiatePositionEncoding,
	negotiateSyncKind,
	supportsPullDiagnostics,
} from "../../../src/core/client/initialize.ts";
import type { ServerCapabilities } from "../../../src/protocol.ts";

describe("negotiatePositionEncoding", () => {
	it("honours a valid encoding the server advertises", () => {
		expect(negotiatePositionEncoding({ positionEncoding: "utf-8" })).toBe("utf-8");
		expect(negotiatePositionEncoding({ positionEncoding: "utf-32" })).toBe("utf-32");
		expect(negotiatePositionEncoding({ positionEncoding: "utf-16" })).toBe("utf-16");
	});

	it("defaults to UTF-16 when the server says nothing or something unknown", () => {
		expect(negotiatePositionEncoding({})).toBe("utf-16");
		expect(
			negotiatePositionEncoding({ positionEncoding: "utf-7" } as unknown as ServerCapabilities),
		).toBe("utf-16");
	});
});

describe("negotiateSyncKind", () => {
	it("normalises the legacy boolean form", () => {
		expect(negotiateSyncKind({ textDocumentSync: true })).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: false })).toBe(0);
	});

	it("reads the object form's change field", () => {
		expect(negotiateSyncKind({ textDocumentSync: { change: 0 } })).toBe(0);
		expect(negotiateSyncKind({ textDocumentSync: { change: 1 } })).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: { change: 2 } })).toBe(2);
	});

	it("returns 0 when the capability is absent", () => {
		expect(negotiateSyncKind({})).toBe(0);
	});

	it("falls back to openClose, then to none", () => {
		expect(negotiateSyncKind({ textDocumentSync: { openClose: true } })).toBe(1);
		expect(negotiateSyncKind({ textDocumentSync: {} })).toBe(0);
		expect(
			negotiateSyncKind({ textDocumentSync: { change: 9 } } as unknown as ServerCapabilities),
		).toBe(0);
	});
});

describe("detectExecuteCommands", () => {
	it("returns an empty list when the server advertises none", () => {
		expect(detectExecuteCommands({})).toEqual([]);
		expect(detectExecuteCommands({ executeCommandProvider: {} })).toEqual([]);
	});

	it("keeps only string command ids", () => {
		const server = {
			executeCommandProvider: { commands: ["a.b", 1, null, "c.d"] },
		} as unknown as ServerCapabilities;
		expect(detectExecuteCommands(server)).toEqual(["a.b", "c.d"]);
	});
});

describe("supportsPullDiagnostics", () => {
	it("is true for either pull-diagnostics shape", () => {
		expect(supportsPullDiagnostics({})).toBe(false);
		expect(supportsPullDiagnostics({ diagnosticProvider: {} })).toBe(true);
		expect(supportsPullDiagnostics({ workspace: { diagnostics: {} } })).toBe(true);
	});
});
