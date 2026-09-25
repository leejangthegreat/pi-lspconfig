/**
 * The client fleet.
 *
 * One live language server per `(serverId, root)` pair, plus the document and
 * diagnostic state that belongs to it.
 *
 * ## Why the registry lives on `globalThis`
 *
 * `/reload` clears the jiti module cache and re-evaluates this entire module
 * graph. A module-level `const fleet = new Map()` would therefore be rebuilt,
 * silently orphaning every previously spawned language server. The fleet is
 * anchored to `globalThis[Symbol.for("pi-lspconfig.fleet")]` instead, and a
 * reloading runtime **adopts** the existing fleet rather than starting over.
 *
 * ## Why shutdown is refcounted
 *
 * On reload the old runtime sees `session_shutdown{reason:"reload"}` while the
 * new runtime sees `session_start{reason:"reload"}`. They race. Hard-killing on
 * shutdown would throw away every warm server and can interrupt an `initialize`
 * the successor already started; not killing leaks processes. So teardown is
 * deferred by a grace window and skipped entirely when a successor has claimed
 * the registry.
 */

import type { ClientCapabilities, Diagnostic, PublishDiagnosticsParams } from "../protocol.ts";
import type {
	LaunchContext,
	LspClientStatus,
	LspServerSpec,
	LspStatus,
	NegotiatedCapabilities,
	ServerTable,
	TouchFileOptions,
} from "../types.ts";
import { DEFAULT_INITIALIZE_TIMEOUT_MS, DEFAULT_SHUTDOWN_GRACE_MS } from "../util/defaults.ts";
import type { Logger } from "../util/logger.ts";
import { deepMerge } from "../util/merge.ts";
import { normalizePath } from "../util/paths.ts";
import { createLSPConnection, type LSPConnection } from "./client/connection.ts";
import {
	createDiagnosticStore,
	type DiagnosticStore,
	type WaitForDiagnosticsOptions,
} from "./client/diagnostics.ts";
import { initializeClient } from "./client/initialize.ts";
import { defaultSpawn, resolveCommand, type LSPProcess, type SpawnFn } from "./client/launch.ts";
import { createDocumentSynchronizer, type DocumentSynchronizer } from "./client/sync.ts";
import { createServerResolver, type ServerResolver } from "./registry.ts";
import { createWorkspaceResolver, type WorkspaceResolver } from "./workspace.ts";

export interface LSPServiceOptions {
	/** Resolved server table. The service never reads user config itself. */
	servers: ServerTable;
	/** Session working directory; also the root-detection ceiling. */
	cwd: string;
	/** Extension → languageId, already merged with user overrides. */
	languageIds: ReadonlyMap<string, string>;
	/** Server ids that must never be started. */
	disabled?: ReadonlySet<string>;
	logger: Logger;
	/** Injectable launcher, for tests. Defaults to `defaultSpawn`. */
	spawn?: SpawnFn;
	/** Overrides merged over `DEFAULT_CLIENT_CAPABILITIES`. */
	clientCapabilities?: ClientCapabilities;
	/** Default handshake timeout for servers that do not set their own. */
	initializeTimeoutMs?: number;
}

/** Which server serves a path, and what it negotiated. */
export interface ClientDescription {
	serverId: string;
	root: string | undefined;
	capabilities: NegotiatedCapabilities;
}

