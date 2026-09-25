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

/**
 * Filenames that carry a language despite having no extension.
 *
 * Consulted only after the extension lookup fails, so `package.json` and
 * `Cargo.lock` still resolve to `undefined` (`.json` and `.lock` are not
 * registered). The entries exist so a user-defined server that declares one of
 * these language ids is reachable for a file like `Dockerfile`.
 */
const WELL_KNOWN_FILENAMES: Readonly<Record<string, string>> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
};

export function createServerResolver(options: CreateServerResolverOptions): ServerResolver {
	const disabled = options.disabled ?? new Set<string>();

	const specs: LspServerSpec[] = [];
	const byLanguage = new Map<string, LspServerSpec[]>();

	for (const [id, spec] of options.servers) {
		if (disabled.has(id)) continue;
		specs.push(spec);

		const seen = new Set<string>();
		for (const languageId of spec.filetypes) {
			if (seen.has(languageId)) continue;
			seen.add(languageId);
			const bucket = byLanguage.get(languageId);
			if (bucket === undefined) byLanguage.set(languageId, [spec]);
			else bucket.push(spec);
		}
	}

	const languageIdFor = (path: string): string | undefined =>
		detectLanguageId(path, options.languageIds);

	const serversFor = (path: string): readonly LspServerSpec[] => {
		const languageId = languageIdFor(path);
		if (languageId === undefined) return [];
		return byLanguage.get(languageId) ?? [];
	};

	return {
		resolve: (path) => {
			const languageId = languageIdFor(path);
			if (languageId === undefined) return undefined;
			const server = (byLanguage.get(languageId) ?? [])[0];
			if (server === undefined) return undefined;
			return { server, languageId };
		},
		serversFor,
		languageIdFor,
		all: () => specs,
	};
}

/** Lower-case extension including the leading dot, or `undefined` for extensionless files. */
export function extensionOf(path: string): string | undefined {
	const base = baseNameOf(path);
	const index = base.lastIndexOf(".");
	// `index === 0` is a dotfile (`.gitignore`), which has no extension.
	if (index <= 0) return undefined;
	return base.slice(index).toLowerCase();
}

/**
 * Language id for a path, with well-known filename fallbacks.
 *
 * Handles extensionless files that still have a language (`Dockerfile`,
 * `Makefile`) and multi-dot names (`package.json`, `Cargo.lock`) — the latter by
 * looking at the *last* dot, so `foo.test.ts` is TypeScript.
 */
export function detectLanguageId(
	path: string,
	extensions: ReadonlyMap<string, string>,
): string | undefined {
	const extension = extensionOf(path);
	if (extension !== undefined) {
		const languageId = extensions.get(extension);
		if (languageId !== undefined) return languageId;
	}
	return WELL_KNOWN_FILENAMES[baseNameOf(path).toLowerCase()];
}

/** Final path segment, splitting on both separators regardless of host. */
function baseNameOf(path: string): string {
	return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}
