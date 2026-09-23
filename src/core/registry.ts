/**
 * File → language server resolution.
 *
 * The resolver owns the mapping from a path to `(server, languageId)`:
 * extension → languageId (from the canonical registry, plus user overrides),
 * then languageId → server (from the resolved `ServerTable`).
 *
 * It is a pure function of the table it is constructed with, so tests can hand
 * it a two-entry table instead of the real catalog.
 */

import type { LspServerSpec, ServerTable } from "../types.ts";

export interface ServerMatch {
	server: LspServerSpec;
	languageId: string;
}

export interface ServerResolver {
	/** The best server for a path, or `undefined` when nothing handles it. */
	resolve(path: string): ServerMatch | undefined;
	/** Every server that declares the path's language, in table order. */
	serversFor(path: string): readonly LspServerSpec[];
	/** Language id for a path, before server selection. */
	languageIdFor(path: string): string | undefined;
	/** Every configured server, for `/lsp-list`. */
	all(): readonly LspServerSpec[];
}

export interface CreateServerResolverOptions {
	servers: ServerTable;
	/** Extension → languageId, already merged with user overrides. */
	languageIds: ReadonlyMap<string, string>;
	/** Ids that must never be selected, even when a server declares them. */
	disabled?: ReadonlySet<string>;
}

export function createServerResolver(_options: CreateServerResolverOptions): ServerResolver {
	throw new Error("Not implemented: createServerResolver");
}

/** Lower-case extension including the leading dot, or `undefined` for extensionless files. */
export function extensionOf(_path: string): string | undefined {
	throw new Error("Not implemented: extensionOf");
}

/**
 * Language id for a path, with well-known filename fallbacks.
 *
 * Handles extensionless files that still have a language (`Dockerfile`,
 * `Makefile`) and multi-dot names (`package.json`, `Cargo.lock`).
 */
export function detectLanguageId(
	_path: string,
	_extensions: ReadonlyMap<string, string>,
): string | undefined {
	throw new Error("Not implemented: detectLanguageId");
}