export interface LSPService {
	readonly cwd: string;
	/** Sync a file and, if needed, start its server. Throws when no server matches. */
	touchFile(path: string, options?: TouchFileOptions): Promise<void>;
	/** Mark a path as changed by an external writer (Pi's `edit`/`write`). */
	markDirty(path: string): void;
	/** Send a request to whichever server owns `path`. */
	request<T>(path: string, method: string, params: unknown, signal?: AbortSignal): Promise<T>;
	/** Send a request to a specific server/root pair. */
	requestWithServer<T>(
		serverId: string,
		root: string | undefined,
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<T>;
	/** Wait for a quiet window, then return diagnostics for one path. */
	diagnosticsFor(path: string, options?: WaitForDiagnosticsOptions): Promise<readonly Diagnostic[]>;
	/** Aggregated diagnostics for every open document. */
	allDiagnostics(): Promise<ReadonlyMap<string, readonly Diagnostic[]>>;
	/** Health snapshot for `/lsp-status`. */
	status(): readonly LspClientStatus[];
	/** Which server serves `path`, and its negotiated capabilities. */
	describe(path: string): Promise<ClientDescription>;
	/** Every configured server, for `/lsp-list` and path-less workspace operations. */
	allServers(): readonly LspServerSpec[];
	/** Last known diagnostics for a path, without waiting or starting anything. */
	cachedDiagnostics(path: string): readonly Diagnostic[];
	/** Restart one server, or all of them when `serverId` is omitted. */
	restart(serverId?: string): Promise<void>;
	/** Idempotent teardown: close documents, then stop every process. */
	shutdown(): Promise<void>;
}

/**
 * A failure with a machine-stable outcome.
 *
 * Discriminated **structurally** rather than with `instanceof`: after `/reload`
 * a new module graph calls a service adopted from the old graph, so the class
 * object — and therefore `instanceof` — differs across the boundary. The
 * `Symbol.for` brand survives it, exactly like `isLSPRequestError` in
 * `client/connection.ts`.
 */
const SERVICE_ERROR_MARKER = Symbol.for("pi-lspconfig.serviceError");

export class LSPServiceError extends Error {
	readonly status: LspStatus;
	readonly hints: readonly string[];
	readonly marker: symbol = SERVICE_ERROR_MARKER;

