#!/usr/bin/env node
/**
 * Generate docs/languages.md from the server specs in src/languages/.
 *
 * Loads the real TypeScript specs through jiti — the same loader Pi uses — so
 * the docs are rendered from the source of truth rather than duplicated here.
 *
 * Usage: node scripts/gen-language-docs.mjs [--out <path>]
 *
 * Acceptance criteria (from ROADMAP.md M6): running this twice produces no
 * diff, and the output lists every entry in BUILTIN_SERVERS.
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	let out = resolve(here, "../docs/languages.md");
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--out") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("--out needs a path");
			out = resolve(process.cwd(), value);
			index += 1;
		} else if (arg === "--help" || arg === "-h") {
			process.stderr.write("usage: node scripts/gen-language-docs.mjs [--out <path>]\n");
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { out };
}

export async function main(argv = process.argv.slice(2)) {
	const { out } = parseArgs(argv);
	const jiti = createJiti(import.meta.url);

	// `default: true` is jiti's shorthand for `mod?.default ?? mod`; neither
	// module has a default export, so this yields the namespace.
	const catalog = await jiti.import(resolve(here, "../src/languages/index.ts"), { default: true });
	const { renderLanguageDocs } = await jiti.import(resolve(here, "language-docs.ts"), {
		default: true,
	});

	const markdown = renderLanguageDocs(catalog.BUILTIN_SERVERS, catalog.EXTENSION_TO_LANGUAGE_ID);
	await writeFile(out, markdown, "utf8");
	process.stderr.write(`gen-language-docs: wrote ${out}\n`);
	return markdown;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}
