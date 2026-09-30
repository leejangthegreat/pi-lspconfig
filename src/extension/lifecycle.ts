/**
 * Session lifecycle: the composition root.
 *
 * This is the only module that knows about both the Pi host and the LSP
 * engine. It wires them together and owns the session-scoped state:
 *
 * ```
 * session_start
 *   ├─ load config          (trust-gated; project files skipped when untrusted)
 *   ├─ resolve server table (built-ins + user overrides)
 *   ├─ acquire fleet        (adopts a surviving fleet on /reload)
 *   └─ bind LSPService
 * session_shutdown
 *   └─ release fleet        (deferred handoff on reload, teardown otherwise)
 * ```
 *
 * Two hard rules, both from the Pi extension contract:
 *
 *  1. **Nothing long-lived starts in the factory.** The factory may run in
 *     invocations that never start a session, so processes are only ever
 *     created here or lazily from a tool call.
 *  2. **`session_start` never throws.** A broken config file or a missing
 *     binary must not take the session down; failures are reported and the
 *     tools degrade to `status: "error"` / `"binary_missing"`.
 *
 * A third rule governs reload: after `session_shutdown` the runtime is stale
 * and Pi throws on any captured `pi`/`ctx` use, so teardown takes no `ctx` and
 * scrubs the session state it releases. Config freshness across the boundary
 * comes from the mtime cache in `config/load.ts`, not from `ctx`.
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { loadUserConfig } from "../config/load.ts";
import { resolveConfig, type ResolvedConfig } from "../config/resolve.ts";
import {
	acquireFleetRegistry,
	getLSPService,
	releaseFleetRegistry,
	type FleetRegistry,
	type LSPService,
} from "../core/service.ts";
import { BUILTIN_SERVERS } from "../languages/index.ts";
import { createLogger, type Logger } from "../util/logger.ts";
import { readLspFlags, type LspFlags } from "./flags.ts";

/** Mutable state owned by one extension runtime instance. */
export interface SessionState {
	/** Unique per extension-runtime load; used for fleet ownership handoff. */
	runtimeId: string;
	/**
	 * Effective flag values.
	 *
	 * Placeholder values until `session_start`: Pi binds command-line values
	 * only after every extension has finished loading, so reading them from the
	 * factory would always yield the defaults.
	 */
	flags: LspFlags;
	/** Silent until {@link refreshFlags} runs at `session_start`. */
	logger: Logger;
	/** Working directory captured at `session_start`. */
	cwd: string | undefined;
	/** Config resolved for the current session. */
	config: ResolvedConfig | undefined;
	/** The process-global fleet claimed by this runtime. */
	registry: FleetRegistry | undefined;
	/** Bound service, absent until `session_start` completes and after shutdown. */
	service: LSPService | undefined;
	/**
	 * Server ids already announced as missing, so a failing tool call nags once
	 * per session instead of on every call. Per runtime: `/reload` may remind.
	 */
	notifiedBinaryMissing: Set<string>;
}

/** Build the per-runtime state object. Called from the extension factory. */
export function createSessionState(): SessionState {
	return {
		runtimeId: randomUUID(),
		flags: { disabled: false, logLevel: "off" },
		logger: createLogger({ level: "off" }),
		cwd: undefined,
		config: undefined,
		registry: undefined,
		service: undefined,
		notifiedBinaryMissing: new Set(),
	};
}

/**
 * Re-read flags and rebuild the logger.
 *
 * Must run at `session_start`, not in the factory: command-line flag values are
 * bound after extension loading completes.
 */
export function refreshFlags(state: SessionState, pi: ExtensionAPI): void {
	state.flags = readLspFlags(pi);
	state.logger = createLogger({ level: state.flags.logLevel });
}

/**
 * Start a session: load config, resolve the server table, claim the fleet, and
 * bind the service.
 *
 * Called from `session_start`. Must not throw — `installLifecycle` catches, but
 * this function is also directly testable and should report through `notes`.
 */
