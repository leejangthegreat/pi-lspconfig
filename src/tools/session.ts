/**
 * The live session snapshot the tools read on every call.
 *
 * Tool deps are built in the extension factory — before `session_start` — so
 * they must never capture the service, the logger, or the resolved config.
 * All three appear at `session_start`, disappear at `session_shutdown`, and are
 * replaced on `/reload`; a captured value is either the silent pre-session
 * logger or a service from a dead generation.
 */

import type { LSPService } from "../core/service.ts";
import type { Logger } from "../util/logger.ts";

export interface ToolSession {
	/** Absent before `session_start`, after shutdown, and under `--lsp-disable`. */
	service: LSPService | undefined;
	logger: Logger;
	/** Effective result cap, from the resolved config. */
	maxResults: number;
}
