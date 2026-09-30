import { describe, expect, it } from "vitest";
import {
	executeOperation,
	isLspOperation,
	validateOperationRequest,
	type OperationRequest,
} from "../../../src/core/operations.ts";
import { LSPServiceError, type ClientDescription, type LSPService } from "../../../src/core/service.ts";
import type { ServerCapabilities } from "../../../src/protocol.ts";
import type { LspClientStatus, LspServerSpec } from "../../../src/types.ts";
import type { Logger } from "../../../src/util/logger.ts";

const SILENT: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const DEFAULT_CAPABILITIES: ServerCapabilities = {
	definitionProvider: true,
	hoverProvider: true,
	documentSymbolProvider: true,
	workspaceSymbolProvider: true,
	referencesProvider: true,
	renameProvider: true,
	codeActionProvider: true,
	executeCommandProvider: { commands: ["fake.command"] },
};

interface StubOptions {
	cwd?: string;
	capabilities?: ServerCapabilities;
	executeCommands?: readonly string[];
	/** Canned response per LSP method, or a function of the params. */
	responses?: Record<string, unknown | ((params: unknown) => unknown)>;
	/** Throw this from `describe`, to exercise error mapping. */
	describeError?: unknown;
	allServers?: readonly LspServerSpec[];
	status?: readonly LspClientStatus[];
}

interface Stub {
	service: LSPService;
	/** Every `request` the operation made. */
	calls: { method: string; params: unknown }[];
}

function createStub(options: StubOptions = {}): Stub {
	const cwd = options.cwd ?? "/repo";
	const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
	const responses = options.responses ?? {};
	const calls: { method: string; params: unknown }[] = [];

	const description: ClientDescription = {
		serverId: "fake",
		root: cwd,
		capabilities: {
			serverCapabilities: capabilities,
			positionEncoding: "utf-16",
			syncKind: 1,
			executeCommands: options.executeCommands ?? ["fake.command"],
		},
	};

	const service: LSPService = {
		cwd,
		touchFile: async () => {},
		markDirty: () => {},
		request: async <T>(_path: string, method: string, params: unknown): Promise<T> => {
			calls.push({ method, params });
			const canned = responses[method];
			if (canned === undefined) throw new Error(`unexpected request ${method}`);
			return (typeof canned === "function" ? canned(params) : canned) as T;
		},
		requestWithServer: async <T>(_id: string, _root: string | undefined, method: string, params: unknown): Promise<T> => {
			calls.push({ method, params });
			const canned = responses[method];
			if (canned === undefined) throw new Error(`unexpected request ${method}`);
			return (typeof canned === "function" ? canned(params) : canned) as T;
		},
		diagnosticsFor: async () => [],
		allDiagnostics: async () => new Map(),
		status: () => options.status ?? [],
		describe: async () => {
			if (options.describeError !== undefined) throw options.describeError;
			return description;
		},
		allServers: () => options.allServers ?? [],
		cachedDiagnostics: () => [],
		restart: async () => {},
		shutdown: async () => {},
	};

	return { service, calls };
}

function run(request: OperationRequest, stub: Stub, maxResults = 100) {
	return executeOperation(stub.service, request, { cwd: "/repo", maxResults, logger: SILENT });
}

describe("isLspOperation", () => {
	it("accepts known operations and rejects others", () => {
		expect(isLspOperation("definition")).toBe(true);
		expect(isLspOperation("status")).toBe(true);
		expect(isLspOperation("nope")).toBe(false);
	});
});

