/**
 * pi-lspconfig — Language Server Protocol support for pi.
 *
 * Out-of-the-box LSP configs for common languages, overridable from a
 * `pi-lspconfig.config.ts` file, exposed through one unified `lsp` tool and an
 * `lsp_diagnostics` tool.
 *
 * The default export is the Pi extension factory. The named exports are the
 * public authoring API used inside a config file:
 *
 * ```ts
 * import { defineConfig } from "pi-lspconfig";
 *
 * export default defineConfig({
 *   servers: {
 *     pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } },
 *   },
 * });
 * ```
 *
 * @see README.md for installation, ROADMAP.md for milestone status.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLspCommands } from "./extension/commands.ts";
import { registerLspFlags } from "./extension/flags.ts";
import { createSessionState, installLifecycle } from "./extension/lifecycle.ts";
import { registerLspTools } from "./extension/register.ts";

/**
 * Extension factory.
 *
 * Synchronous on purpose: everything registered here is a declaration, and
 * nothing long-lived may start before `session_start`.
 */
export default function piLspconfig(pi: ExtensionAPI): void {
	const state = createSessionState();

	registerLspFlags(pi);
	installLifecycle(pi, state);
	registerLspTools(pi, state);
	registerLspCommands(pi, state);
}

// ---------------------------------------------------------------------------
// Public authoring API
// ---------------------------------------------------------------------------

export { defineConfig, validateUserConfig } from "./config/schema.ts";
export type { ConfigValidationResult } from "./config/schema.ts";
export { BUILTIN_SERVERS, EXTENSION_TO_LANGUAGE_ID } from "./languages/index.ts";
export { LSP_OPERATIONS } from "./core/operations.ts";
export type { LspOperation, OperationRequest } from "./core/operations.ts";
export type {
	LaunchContext,
	LspconfigUserConfig,
	LspDiagnostic,
	LspEnvelope,
	LspLocation,
	LspServerSpec,
	LspServerSpecInput,
	LspStatus,
	RootCtx,
	ServerTable,
} from "./types.ts";
