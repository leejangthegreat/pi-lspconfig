/**
 * CLI flag registration.
 *
 * Flags are registered from the extension factory (a pure declaration, no
 * resources started) and read lazily, so a flag set on the command line is
 * visible by the time `session_start` runs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLogSetting, type LogSetting } from "../util/logger.ts";

/** `--lsp-disable`: turn the extension off for one invocation. */
export const LSP_DISABLE_FLAG = "lsp-disable";

/** `--lsp-log <off|error|warn|info|debug|verbose>`: stderr log verbosity. */
export const LSP_LOG_FLAG = "lsp-log";

export interface LspFlags {
	/** When true, no language server is started and tools report `status: "disabled"`. */
	disabled: boolean;
	/** Effective stderr log level. */
	logLevel: LogSetting;
}

/** Register every pi-lspconfig flag. Safe to call from the extension factory. */
export function registerLspFlags(pi: ExtensionAPI): void {
	pi.registerFlag(LSP_DISABLE_FLAG, {
		description: "Disable pi-lspconfig for this invocation",
		type: "boolean",
		default: false,
	});

	pi.registerFlag(LSP_LOG_FLAG, {
		description: "pi-lspconfig stderr log level (off, error, warn, info, debug, verbose)",
		type: "string",
		default: "off",
	});
}

/** Read the current flag values. */
export function readLspFlags(pi: ExtensionAPI): LspFlags {
	return {
		disabled: pi.getFlag(LSP_DISABLE_FLAG) === true,
		logLevel: parseLogSetting(pi.getFlag(LSP_LOG_FLAG)),
	};
}
