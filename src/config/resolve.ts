/**
 * Resolve built-in server specs plus user config into the `ServerTable` the
 * LSP engine consumes.
 *
 * This is where the override policy from `util/merge.ts` is applied to real
 * server specs. The engine never sees user config directly — it receives an
 * already-resolved table, which keeps `core/` free of config imports and makes
 * the fleet trivially testable with a hand-written table.
 */

import { EXTENSION_TO_LANGUAGE_ID } from "../languages/index.ts";
import type { LspServerSpec, LspServerSpecInput, LspconfigUserConfig, ServerTable } from "../types.ts";
import { collectDeletedKeys, deepMerge } from "../util/merge.ts";
import { DEFAULT_MAX_RESULTS } from "../util/defaults.ts";

export interface ResolvedConfig {
	/** Merged servers, keyed by id. Disabled servers are excluded. */
	servers: ServerTable;
	/** Server ids the user disabled, including ids that were never built in. */
	disabled: ReadonlySet<string>;
	/** Effective file-extension → languageId map. */
	languageIds: ReadonlyMap<string, string>;
	/** Effective result cap for tools: `defaults.maxResults ?? DEFAULT_MAX_RESULTS`. */
	maxResults: number;
	/** Human-readable notes for `/lsp-config`, e.g. "pyright: replaced cmd". */
	notes: string[];
}

/**
 * Merge user config over the built-in catalog.
 *
 * - A user entry whose id matches a built-in spec is deep-merged onto it.
 * - A user entry with a new id defines a brand-new server; `cmd` is required,
 *   and a missing `filetypes` is reported via `notes` (the server then matches
 *   no file rather than being dropped).
 * - Ids listed in `disabledServers` are omitted from `servers`.
 */
export function resolveConfig(
	user: LspconfigUserConfig,
	builtins: readonly LspServerSpec[],
): ResolvedConfig {
	const notes: string[] = [];
	const disabled = new Set(user.disabledServers ?? []);
	for (const id of disabled) notes.push(`${id}: disabled`);

	const servers = new Map<string, LspServerSpec>();
	const builtinById = new Map(builtins.map((server) => [server.id, server]));
	const overrides = user.servers ?? {};

	// Pass 1 — built-ins, in catalog order. Always cloned, even untouched, so
	// the resolved table never aliases `BUILTIN_SERVERS`.
	for (const builtin of builtins) {
		if (disabled.has(builtin.id)) continue;

		const override = overrides[builtin.id];
		const merged = mergeServerSpec(builtin, override ?? {});

		if (!isUsableCmd(merged.cmd) || !isNonEmptyArray(merged.filetypes)) {
			notes.push(`${builtin.id}: skipped (missing cmd, filetypes)`);
			continue;
		}

		servers.set(builtin.id, merged);

		if (override !== undefined) {
			notes.push(`${builtin.id}: overridden`);
			for (const path of collectDeletedKeys(override)) {
				notes.push(`${builtin.id}: removed ${path}`);
			}
		}
	}

	// Pass 2 — servers the user defined, in insertion order.
	for (const [id, entry] of Object.entries(overrides)) {
		if (builtinById.has(id) || disabled.has(id)) continue;

		if (!isUsableCmd(entry.cmd)) {
			notes.push(`${id}: skipped (missing cmd)`);
			continue;
		}

		const spec: LspServerSpec = { ...entry, id, cmd: entry.cmd, filetypes: entry.filetypes ?? [] };
		servers.set(id, spec);
		notes.push(entry.filetypes === undefined ? `${id}: added (no filetypes)` : `${id}: added`);
	}

	// `defaults.initializeTimeoutMs` is a fallback: a server's own value wins.
	const defaultTimeout = user.defaults?.initializeTimeoutMs;
	if (defaultTimeout !== undefined) {
		for (const [id, spec] of servers) {
			if (spec.initializeTimeoutMs === undefined) {
				servers.set(id, { ...spec, initializeTimeoutMs: defaultTimeout });
			}
		}
	}

	return {
		servers,
		disabled,
		languageIds: resolveLanguageIds(user, EXTENSION_TO_LANGUAGE_ID),
		maxResults: user.defaults?.maxResults ?? DEFAULT_MAX_RESULTS,
		notes,
	};
}

/** Resolve the effective extension → languageId map. User entries win. */
export function resolveLanguageIds(
	user: LspconfigUserConfig,
	builtinExtensions: Readonly<Record<string, string>>,
): Map<string, string> {
	const resolved = new Map(Object.entries(builtinExtensions));
	for (const [extension, languageId] of Object.entries(user.languageIds ?? {})) {
		resolved.set(extension, languageId);
	}
	return resolved;
}

/** Merge user config over a single built-in spec, returning a new spec. */
export function mergeServerSpec(base: LspServerSpec, override: LspServerSpecInput): LspServerSpec {
	const merged = deepMerge(base, override);
	// `id` is never user-settable (the schema forbids it); reassert defensively
	// against a programmatic caller.
	return { ...merged, id: base.id };
}

/** A launchable argv: a non-empty string array, or a dynamic function. */
function isUsableCmd(cmd: unknown): cmd is LspServerSpec["cmd"] {
	if (typeof cmd === "function") return true;
	return Array.isArray(cmd) && cmd.length > 0 && cmd.every((part) => typeof part === "string");
}

function isNonEmptyArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0;
}
