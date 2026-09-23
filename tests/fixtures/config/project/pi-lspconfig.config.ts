/**
 * Valid fixture for the real-jiti loader test.
 *
 * Deliberately does not `import { defineConfig } from "pi-lspconfig"` — that
 * would pull the whole extension module graph through jiti. See
 * `tests/unit/config/load-real.test.ts`.
 */
export default {
	servers: {
		pyright: {
			settings: {
				python: {
					analysis: {
						typeCheckingMode: "strict",
					},
				},
			},
		},
	},
	disabledServers: ["gopls"],
	languageIds: {
		".vue": "vue",
	},
	defaults: {
		maxResults: 42,
	},
};
