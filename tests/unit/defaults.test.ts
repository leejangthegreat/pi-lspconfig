/**
 * Client capability invariants.
 *
 * The engine only consumes pushed diagnostics, so the pull capabilities must
 * stay unadvertised until a pull request is implemented: a server that sees
 * them is free to stop pushing, which would surface as silently empty
 * `lsp_diagnostics` results rather than an error.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_CAPABILITIES } from "../../src/util/defaults.ts";

describe("DEFAULT_CLIENT_CAPABILITIES", () => {
	it("advertises push diagnostics and never pull", () => {
		const textDocument = DEFAULT_CLIENT_CAPABILITIES.textDocument as Record<string, unknown>;
		const workspace = DEFAULT_CLIENT_CAPABILITIES.workspace as Record<string, unknown>;

		expect(textDocument.publishDiagnostics).toBeDefined();
		expect(textDocument.diagnostic).toBeUndefined();
		expect(workspace.diagnostics).toBeUndefined();
	});
});