describe("validateOperationRequest", () => {
	it("names both options when a position operation has neither a position nor a symbol", () => {
		const problems = validateOperationRequest({ operation: "definition", path: "a.ts" });

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("line");
		expect(problems[0]).toContain("character");
		expect(problems[0]).toContain("symbol");
	});

	it("requires a path for a position operation", () => {
		expect(validateOperationRequest({ operation: "definition", symbol: "foo" })).toContain(
			"Operation 'definition' requires `path`.",
		);
	});

	it("rejects a partial position", () => {
		const problems = validateOperationRequest({ operation: "hover", path: "a.ts", line: 3 });
		expect(problems.some((problem) => problem.includes("both"))).toBe(true);
	});

	it("accepts a symbol instead of a position", () => {
		expect(validateOperationRequest({ operation: "definition", path: "a.ts", symbol: "foo" })).toEqual([]);
	});

	it("requires occurrence to be paired with symbol", () => {
		const problems = validateOperationRequest({
			operation: "definition",
			path: "a.ts",
			line: 1,
			character: 1,
			occurrence: 2,
		});
		expect(problems).toContain("`occurrence` requires `symbol`.");
	});

	it("enforces each operation's own required field", () => {
		expect(validateOperationRequest({ operation: "workspaceSymbol" })).toContain(
			"Operation 'workspaceSymbol' requires `query`.",
		);
		expect(validateOperationRequest({ operation: "rename", path: "a.ts", symbol: "x" })).toContain(
			"Operation 'rename' requires `newName`.",
		);
		expect(validateOperationRequest({ operation: "executeCommand" })).toContain(
			"Operation 'executeCommand' requires `command`.",
		);
		expect(
			validateOperationRequest({ operation: "incomingCalls", path: "a.ts" }),
		).toContain(
			"Operation 'incomingCalls' requires `callHierarchyItem`, the token returned by 'prepareCallHierarchy'.",
		);
	});

	it("does not demand a position for the call-hierarchy children", () => {
		expect(
			validateOperationRequest({
				operation: "outgoingCalls",
				path: "a.ts",
				callHierarchyItem: { name: "f", kind: 12, uri: "file:///a.ts", range: zeroRange(), selectionRange: zeroRange() },
			}),
		).toEqual([]);
	});
});

