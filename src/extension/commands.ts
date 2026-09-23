/**
 * Slash commands.
 *
 * Commands exist so a user can inspect and repair the extension without asking
 * the model to call a tool — the common case being "why is this file not
 * getting diagnostics?".
 *
 * Handlers are registered from the factory (a pure declaration) and read
 * `state` lazily at invocation time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./lifecycle.ts";

const NOT_RUNNING = "pi-lspconfig: no language server is running for this session.";

/** Register `/lsp-status`, `/lsp-restart`, `/lsp-list`, and `/lsp-config`. */
export function registerLspCommands(pi: ExtensionAPI, state: SessionState): void {
	pi.registerCommand("lsp-status", {
		description: "Show running language servers, their roots, and diagnostic counts",
		handler: async (_args, ctx) => {
			const service = state.service;
			if (!service) {
				ctx.ui.notify(NOT_RUNNING, "info");
				return;
			}
			// M4: render `service.status()` as a table (server, root, state, diagnostics).
			ctx.ui.notify("pi-lspconfig: /lsp-status is not implemented yet.", "info");
		},
	});

	pi.registerCommand("lsp-restart", {
		description: "Restart a language server, or all of them: /lsp-restart [server]",
		handler: async (_args, ctx) => {
			const service = state.service;
			if (!service) {
				ctx.ui.notify(NOT_RUNNING, "info");
				return;
			}
			// M4: `await service.restart(args.trim() || undefined)` then report.
			ctx.ui.notify("pi-lspconfig: /lsp-restart is not implemented yet.", "info");
		},
	});

	pi.registerCommand("lsp-list", {
		description: "List configured language servers",
		handler: async (_args, ctx) => {
			const config = state.config;
			if (!config) {
				ctx.ui.notify("pi-lspconfig: configuration has not been resolved yet.", "info");
				return;
			}
			// M4: list `config.servers` with id, filetypes, cmd, and disabled flag.
			ctx.ui.notify("pi-lspconfig: /lsp-list is not implemented yet.", "info");
		},
	});

	pi.registerCommand("lsp-config", {
		description: "Show the resolved configuration for a server: /lsp-config <server>",
		handler: async (_args, ctx) => {
			const config = state.config;
			if (!config) {
				ctx.ui.notify("pi-lspconfig: configuration has not been resolved yet.", "info");
				return;
			}
			// M4: dump the merged spec for the requested id, plus `config.notes`.
			ctx.ui.notify("pi-lspconfig: /lsp-config is not implemented yet.", "info");
		},
	});
}
