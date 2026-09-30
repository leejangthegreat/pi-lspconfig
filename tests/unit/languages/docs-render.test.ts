/**
 * `renderLanguageDocs` — the pure half of the docs generator.
 *
 * The generator writes a checked-in file, so the renderer must be
 * deterministic; the CLI half (jiti loading, file writing) is exercised by
 * `tests/integration/language-docs.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { renderLanguageDocs } from "../../../scripts/language-docs.ts";
import { BUILTIN_SERVERS, EXTENSION_TO_LANGUAGE_ID } from "../../../src/languages/index.ts";
import type { LspServerSpec } from "../../../src/types.ts";

describe("renderLanguageDocs", () => {
	const markdown = renderLanguageDocs(BUILTIN_SERVERS, EXTENSION_TO_LANGUAGE_ID);

	it("lists every built-in server with command, filetypes, and root markers", () => {
		for (const server of BUILTIN_SERVERS) {
			const command = Array.isArray(server.cmd) ? server.cmd.join(" ") : "(dynamic)";
			expect(markdown).toContain(`## \`${server.id}\``);
			expect(markdown).toContain(`| Command | \`${command}\` |`);
			expect(markdown).toContain(server.filetypes.map((id) => `\`${id}\``).join(", "));
			for (const marker of server.rootMarkers ?? []) {
				expect(markdown).toContain(`\`${marker}\``);
			}
			expect(markdown).toContain(`Install: \`${server.installCommand}\``);
		}
	});

	it("is deterministic", () => {
		expect(renderLanguageDocs(BUILTIN_SERVERS, EXTENSION_TO_LANGUAGE_ID)).toBe(markdown);
	});

	it("derives extensions from the languageId map, in registry order", () => {
		const server: LspServerSpec = {
			id: "mylang",
			cmd: ["mylang-ls"],
			filetypes: ["mylang"],
			rootMarkers: [".mylangrc"],
			singleFileSupport: false,
			docs: { description: "Example.", notes: "A note." },
		};

		const rendered = renderLanguageDocs([server], {
			".my": "mylang",
			".other": "otherlang",
			".alt": "mylang",
		});

		expect(rendered).toContain("| Extensions | `.my` `.alt` |");
		expect(rendered).not.toContain(".other");
		expect(rendered).toContain("A note.");
		expect(rendered).toContain("| Single-file support | no |");
	});

	it("renders a dynamic cmd as (dynamic) rather than throwing", () => {
		const server: LspServerSpec = {
			id: "dynamic",
			cmd: () => ["dynamic-ls"],
			filetypes: ["dynamic"],
			docs: { description: "Dynamic." },
		};

		const rendered = renderLanguageDocs([server], {});

		expect(rendered).toContain("| Command | `(dynamic)` |");
	});
});
