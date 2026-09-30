/**
 * Slash commands.
 *
 * Commands exist so a user can inspect and repair the extension without asking
 * the model to call a tool — the common case being "why is this file not
 * getting diagnostics?".
 *
 * Handlers are registered from the factory (a pure declaration) and read
 * `state` lazily at invocation time. Each one delegates to an exported function
 * that returns a rendered outcome, so the behaviour is testable without a Pi
 * runtime.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LspServerSpec } from "../types.ts";
import type { SessionState } from "./lifecycle.ts";

/** A command's answer: exactly one notification. */
export interface CommandOutcome {
	message: string;
	level: "info" | "warning";
}

const PREFIX = "pi-lspconfig: ";
const NOT_RUNNING = `${PREFIX}no language server is running for this session.`;
const NOT_RESOLVED = `${PREFIX}configuration has not been resolved yet.`;
const DISABLED = `${PREFIX}disabled via --lsp-disable.`;

/** Register `/lsp-status`, `/lsp-restart`, `/lsp-list`, and `/lsp-config`. */
export function registerLspCommands(pi: ExtensionAPI, state: SessionState): void {
	pi.registerCommand("lsp-status", {
		description: "Show running language servers, their roots, and diagnostic counts",
		handler: async (_args, ctx) => {
			notify(ctx, statusCommand(state));
		},
	});

	pi.registerCommand("lsp-restart", {
		description: "Restart a language server, or all of them: /lsp-restart [server]",
		handler: async (args, ctx) => {
			notify(ctx, await restartCommand(state, args));
		},
	});

	pi.registerCommand("lsp-list", {
		description: "List configured language servers",
		handler: async (_args, ctx) => {
			notify(ctx, listCommand(state));
		},
	});

	pi.registerCommand("lsp-config", {
		description: "Show the resolved configuration for a server: /lsp-config <server>",
		handler: async (args, ctx) => {
			notify(ctx, configCommand(state, args));
		},
	});
}

/** What is actually running, and how healthy it is. */
export function statusCommand(state: SessionState): CommandOutcome {
	if (state.flags.disabled) return info(DISABLED);

	const service = state.service;
	if (service === undefined) return info(NOT_RUNNING);

	const clients = service.status();
	if (clients.length === 0) {
		return info(`${PREFIX}no language servers have been started yet; they start on first use.`);
	}

	const lines = [`${PREFIX}${plural(clients.length, "language server")} running`];
	for (const client of clients) {
		const root = client.root ?? "(none)";
		const pid = client.pid === undefined ? "-" : String(client.pid);
		const lastError = client.lastError === undefined ? "" : `  error ${client.lastError}`;
		lines.push(
			`  ${client.serverId}  ${client.state}  root ${root}  pid ${pid}  documents ${client.openDocuments}  diagnostics ${client.diagnosticCount}${lastError}`,
		);
	}
	return info(lines.join("\n"));
}

/** Restart one server, or every server. */
export async function restartCommand(state: SessionState, args: string): Promise<CommandOutcome> {
	if (state.flags.disabled) return info(DISABLED);

	const service = state.service;
	if (service === undefined) return info(NOT_RUNNING);

	const id = args.trim();
	try {
		if (id.length > 0) {
			// `restart` quietly tears down nothing for an unknown id, so the id
			// has to be checked here to avoid reporting a restart that never ran.
			if (!service.allServers().some((spec) => spec.id === id)) {
				return warn(`${PREFIX}unknown server '${id}'. Configured: ${configuredIds(state)}.`);
			}
			await service.restart(id);
			return info(`${PREFIX}restarted '${id}'; it starts again on the next request.`);
		}

		const running = service.status().length;
		await service.restart();
		return info(
			running === 0
				? `${PREFIX}no language servers were running.`
				: `${PREFIX}restarted ${plural(running, "language server")}.`,
		);
	} catch (error) {
		return warn(`${PREFIX}restart failed: ${messageOf(error)}`);
	}
}

/** Every configured server. */
export function listCommand(state: SessionState): CommandOutcome {
	const config = state.config;
	if (config === undefined) return info(NOT_RESOLVED);

	const servers = [...config.servers.values()];
	if (servers.length === 0) return info(`${PREFIX}no language servers are configured.`);

	const lines = [`${PREFIX}${plural(servers.length, "language server")} configured`];
	for (const spec of servers) lines.push(`  ${describeSpec(spec)}`);
	if (config.disabled.size > 0) lines.push(`  disabled: ${[...config.disabled].join(", ")}`);
	return info(lines.join("\n"));
}

/** The merged spec for one server, plus anything resolution changed about it. */
export function configCommand(state: SessionState, args: string): CommandOutcome {
	const config = state.config;
	if (config === undefined) return info(NOT_RESOLVED);

	const id = args.trim();
	if (id.length === 0) {
		return info(`${PREFIX}usage: /lsp-config <server>. Known servers: ${configuredIds(state)}.`);
	}

	const spec = config.servers.get(id);
	if (spec === undefined) {
		return info(`${PREFIX}unknown server '${id}'. Known servers: ${configuredIds(state)}.`);
	}

	const lines = [`${PREFIX}${spec.id}`];
	lines.push(`  cmd: ${Array.isArray(spec.cmd) ? spec.cmd.join(" ") : "(dynamic)"}`);
	lines.push(`  filetypes: ${spec.filetypes.length > 0 ? spec.filetypes.join(", ") : "(none)"}`);
	if (spec.rootMarkers !== undefined && spec.rootMarkers.length > 0) {
		lines.push(`  rootMarkers: ${spec.rootMarkers.join(", ")}`);
	}
	if (spec.rootDir !== undefined) lines.push("  rootDir: (function)");
	if (spec.singleFileSupport === true) lines.push("  singleFileSupport: true");
	if (spec.initializeTimeoutMs !== undefined) {
		lines.push(`  initializeTimeoutMs: ${spec.initializeTimeoutMs}`);
	}
	if (spec.settings !== undefined) lines.push(`  settings: ${JSON.stringify(spec.settings)}`);
	if (spec.initOptions !== undefined) lines.push(`  initOptions: ${JSON.stringify(spec.initOptions)}`);
	if (spec.docs !== undefined) {
		const url = spec.docs.url === undefined ? "" : ` ${spec.docs.url}`;
		lines.push(`  docs: ${spec.docs.description}${url}`);
	}

	const notes = config.notes.filter((note) => note.startsWith(`${spec.id}:`));
	lines.push(`  notes: ${notes.length > 0 ? notes.join("; ") : "(none)"}`);
	return info(lines.join("\n"));
}

function notify(ctx: ExtensionCommandContext, outcome: CommandOutcome): void {
	ctx.ui.notify(outcome.message, outcome.level);
}

function describeSpec(spec: LspServerSpec): string {
	const filetypes = spec.filetypes.length > 0 ? spec.filetypes.join(", ") : "(no filetypes)";
	const cmd = Array.isArray(spec.cmd) ? spec.cmd.join(" ") : "(dynamic cmd)";
	return `${spec.id}  ${filetypes}  ${cmd}`;
}

function configuredIds(state: SessionState): string {
	const ids = state.config === undefined ? [] : [...state.config.servers.keys()];
	return ids.length > 0 ? ids.join(", ") : "none";
}

function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function info(message: string): CommandOutcome {
	return { message, level: "info" };
}

function warn(message: string): CommandOutcome {
	return { message, level: "warning" };
}
