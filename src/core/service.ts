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

import type { ClientCapabilities, Diagnostic } from "../protocol.ts";
import type { LspClientStatus, ServerTable, TouchFileOptions } from "../types.ts";
import type { Logger } from "../util/logger.ts";
import type { WaitForDiagnosticsOptions } from "./client/diagnostics.ts";
import type { SpawnFn } from "./client/launch.ts";

export interface LSPServiceOptions {
	/** Resolved server table. The service never reads user config itself. */
	servers: ServerTable;
	/** Session working directory; also the root-detection ceiling. */
	cwd: string;
	logger: Logger;
	/** Injectable launcher, for tests. Defaults to `defaultSpawn`. */
	spawn?: SpawnFn;
	/** Overrides merged over `DEFAULT_CLIENT_CAPABILITIES`. */
	clientCapabilities?: ClientCapabilities;
	/** Default handshake timeout for servers that do not set their own. */
	initializeTimeoutMs?: number;
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
	/** Restart one server, or all of them when `serverId` is omitted. */
	restart(serverId?: string): Promise<void>;
	/** Idempotent teardown: close documents, then stop every process. */
	shutdown(): Promise<void>;
}

/** Create a fleet. Prefer {@link getLSPService} so reloads share one fleet. */
export function createLSPService(_options: LSPServiceOptions): LSPService {
	throw new Error("Not implemented: createLSPService");
}

/** Return the process-wide service for `cwd`, creating it on first use. */
export function getLSPService(_options: LSPServiceOptions): LSPService {
	throw new Error("Not implemented: getLSPService");
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
	/** Live services, keyed by `${serverId}\0${root ?? ""}`. */
	services: Map<string, LSPService>;
	createdAt: number;
}

/**
 * Claim the global fleet for `runtimeId`, adopting any surviving services.
 *
 * Called from `session_start`. The returned registry is the one the runtime
 * must use for the rest of its life.
 */
export function acquireFleetRegistry(_runtimeId: string): FleetRegistry {
	throw new Error("Not implemented: acquireFleetRegistry");
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
	_runtimeId: string,
	_options?: { handoff?: boolean; graceMs?: number },
): Promise<void> {
	throw new Error("Not implemented: releaseFleetRegistry");
}

/** Inspect the fleet without claiming it. Used by tests and `/lsp-status`. */
export function peekFleetRegistry(): FleetRegistry | undefined {
	throw new Error("Not implemented: peekFleetRegistry");
}