describe("executeOperation — failures never throw", () => {
	it("returns no_server when the service cannot resolve one", async () => {
		const stub = createStub({ describeError: new LSPServiceError("no_server", "nothing handles it") });
		const envelope = await run({ operation: "definition", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.status).toBe("no_server");
		expect(envelope.ok).toBe(false);
		expect(envelope.errors).toEqual(["nothing handles it"]);
	});

	it("returns unsupported when the server lacks the capability", async () => {
		const stub = createStub({ capabilities: {} });
		const envelope = await run({ operation: "definition", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.status).toBe("unsupported");
		expect(envelope.errors?.[0]).toContain("does not support 'definition'");
		expect(stub.calls).toEqual([]);
	});

	it("maps a JSON-RPC method-not-found to unsupported", async () => {
		const stub = createStub({
			responses: {
				"textDocument/definition": () => {
					const error = new Error("Method not found: textDocument/definition") as Error & { code: number };
					error.code = -32601;
					throw error;
				},
			},
		});
		const envelope = await run({ operation: "definition", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.status).toBe("unsupported");
	});

	it("returns bad_input without calling the server", async () => {
		const stub = createStub();
		const envelope = await run({ operation: "definition", path: "a.ts" }, stub);

		expect(envelope.status).toBe("bad_input");
		expect(envelope.errors?.length).toBeGreaterThan(0);
		expect(stub.calls).toEqual([]);
	});

	it("refuses to apply a rename", async () => {
		const stub = createStub();
		const envelope = await run(
			{ operation: "rename", path: "a.ts", line: 1, character: 1, newName: "b", apply: true },
			stub,
		);

		expect(envelope.status).toBe("unsupported");
		expect(envelope.hints?.[0]).toContain("apply");
	});

	it("rejects an executeCommand the server does not advertise", async () => {
		const stub = createStub({ executeCommands: ["other.command"] });
		const envelope = await run({ operation: "executeCommand", command: "fake.command" }, stub);

		expect(envelope.status).toBe("unsupported");
		expect(envelope.hints?.[0]).toContain("other.command");
	});
});

describe("executeOperation — results", () => {
	it("normalises a definition Location into a 1-based location", async () => {
		const stub = createStub({
			responses: {
				"textDocument/definition": {
					uri: "file:///repo/target.ts",
					range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
				},
			},
		});
		const envelope = await run({ operation: "definition", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.status).toBe("success");
		expect(envelope.resultCount).toBe(1);
		expect(envelope.servers).toEqual(["fake"]);
		expect(envelope.locations).toEqual([
			{ path: "/repo/target.ts", line: 3, character: 5, endLine: 3, endCharacter: 8 },
		]);
	});

	it("accepts a LocationLink array", async () => {
		const stub = createStub({
			responses: {
				"textDocument/definition": [
					{
						targetUri: "file:///repo/target.ts",
						targetRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
						targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } },
					},
				],
			},
		});
		const envelope = await run({ operation: "definition", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.locations?.[0]).toMatchObject({ line: 5, character: 3 });
	});

	it("reports empty when the server finds nothing", async () => {
		const stub = createStub({ responses: { "textDocument/definition": null } });
		const envelope = await run({ operation: "definition", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.status).toBe("empty");
		expect(envelope.resultCount).toBe(0);
	});

	it("caps results and says how to narrow", async () => {
		const locations = Array.from({ length: 5 }, (_, index) => ({
			uri: `file:///repo/t${index}.ts`,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		}));
		const stub = createStub({ responses: { "textDocument/references": locations } });
		const envelope = await run({ operation: "references", path: "a.ts", line: 1, character: 1 }, stub, 2);

		expect(envelope.resultCount).toBe(2);
		expect(envelope.notes?.[0]).toContain("Showing 2 of 5");
	});

	it("resolves symbol + occurrence through documentSymbol", async () => {
		const stub = createStub({
			responses: {
				"textDocument/documentSymbol": [
					{ name: "foo", kind: 12, range: zeroRange(), selectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } } },
					{ name: "foo", kind: 12, range: zeroRange(), selectionRange: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } } },
				],
				"textDocument/definition": null,
			},
		});
		await run({ operation: "definition", path: "a.ts", symbol: "foo", occurrence: 2 }, stub);

		const definition = stub.calls.find((call) => call.method === "textDocument/definition");
		expect(definition?.params).toMatchObject({ position: { line: 9, character: 2 } });
	});

	it("returns a text payload for hover", async () => {
		const stub = createStub({
			responses: { "textDocument/hover": { contents: { kind: "markdown", value: "```ts\nconst a: number\n```" } } },
		});
		const envelope = await run({ operation: "hover", path: "a.ts", line: 1, character: 1 }, stub);

		expect(envelope.payload).toEqual({
			kind: "text",
			text: "```ts\nconst a: number\n```",
			format: "markdown",
		});
	});

	it("returns a symbols payload for documentSymbol", async () => {
		const stub = createStub({
			responses: {
				"textDocument/documentSymbol": [
					{ name: "outer", kind: 12, range: zeroRange(), selectionRange: zeroRange(), children: [{ name: "inner", kind: 13, range: zeroRange(), selectionRange: zeroRange() }] },
				],
			},
		});
		const envelope = await run({ operation: "documentSymbol", path: "a.ts" }, stub);

		expect(envelope.payload?.kind).toBe("symbols");
		if (envelope.payload?.kind !== "symbols") throw new Error("wrong payload");
		expect(envelope.payload.symbols[0]?.name).toBe("outer");
		expect(envelope.payload.symbols[0]?.children?.[0]?.name).toBe("inner");
	});

	it("drops children when topLevelOnly is set", async () => {
		const stub = createStub({
			responses: {
				"textDocument/documentSymbol": [
					{ name: "outer", kind: 12, range: zeroRange(), selectionRange: zeroRange(), children: [{ name: "inner", kind: 13, range: zeroRange(), selectionRange: zeroRange() }] },
				],
			},
		});
		const envelope = await run({ operation: "documentSymbol", path: "a.ts", topLevelOnly: true }, stub);

		if (envelope.payload?.kind !== "symbols") throw new Error("wrong payload");
		expect(envelope.payload.symbols[0]?.children).toBeUndefined();
	});

	it("returns an edits payload for rename", async () => {
		const stub = createStub({
			responses: {
				"textDocument/rename": {
					changes: {
						"file:///repo/a.ts": [
							{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "bar" },
						],
					},
				},
			},
		});
		const envelope = await run(
			{ operation: "rename", path: "a.ts", line: 1, character: 1, newName: "bar" },
			stub,
		);

		expect(envelope.payload?.kind).toBe("edits");
		if (envelope.payload?.kind !== "edits") throw new Error("wrong payload");
		expect(envelope.payload.edits[0]).toMatchObject({ path: "/repo/a.ts", newText: "bar" });
	});

	it("answers capabilities locally without a server request", async () => {
		const stub = createStub();
		const envelope = await run({ operation: "capabilities", path: "a.ts" }, stub);

		expect(envelope.payload?.kind).toBe("capabilities");
		if (envelope.payload?.kind !== "capabilities") throw new Error("wrong payload");
		expect(envelope.payload.summary.serverId).toBe("fake");
		expect(envelope.payload.summary.operations).toContain("definition");
		expect(envelope.payload.summary.operations).not.toContain("signatureHelp");
		expect(stub.calls).toEqual([]);
	});

	it("answers status locally and starts nothing", async () => {
		const stub = createStub({
			status: [
				{ serverId: "fake", root: "/repo", pid: 1, state: "ready", openDocuments: 0, diagnosticCount: 0 },
			],
		});
		const envelope = await run({ operation: "status" }, stub);

		expect(envelope.status).toBe("success");
		expect(envelope.payload?.kind).toBe("status");
		expect(stub.calls).toEqual([]);
	});

	it("uses the first configured server for a path-less workspaceSymbol", async () => {
		const stub = createStub({
			allServers: [{ id: "first", cmd: ["first"], filetypes: ["typescript"] }],
			responses: {
				"workspace/symbol": [{ name: "foo", kind: 12, location: { uri: "file:///repo/a.ts", range: zeroRange() } }],
			},
		});
		const envelope = await run({ operation: "workspaceSymbol", query: "foo" }, stub);

		expect(envelope.servers).toEqual(["first"]);
		expect(envelope.payload?.kind).toBe("symbols");
		if (envelope.payload?.kind !== "symbols") throw new Error("wrong payload");
		// The server already applied `query`; a `symbol`-less request must not
		// filter every name against "".
		expect(envelope.status).toBe("success");
		expect(envelope.resultCount).toBe(1);
		expect(envelope.payload.symbols.map((symbol) => symbol.name)).toEqual(["foo"]);
	});

	it("still filters workspaceSymbol results when `symbol` is also given", async () => {
		const stub = createStub({
			allServers: [{ id: "first", cmd: ["first"], filetypes: ["typescript"] }],
			responses: {
				"workspace/symbol": [
					{ name: "foo", kind: 12, location: { uri: "file:///repo/a.ts", range: zeroRange() } },
					{ name: "bar", kind: 12, location: { uri: "file:///repo/b.ts", range: zeroRange() } },
				],
			},
		});
		const envelope = await run({ operation: "workspaceSymbol", query: "f", symbol: "foo" }, stub);

		expect(envelope.payload?.kind).toBe("symbols");
		if (envelope.payload?.kind !== "symbols") throw new Error("wrong payload");
		expect(envelope.payload.symbols.map((symbol) => symbol.name)).toEqual(["foo"]);
	});

	it("round-trips the raw call-hierarchy item for incoming/outgoing calls", async () => {
		const node = {
			name: "f",
			kind: 12,
			uri: "file:///repo/a.ts",
			range: zeroRange(),
			selectionRange: zeroRange(),
		};
		const stub = createStub({
			capabilities: { ...DEFAULT_CAPABILITIES, callHierarchyProvider: true },
			responses: { "textDocument/prepareCallHierarchy": [node] },
		});
		const envelope = await run(
			{ operation: "prepareCallHierarchy", path: "a.ts", line: 1, character: 1 },
			stub,
		);

		expect(envelope.payload?.kind).toBe("callHierarchy");
		if (envelope.payload?.kind !== "callHierarchy") throw new Error("wrong payload");
		// Without this the model has nothing to pass back as `callHierarchyItem`.
		expect(envelope.payload.items[0]?.item).toEqual(node);
	});
});

/** A zero-width range at the start of a file. */
function zeroRange() {
	return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}
