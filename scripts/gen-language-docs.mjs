#!/usr/bin/env node
/**
 * Generate docs/languages.md from the server specs in src/languages/.
 *
 * Scheduled for milestone M6. The intended implementation:
 *
 *   1. Load each src/languages/*.ts module through jiti (the same loader Pi
 *      uses), so the declarative specs are read from the real source of truth
 *      rather than duplicated here.
 *   2. Skip src/languages/index.ts (the aggregator).
 *   3. Render one section per server: id, cmd, filetypes, extensions derived
 *      from EXTENSION_TO_LANGUAGE_ID, rootMarkers, singleFileSupport, and
 *      docs.url.
 *   4. Write docs/languages.md.
 *
 * Acceptance criteria (from ROADMAP.md M6): running this twice produces no
 * diff, and the output lists every entry in BUILTIN_SERVERS.
 */

process.stderr.write(
	"gen-language-docs: not implemented yet (milestone M6 in ROADMAP.md).\n" +
		"docs/languages.md is currently maintained by hand.\n",
);

process.exit(1);