	constructor(status: LspStatus, message: string, hints: readonly string[] = []) {
		super(message);
		this.name = "LSPServiceError";
		this.status = status;
		this.hints = [...hints];
	}
}

/** True for an {@link LSPServiceError}, including one from another module graph. */
export function isLSPServiceError(error: unknown): error is LSPServiceError {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { marker?: unknown; status?: unknown };
	return candidate.marker === SERVICE_ERROR_MARKER && typeof candidate.status === "string";
}

/** One live server plus everything scoped to it. */
interface ClientEntry {
	serverId: string;
	root: string | undefined;
	spec: LspServerSpec;
	state: LspClientStatus["state"];
	process?: LSPProcess;
	connection?: LSPConnection;
	capabilities?: NegotiatedCapabilities;
	sync?: DocumentSynchronizer;
	readonly diagnostics: DiagnosticStore;
	lastError?: string;
	startPromise?: Promise<ClientEntry>;
	/** Serialises document sync so two callers cannot both send `didOpen` v1. */
	serial: Promise<unknown>;
}

/** Create a fleet. Prefer {@link getLSPService} so reloads share one fleet. */
export function createLSPService(options: LSPServiceOptions): LSPService {
	const logger = options.logger;
	const cwd = normalizePath(options.cwd);
	const resolver: ServerResolver = createServerResolver({
		servers: options.servers,
		languageIds: options.languageIds,
		disabled: options.disabled,
	});
	const workspace: WorkspaceResolver = createWorkspaceResolver({ cwd });
	const spawn = options.spawn ?? defaultSpawn;

	const clients = new Map<string, ClientEntry>();
	let closing = false;
	let shutdownPromise: Promise<void> | undefined;

	const startClient = (entry: ClientEntry, languageId: string): Promise<ClientEntry> => {
		entry.startPromise = (async (): Promise<ClientEntry> => {
			const spec = entry.spec;
			try {
				const argv = await resolveArgv(spec, { serverId: spec.id, root: entry.root, cwd });
				const command = await resolveCommand(argv[0] ?? "");
				if (command === undefined) {
					throw new LSPServiceError(
						"binary_missing",
						`${spec.id}: '${argv[0] ?? ""}' was not found on PATH.`,
						[
							`Install it, or override 'cmd' for '${spec.id}' in pi-lspconfig.config.ts.`,
						],
					);
				}

				const process = spawn({
					command,
					args: argv.slice(1),
					cwd: entry.root ?? cwd,
					env: spec.env,
				});
				entry.process = process;

				const connection = createLSPConnection(process);
				entry.connection = connection;
				connection.listen();

				const capabilities = await initializeClient(connection, {
					root: entry.root,
					capabilities: deepMerge(options.clientCapabilities ?? {}, spec.capabilities ?? {}),
					initOptions: spec.initOptions,
					settings: spec.settings,
					timeoutMs:
						spec.initializeTimeoutMs ?? options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
				});
				entry.capabilities = capabilities;

				// Diagnostics are push-first; the store exists so a query right after
				// an edit can wait for a quiet window instead of racing the server.
				connection.onNotification("textDocument/publishDiagnostics", (params) => {
					entry.diagnostics.onPublish(params as PublishDiagnosticsParams);
				});

				entry.sync = createDocumentSynchronizer({
					connection,
					syncKind: capabilities.syncKind,
					languageIdFor: () => languageId,
					positionEncoding: capabilities.positionEncoding,
				});

				entry.state = "ready";
				logger.debug(`${spec.id}: ready (root ${entry.root ?? "<none>"}, pid ${process.pid ?? "?"})`);
				return entry;
			} catch (error) {
				entry.lastError = error instanceof Error ? error.message : String(error);
				logger.warn(`${entry.serverId}: start failed: ${entry.lastError}`);
				// A half-started server must not leak; the entry is left in `failed`
				// so `status()` reports it and the next call retries.
				await teardownEntry(entry);
				entry.state = "failed";
				entry.startPromise = undefined;
				throw error;
			}
		})();
		return entry.startPromise;
	};

	const ensureClient = async (path: string): Promise<ClientEntry> => {
		if (closing) {
			throw new LSPServiceError("error", "pi-lspconfig is shutting down.");
		}

		const normalized = normalizePath(path);
		const match = resolver.resolve(normalized);
		if (match === undefined) {
			throw new LSPServiceError("no_server", `No configured language server handles ${normalized}.`, [
				"Check `languageIds` and `disabledServers` in pi-lspconfig.config.ts, or use a text tool.",
			]);
		}

		const spec = match.server;
		const root = await workspace.resolve(spec, normalized, { cwd, ceiling: workspace.ceiling });
		if (root === undefined && spec.singleFileSupport !== true) {
			throw new LSPServiceError("no_server", `${spec.id}: no project root found for ${normalized}.`, [
				`Looked for ${(spec.rootMarkers ?? []).join(", ") || "a project marker"} above the file.`,
				`Set 'singleFileSupport: true' for '${spec.id}' to run without a project root.`,
			]);
		}

		const key = clientKey(spec.id, root);
		let entry = clients.get(key);

		if (entry !== undefined && entry.state === "starting" && entry.startPromise !== undefined) {
			try {
				return await entry.startPromise;
			} catch {
				// Fall through and retry once; a transient start failure should not
				// wedge the fleet.
				entry = clients.get(key);
			}
		}

		if (entry === undefined) {
			entry = {
				serverId: spec.id,
				root,
				spec,
				state: "starting",
				diagnostics: createDiagnosticStore(),
				serial: Promise.resolve(),
			};
			clients.set(key, entry);
		}

		if (entry.state === "ready") return entry;

		entry.spec = spec;
		entry.state = "starting";
		return startClient(entry, match.languageId);
	};

	const touchFile = async (path: string, touchOptions?: TouchFileOptions): Promise<void> => {
		const entry = await ensureClient(path);
		const normalized = normalizePath(path);
		// `sync.touch` awaits `readFile` before it checks its own map, so two
		// concurrent callers would both send `didOpen` v1. Serialise per client.
		const run = async (): Promise<void> => {
			await entry.sync?.touch(normalized, touchOptions);
		};
		entry.serial = entry.serial.then(run, run);
		await entry.serial;
	};

	const request = async <T>(
		path: string,
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<T> => {
		const entry = await ensureClient(path);
		await touchFile(path);
		return connectionOf(entry).sendRequest<T>(method, params, signal);
	};

	return {
		cwd,

		touchFile,

		markDirty: (path) => {
			const normalized = normalizePath(path);
			// `DocumentSynchronizer.markDirty` is a no-op for a document it does not
			// hold, so the owning client is found without resolving a root.
			for (const entry of clients.values()) entry.sync?.markDirty(normalized);
		},

		request,

		requestWithServer: async <T>(
			serverId: string,
			root: string | undefined,
			method: string,
			params: unknown,
			signal?: AbortSignal,
		): Promise<T> => {
			const spec = options.servers.get(serverId);
			if (spec === undefined) {
				throw new LSPServiceError("no_server", `Unknown server id '${serverId}'.`);
			}
			const normalizedRoot = root === undefined ? undefined : normalizePath(root);
			const key = clientKey(serverId, normalizedRoot);

			let entry = clients.get(key);
			if (entry === undefined) {
				entry = {
					serverId,
					root: normalizedRoot,
					spec,
					state: "starting",
					diagnostics: createDiagnosticStore(),
					serial: Promise.resolve(),
				};
				clients.set(key, entry);
			}
			if (entry.state !== "ready") {
				entry.spec = spec;
				entry.state = "starting";
				await startClient(entry, spec.filetypes[0] ?? "plaintext");
			}
			return connectionOf(entry).sendRequest<T>(method, params, signal);
		},

		diagnosticsFor: async (
			path: string,
			waitOptions?: WaitForDiagnosticsOptions,
		): Promise<readonly Diagnostic[]> => {
			const entry = await ensureClient(path);
			const normalized = normalizePath(path);
			const run = async (): Promise<void> => {
				await entry.sync?.touch(normalized);
			};
			entry.serial = entry.serial.then(run, run);
			await entry.serial;
			return entry.diagnostics.waitFor(normalized, waitOptions);
		},

		allDiagnostics: async (): Promise<ReadonlyMap<string, readonly Diagnostic[]>> => {
			const merged = new Map<string, readonly Diagnostic[]>();
			for (const entry of clients.values()) {
				for (const document of entry.sync?.openDocuments() ?? []) {
					const diagnostics = entry.diagnostics.get(document.path);
					if (diagnostics !== undefined) merged.set(document.path, diagnostics);
				}
			}
			return merged;
		},

		status: () =>
			[...clients.values()].map((entry) => ({
				serverId: entry.serverId,
				root: entry.root,
				pid: entry.process?.pid,
				state: entry.state,
				openDocuments: entry.sync?.openDocuments().length ?? 0,
				diagnosticCount: entry.diagnostics.counts().total,
				lastError: entry.lastError,
			})),

		describe: async (path: string): Promise<ClientDescription> => {
			const entry = await ensureClient(path);
			if (entry.capabilities === undefined) {
				throw new LSPServiceError("error", `${entry.serverId}: not initialized.`);
			}
			return { serverId: entry.serverId, root: entry.root, capabilities: entry.capabilities };
		},

		cachedDiagnostics: (path: string): readonly Diagnostic[] => {
			const normalized = normalizePath(path);
			for (const entry of clients.values()) {
				const found = entry.diagnostics.get(normalized);
				if (found !== undefined) return found;
			}
			return [];
		},

		allServers: () => resolver.all(),

		restart: async (serverId?: string): Promise<void> => {
			const targets = [...clients.entries()].filter(
				([, entry]) => serverId === undefined || entry.serverId === serverId,
			);
			// Drop the entries first: a request arriving mid-restart must start a
			// fresh client rather than reuse one that is being torn down.
			for (const [key] of targets) clients.delete(key);
			await Promise.all(targets.map(([, entry]) => teardownEntry(entry)));
		},

		shutdown: (): Promise<void> => {
			// Set before the first await so a concurrent call is a no-op.
			closing = true;
			shutdownPromise ??= (async () => {
				const entries = [...clients.values()];
				clients.clear();
				await Promise.all(entries.map((entry) => teardownEntry(entry)));
			})();
			return shutdownPromise;
		},
	};
}

/** Tear down one client. Safe to call on a partially started entry. */
async function teardownEntry(entry: ClientEntry): Promise<void> {
	const { connection, process, sync } = entry;
	entry.connection = undefined;
	entry.process = undefined;
	entry.sync = undefined;
	entry.capabilities = undefined;

	if (sync !== undefined) {
		try {
			await sync.closeAll();
		} catch {
			// The server may already be gone.
		}
	}
	entry.diagnostics.clearAll();

	if (connection !== undefined) {
		try {
			await connection.sendRequest("shutdown", undefined);
		} catch {
			// A dead or never-initialized server rejects here; teardown continues.
		}
		// `exit` is a notification: waiting for an ack would hang on a broken server.
		connection.sendNotification("exit", {});
		connection.dispose();
	}

	if (process !== undefined) {
		try {
			await process.kill();
		} catch {
			// Best effort; the process may already be reaped.
		}
	}

	entry.state = "stopped";
}

/** The connection for a ready entry, or a typed error. */
function connectionOf(entry: ClientEntry): LSPConnection {
	if (entry.connection === undefined) {
		throw new LSPServiceError("error", `${entry.serverId}: not connected.`);
	}
	return entry.connection;
}

/** Resolve a spec's `cmd`, which may be a function of the launch context. */
async function resolveArgv(spec: LspServerSpec, ctx: LaunchContext): Promise<string[]> {
	const cmd = typeof spec.cmd === "function" ? await spec.cmd(ctx) : spec.cmd;
	return [...cmd];
}

/** Stable key for a `(serverId, root)` pair. */
function clientKey(serverId: string, root: string | undefined): string {
	return `${serverId}\0${root ?? ""}`;
}

// ---------------------------------------------------------------------------
// Process-global registry (reload handoff)
// ---------------------------------------------------------------------------

/** Stable key so a reloaded module graph finds the previous runtime's fleet. */
export const FLEET_REGISTRY_KEY: unique symbol = Symbol.for("pi-lspconfig.fleet");

export interface FleetRegistry {
	/** Incremented on every acquire; a runtime with a stale generation is defunct. */
	generation: number;
	/** Identifier of the runtime that currently owns the fleet. */
	ownerRuntimeId: string;
	/** Live services, keyed by session cwd. */
	services: Map<string, LSPService>;
	/** Signature of the `ServerTable` each service was built from, keyed by cwd. */
	serviceSignatures: Map<string, string>;
	createdAt: number;
	/** Deferred teardown scheduled by a reload handoff, if any. */
	pendingTeardown?: NodeJS.Timeout;
}

type FleetGlobal = { [FLEET_REGISTRY_KEY]?: FleetRegistry };

function fleetGlobal(): FleetGlobal {
	return globalThis as unknown as FleetGlobal;
}

/**
 * Claim the global fleet for `runtimeId`, adopting any surviving services.
 *
 * Called from `session_start`. The returned registry is the one the runtime
 * must use for the rest of its life.
 */
export function acquireFleetRegistry(runtimeId: string): FleetRegistry {
	const existing = peekFleetRegistry();
	if (existing !== undefined) {
		// A successor is claiming the fleet: cancel the predecessor's deferred
		// teardown. The generation check inside that timer is only a backstop —
		// if `session_start` outlives the grace window, the timer would already
		// have fired.
		if (existing.pendingTeardown !== undefined) {
			clearTimeout(existing.pendingTeardown);
			existing.pendingTeardown = undefined;
		}
		existing.generation += 1;
		existing.ownerRuntimeId = runtimeId;
		return existing;
	}

	const registry: FleetRegistry = {
		generation: 1,
		ownerRuntimeId: runtimeId,
		services: new Map(),
		serviceSignatures: new Map(),
		createdAt: Date.now(),
	};
	fleetGlobal()[FLEET_REGISTRY_KEY] = registry;
	return registry;
}

/**
 * Release the global fleet.
 *
 * When `handoff` is true (the shutdown reason is `"reload"`), teardown is
 * deferred by `graceMs` so a successor runtime can adopt the services; the
 * deferred teardown then becomes a no-op. Otherwise every service is shut down
 * immediately.
 */
export function releaseFleetRegistry(
	runtimeId: string,
	options?: { handoff?: boolean; graceMs?: number },
): Promise<void> {
	const registry = peekFleetRegistry();
	// A stale runtime (a successor already claimed the fleet) must not tear it down.
	if (registry === undefined || registry.ownerRuntimeId !== runtimeId) {
		return Promise.resolve();
	}

	if (registry.pendingTeardown !== undefined) {
		clearTimeout(registry.pendingTeardown);
		registry.pendingTeardown = undefined;
	}

	if (options?.handoff !== true) {
		return teardownRegistry(registry);
	}

	const generation = registry.generation;
	const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
	const timer = setTimeout(() => {
		registry.pendingTeardown = undefined;
		if (peekFleetRegistry() !== registry) return;
		if (registry.generation !== generation || registry.ownerRuntimeId !== runtimeId) return;
		void teardownRegistry(registry);
	}, graceMs);
	timer.unref();
	registry.pendingTeardown = timer;
	return Promise.resolve();
}

/** Inspect the fleet without claiming it. Used by tests and `/lsp-status`. */
export function peekFleetRegistry(): FleetRegistry | undefined {
	return fleetGlobal()[FLEET_REGISTRY_KEY];
}

async function teardownRegistry(registry: FleetRegistry): Promise<void> {
	const services = [...registry.services.values()];
	registry.services.clear();
	registry.serviceSignatures.clear();

	const slot = fleetGlobal();
	if (slot[FLEET_REGISTRY_KEY] === registry) delete slot[FLEET_REGISTRY_KEY];

	await Promise.all(
		services.map(async (service) => {
			try {
				await service.shutdown();
			} catch {
				// A service that fails to shut down cleanly must not block the rest.
			}
		}),
	);
}

/**
 * Return the process-wide service for `cwd`, creating it on first use.
 *
 * Services are keyed by cwd. A service is reused only when the `ServerTable`,
 * `languageIds`, and `disabled` set it was built from are unchanged — compared
 * by content, because `resolveConfig` builds a fresh `Map` on every reload and
 * reference equality would discard the warm fleet every time. When they differ
 * the old service is replaced and shut down in the background; reconciling
 * individual clients is milestone M4.
 */
export function getLSPService(options: LSPServiceOptions): LSPService {
	const registry = peekFleetRegistry() ?? acquireFleetRegistry("");
	const cwd = normalizePath(options.cwd);
	const signature = serverTableSignature(options.servers, options.languageIds, options.disabled);

	const existing = registry.services.get(cwd);
	if (existing !== undefined && registry.serviceSignatures.get(cwd) === signature) {
		return existing;
	}
	if (existing !== undefined) {
		void existing.shutdown().catch(() => {});
	}

	const service = createLSPService({ ...options, cwd });
	registry.services.set(cwd, service);
	registry.serviceSignatures.set(cwd, signature);
	return service;
}

// ---------------------------------------------------------------------------
// Server-table signature
// ---------------------------------------------------------------------------

const functionIdentities = new WeakMap<object, number>();
let nextFunctionIdentity = 1;

/** Identity for a function/object that cannot be compared by value. */
function identityOf(value: object): number {
	let identity = functionIdentities.get(value);
	if (identity === undefined) {
		identity = nextFunctionIdentity++;
		functionIdentities.set(value, identity);
	}
	return identity;
}

/**
 * A content signature for a resolved server table.
 *
 * Functions (`cmd`, `rootDir`) are compared by identity: a config that defines
 * one is re-evaluated by jiti on every reload, so it produces a new function and
 * a different signature. That is a deliberate over-invalidation — a dynamic
 * `cmd` may close over anything, and restarting is safer than reusing a client
 * launched from a stale closure.
 */
function serverTableSignature(
	servers: ServerTable,
	languageIds: ReadonlyMap<string, string>,
	disabled: ReadonlySet<string> | undefined,
): string {
	const entries: string[] = [];
	for (const [id, spec] of servers) {
		entries.push(
			[
				id,
				Array.isArray(spec.cmd) ? spec.cmd.join("\u0001") : `fn:${identityOf(spec.cmd)}`,
				(spec.filetypes ?? []).join("\u0001"),
				(spec.rootMarkers ?? []).join("\u0001"),
				spec.rootDir === undefined ? "" : `fn:${identityOf(spec.rootDir)}`,
				spec.singleFileSupport === true ? "1" : "0",
				String(spec.initializeTimeoutMs ?? ""),
				stableJson(spec.initOptions),
				stableJson(spec.settings),
				stableJson(spec.env),
				stableJson(spec.capabilities),
			].join("\u0002"),
		);
	}

	const languages = [...languageIds.entries()]
		.map(([extension, languageId]) => `${extension}=${languageId}`)
		.join("\u0001");
	const disabledIds = [...(disabled ?? [])].sort().join("\u0001");
	return `${entries.join("\u0003")}\u0004${languages}\u0004${disabledIds}`;
}

/** JSON with object keys sorted, so key order never changes a signature. */
function stableJson(value: unknown): string {
	if (value === undefined) return "";
	const seen = new WeakSet<object>();

	const normalize = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(normalize);
		if (typeof input === "function") return `fn:${identityOf(input)}`;
		if (input !== null && typeof input === "object") {
			if (seen.has(input)) return "[circular]";
			seen.add(input);
			const output: Record<string, unknown> = {};
			for (const key of Object.keys(input).sort()) {
				output[key] = normalize((input as Record<string, unknown>)[key]);
			}
			return output;
		}
		return input;
	};

	try {
		return JSON.stringify(normalize(value)) ?? "";
	} catch {
		return String(value);
	}
}
