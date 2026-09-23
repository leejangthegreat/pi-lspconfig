/**
 * The built-in server catalog.
 *
 * One module per server under `src/languages/`, aggregated here — mirroring
 * nvim-lspconfig's `lsp/<name>.lua` layout rather than a central registry
 * object. Adding a language means adding a file and one line below.
 *
 * See `ROADMAP.md` → "Adding a language server" for the full checklist.
 */

import { gopls } from "./go.ts";
import { pyright } from "./python.ts";
import { rustAnalyzer } from "./rust.ts";
import { vtsls } from "./typescript.ts";
import type { LspServerSpec } from "../types.ts";

/** Every server shipped with pi-lspconfig, in documentation order. */
export const BUILTIN_SERVERS: readonly LspServerSpec[] = [vtsls, pyright, rustAnalyzer, gopls];

/** Convenience index for `getServerById`-style lookups. */
export const BUILTIN_SERVERS_BY_ID: ReadonlyMap<string, LspServerSpec> = new Map(
	BUILTIN_SERVERS.map((server) => [server.id, server]),
);

/**
 * File extension → LSP `languageId`.
 *
 * This is the canonical registry: `core/registry.ts` derives server selection
 * from it, and user config may extend it via `languageIds`.
 *
 * Extensions are lower-case and include the leading dot.
 */
export const EXTENSION_TO_LANGUAGE_ID: Readonly<Record<string, string>> = {
	// TypeScript / JavaScript
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",

	// Python
	".py": "python",
	".pyi": "python",

	// Rust
	".rs": "rust",

	// Go
	".go": "go",
	".mod": "gomod",
	".work": "gowork",
};

/** Language ids every server in the catalog may handle, for docs generation. */
export function languagesForServer(server: LspServerSpec): string[] {
	return [...server.filetypes];
}