export async function startSession(
	state: SessionState,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<void> {
	state.cwd = ctx.cwd;

	if (state.flags.disabled) {
		ctx.ui.setStatus("pi-lspconfig", "disabled");
		state.logger.debug("disabled via --lsp-disable");
		return;
	}

	const loaded = await loadUserConfig({
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});

	for (const failure of loaded.errors) {
		state.logger.warn(`config error in ${failure.file}: ${failure.message}`);
		ctx.ui.notify(`pi-lspconfig: ${failure.file}: ${failure.message}`, "warning");
	}

	// One notification per session, not one per file: a project with both a
	// root and a `.pi` config would otherwise nag twice for one decision.
	if (loaded.skipped.length > 0) {
		const files = loaded.skipped.join(", ");
		state.logger.info(`skipped ${loaded.skipped.length} untrusted project config file(s)`);
		ctx.ui.notify(
			`pi-lspconfig: ignoring project config (${files}) — the project is not trusted.`,
			"info",
		);
	}

	const resolved = resolveConfig(loaded.config, BUILTIN_SERVERS);
	state.config = resolved;

	const registry = acquireFleetRegistry(state.runtimeId);
	state.registry = registry;

	const service = getLSPService({
		servers: resolved.servers,
		cwd: ctx.cwd,
		languageIds: resolved.languageIds,
		disabled: resolved.disabled,
		logger: state.logger,
	});
	state.service = service;

	ctx.ui.setStatus("pi-lspconfig", `${resolved.servers.size} servers`);
	state.logger.info(
		`session ready (${event.reason}): ${resolved.servers.size} servers, ${loaded.files.length} config file(s)`,
	);
}

/**
 * End a session.
 *
 * On `reason === "reload"` teardown is deferred so the successor runtime can
 * adopt the warm fleet; otherwise every process is stopped.
 *
 * Takes no `ctx` on purpose: this runs after the reload boundary, where Pi
 * treats a captured context as stale and throws on use.
 */
export async function endSession(state: SessionState, event: SessionShutdownEvent): Promise<void> {
	const handoff = event.reason === "reload";

	// Scrub before the await: a successor may claim the fleet while this
	// teardown is in flight, and the old runtime must hold nothing usable.
	state.service = undefined;
	state.config = undefined;

	if (state.registry) {
		await releaseFleetRegistry(state.runtimeId, { handoff });
		state.registry = undefined;
	}

	state.logger.debug(`session shutdown (${event.reason}${handoff ? ", handing off" : ""})`);
}

/**
 * Register every lifecycle handler.
 *
 * Handlers are deliberately thin: each delegates to an exported function so
 * the behaviour is testable without a Pi runtime.
 */
export function installLifecycle(pi: ExtensionAPI, state: SessionState): void {
	pi.on("session_start", async (event, ctx) => {
		refreshFlags(state, pi);
		try {
			await startSession(state, event, ctx);
		} catch (error) {
			reportStartupFailure(state, ctx, error);
		}
	});

	pi.on("session_shutdown", async (event) => {
		try {
			await endSession(state, event);
		} catch (error) {
			state.logger.error("session shutdown failed", error);
		}
	});

	// Pi's built-in `edit`/`write` change files behind the language server's
	// back. The next LSP request re-reads from disk, so correctness does not
	// depend on this hook — it only lets us skip a redundant re-sync.
	//
	// Nothing for other tools: `read`/`grep`/`find` do not change bytes, and a
	// shell command that edits a file gives no reliable signal at all.
	pi.on("tool_result", (event, ctx) => {
		try {
			notifyMissingBinary(state, ctx, event);
			if (event.isError) return;
			if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

			const path = event.input.path;
			if (typeof path !== "string" || path.length === 0) return;
			state.service?.markDirty(resolvePath(ctx.cwd, path));
		} catch (error) {
			state.logger.debug("markDirty hook failed", error);
		}
	});
}

/**
 * Tell the user once per server that a binary is missing.
 *
 * The tool result already carries the hint to the model; this is for the human,
 * who would otherwise watch the same failure scroll by on every call. The
 * envelope's `servers` field is what makes the dedupe key possible — it is set
 * on `binary_missing` by the service.
 */
function notifyMissingBinary(
	state: SessionState,
	ctx: ExtensionContext,
	event: ToolResultEvent,
): void {
	if (event.toolName !== "lsp" && event.toolName !== "lsp_diagnostics") return;
	if (!ctx.hasUI) return;

	const envelope = binaryMissingEnvelope(event.details);
	if (envelope === undefined) return;

	const serverId = Array.isArray(envelope.servers) ? envelope.servers[0] : undefined;
	if (typeof serverId !== "string" || state.notifiedBinaryMissing.has(serverId)) return;
	state.notifiedBinaryMissing.add(serverId);

	const parts = [`pi-lspconfig: ${serverId} is not installed.`];
	const note = firstString(envelope.notes);
	if (note !== undefined) parts.push(note);
	const hint = installHint(envelope.hints);
	if (hint !== undefined) parts.push(hint);
	ctx.ui.notify(parts.join(" "), "warning");
}

interface BinaryMissingEnvelope {
	status: "binary_missing";
	servers?: unknown;
	notes?: unknown;
	hints?: unknown;
}

function binaryMissingEnvelope(details: unknown): BinaryMissingEnvelope | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	if ((details as { status?: unknown }).status !== "binary_missing") return undefined;
	return details as BinaryMissingEnvelope;
}

function firstString(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Prefer the actionable install command over the generic override hint. */
function installHint(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const hints = value.filter((entry): entry is string => typeof entry === "string");
	return hints.find((hint) => hint.startsWith("Install it with:")) ?? hints[0];
}

function reportStartupFailure(state: SessionState, ctx: ExtensionContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	state.logger.error("session start failed", error);

	if (ctx.hasUI) {
		ctx.ui.notify(`pi-lspconfig: ${message}`, "warning");
	}
}
