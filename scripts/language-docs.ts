/**
 * Render `docs/languages.md` from the built-in catalog.
 *
 * Pure and deterministic on purpose: the file is checked in and the docs check
 * is `git diff --exit-code`, so the output must not depend on iteration order
 * of anything but the catalog and `EXTENSION_TO_LANGUAGE_ID`.
 *
 * Scheduled for milestone M6; see ROADMAP.md.
 */

import type { LspServerSpec } from "../src/types.ts";

/** Render the whole file: header, one section per server, footer. */
export function renderLanguageDocs(
	servers: readonly LspServerSpec[],
	extensionToLanguageId: Readonly<Record<string, string>>,
): string {
	const sections = servers.map((server) => renderServer(server, extensionToLanguageId));
	return [
		"# Built-in language servers",
		"",
		"> Generated from `src/languages/*` by `npm run docs:languages`. Do not edit by hand.",
		"",
		`${servers.length} servers ship with pi-lspconfig. Each is a declarative spec: a command, the language ids it handles, ordered root markers, and default settings.`,
		"",
		"None of these binaries are installed for you. Put them on your `PATH`; a missing binary is reported with its install command rather than failing silently.",
		"",
		...sections,
		"## Adding a server",
		"",
		"See [Adding a language server](../AGENTS.md#adding-a-language-server). In short: add `src/languages/<name>.ts`, register it in `BUILTIN_SERVERS`, add any new extensions to `EXTENSION_TO_LANGUAGE_ID`, then run `npm run docs:languages`.",
		"",
	].join("\n");
}

function renderServer(
	server: LspServerSpec,
	extensionToLanguageId: Readonly<Record<string, string>>,
): string {
	const lines: string[] = [`## \`${server.id}\``, "", "| | |", "| --- | --- |"];

	lines.push(`| Command | ${code(commandOf(server))} |`);
	lines.push(`| Language ids | ${server.filetypes.map(code).join(", ")} |`);
	lines.push(`| Extensions | ${extensionsFor(server, extensionToLanguageId).map(code).join(" ")} |`);
	lines.push(`| Root markers | ${(server.rootMarkers ?? []).map(code).join(", ")} |`);
	lines.push(`| Single-file support | ${server.singleFileSupport === true ? "yes" : "no"} |`);
	if (server.docs?.url !== undefined) {
		lines.push(`| Upstream | <${server.docs.url}> |`);
	}
	lines.push("");

	if (server.docs?.notes !== undefined) {
		lines.push(server.docs.notes, "");
	}
	if (server.installCommand !== undefined) {
		lines.push(`Install: ${code(server.installCommand)}`, "");
	}

	return lines.join("\n");
}

/** `cmd` may be a closure; the docs can only state the declarative case. */
function commandOf(server: LspServerSpec): string {
	return Array.isArray(server.cmd) ? server.cmd.join(" ") : "(dynamic)";
}

/** Extensions whose languageId this server handles, in registry order. */
function extensionsFor(
	server: LspServerSpec,
	extensionToLanguageId: Readonly<Record<string, string>>,
): string[] {
	const filetypes = new Set(server.filetypes);
	return Object.entries(extensionToLanguageId)
		.filter(([, languageId]) => filetypes.has(languageId))
		.map(([extension]) => extension);
}

function code(value: string): string {
	return `\`${value.replace(/\|/g, "\\|")}\``;
}
