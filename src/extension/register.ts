/**
 * Tool registration.
 *
 * Tools are registered from the extension factory, which is safe: registration
 * is a pure declaration. The expensive part — starting a language server — is
 * deferred until a tool call actually needs one, so a session that never asks
 * for code intelligence spawns nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLspDiagnosticsTool, type LspDiagnosticsToolDeps } from "../tools/lsp-diagnostics.ts";
import { createLspTool, type LspToolDeps } from "../tools/lsp.ts";
import { DEFAULT_MAX_RESULTS } from "../util/defaults.ts";
import type { SessionState } from "./lifecycle.ts";

/** Build the resolver the tool layer uses to reach the current session. */
export function createToolDeps(state: SessionState): LspToolDeps & LspDiagnosticsToolDeps {
	return {
		// Read through to `state` on every call. The service is absent before
		// `session_start` and after `session_shutdown`, the logger is silent
		// until `refreshFlags` runs, and the config appears only once the
		// session has started — so none of the three can be captured here.
		getSession: () => ({
			service: state.service,
			logger: state.logger,
			maxResults: state.config?.maxResults ?? DEFAULT_MAX_RESULTS,
		}),
	};
}

/** Register the unified `lsp` tool and `lsp_diagnostics`. */
export function registerLspTools(pi: ExtensionAPI, state: SessionState): void {
	const deps = createToolDeps(state);
	pi.registerTool(createLspTool(deps));
	pi.registerTool(createLspDiagnosticsTool(deps));
}
