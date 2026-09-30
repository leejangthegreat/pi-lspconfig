/**
 * A hand-rolled `LSPService` double.
 *
 * The tool layer only ever sees an `LSPService`, so the tests that exercise the
 * `execute` bodies drive it directly instead of standing up a server. Kept
 * under `tests/unit/` rather than `tests/fixtures/` so `tsc` typechecks it.
 *
 * For tests that need the real engine (symbol resolution, capability gating),
 * use `tests/fixtures/fake-lsp-streams.ts` instead — it speaks real JSON-RPC
 * over in-memory streams.
 */

import type { ClientDescription, LSPService } from "../../../src/core/service.ts";
import type { Diagnostic, ServerCapabilities } from "../../../src/protocol.ts";
import type { LspClientStatus, LspServerSpec } from "../../../src/types.ts";
import type { Logger } from "../../../src/util/logger.ts";

/** A logger that discards everything, for tests that do not assert on logs. */
export const SILENT_LOGGER: Logger = {
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
	callHierarchyProvider: true,
	executeCommandProvider: { commands: ["fake.command"] },
};

export interface ServiceStubOptions {
	cwd?: string;
	capabilities?: ServerCapabilities;
	executeCommands?: readonly string[];
	/** Canned response per LSP method, or a function of the request params. */
	responses?: Record<string, unknown | ((params: unknown) => unknown)>;
	/** Throw this from `describe`, to exercise error mapping. */
	describeError?: unknown;
	/** Throw this from `diagnosticsFor` / `allDiagnostics`. */
	diagnosticsError?: unknown;
	allServers?: readonly LspServerSpec[];
	status?: readonly LspClientStatus[];
	/** What `diagnosticsFor` resolves with. */
	diagnostics?: readonly Diagnostic[];
	/** What `cachedDiagnostics` returns. */
	cached?: readonly Diagnostic[];
	/** What `allDiagnostics` resolves with. */
	allDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
	/** Throw this from `restart`. */
	restartError?: unknown;
}

export interface ServiceStub {
	service: LSPService;
	/** Every `request`/`requestWithServer` the service was asked for. */
	calls: { method: string; params: unknown }[];
	/** Paths passed to `markDirty`. */
	dirty: string[];
	/** Paths passed to `touchFile`. */
	touched: string[];
	/** Paths passed to `diagnosticsFor`. */
	diagnosed: string[];
	/** Paths passed to `describe`. */
	described: string[];
	/** Server ids passed to `restart`, `undefined` for a full restart. */
	restarted: (string | undefined)[];
}

/** Build a stub service plus the bookkeeping the tests assert against. */
export function createServiceStub(options: ServiceStubOptions = {}): ServiceStub {
	const cwd = options.cwd ?? "/repo";
	const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
	const responses = options.responses ?? {};
	const calls: { method: string; params: unknown }[] = [];
	const dirty: string[] = [];
	const touched: string[] = [];
	const diagnosed: string[] = [];
	const described: string[] = [];
	const restarted: (string | undefined)[] = [];

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

	const send = async <T>(method: string, params: unknown): Promise<T> => {
		calls.push({ method, params });
		const canned = responses[method];
		if (canned === undefined) throw new Error(`unexpected request ${method}`);
		return (typeof canned === "function" ? canned(params) : canned) as T;
	};

	const service: LSPService = {
		cwd,
		touchFile: async (path) => {
			touched.push(path);
		},
		markDirty: (path) => {
			dirty.push(path);
		},
		request: <T>(_path: string, method: string, params: unknown) => send<T>(method, params),
		requestWithServer: <T>(_id: string, _root: string | undefined, method: string, params: unknown) =>
			send<T>(method, params),
		diagnosticsFor: async (path) => {
			diagnosed.push(path);
			if (options.diagnosticsError !== undefined) throw options.diagnosticsError;
			return options.diagnostics ?? [];
		},
		allDiagnostics: async () => {
			if (options.diagnosticsError !== undefined) throw options.diagnosticsError;
			return options.allDiagnostics ?? new Map();
		},
		status: () => options.status ?? [],
		describe: async (path) => {
			described.push(path);
			if (options.describeError !== undefined) throw options.describeError;
			return description;
		},
		allServers: () => options.allServers ?? [],
		cachedDiagnostics: () => options.cached ?? [],
		restart: async (serverId) => {
			restarted.push(serverId);
			if (options.restartError !== undefined) throw options.restartError;
		},
		shutdown: async () => {},
	};

	return { service, calls, dirty, touched, diagnosed, described, restarted };
}
