/**
 * Example pi-lspconfig configuration.
 *
 * Copy to `<cwd>/pi-lspconfig.config.ts` (project-scoped) or
 * `~/.pi/pi-lspconfig.config.ts` (all projects). See docs/configuration.md.
 */

import { defineConfig } from "pi-lspconfig";

export default defineConfig({
	servers: {
		// Override a built-in server. Objects merge recursively and the user's
		// keys win, so only `typeCheckingMode` changes here — the built-in
		// `rootMarkers`, `cmd`, and the rest of `settings` survive.
		pyright: {
			settings: {
				python: {
					analysis: {
						typeCheckingMode: "strict",
					},
				},
			},
		},

		// Arrays replace wholesale, so this drops the built-in
		// `package.json` marker in favour of a stricter set.
		vtsls: {
			rootMarkers: ["tsconfig.json", ".git"],
		},

		// Define a server that is not built in. `filetypes` is required for new
		// servers; without it, the server would never match a file.
		mylang: {
			cmd: ["mylang-ls", "--stdio"],
			filetypes: ["mylang"],
			rootMarkers: [".mylangrc", "mylang.toml", ".git"],
			singleFileSupport: true,
			settings: {
				mylang: { diagnostics: { level: "strict" } },
			},
			docs: {
				description: "Example third-party language server.",
			},
		},

		// Dynamic launch: pick a different binary depending on the resolved
		// root. Useful when a vendored toolchain lives inside the repository.
		rust: {
			cmd: ({ root }) =>
				root && root.includes("vendor")
					? ["./vendor/bin/rust-analyzer"]
					: ["rust-analyzer"],
		},
	},

	// Never start these, even if a file matches.
	disabledServers: ["gopls"],

	// Teach pi-lspconfig about extensions that are not registered by default.
	languageIds: {
		".mts": "typescript",
		".cts": "typescript",
	},

	// Global defaults for every server.
	defaults: {
		initializeTimeoutMs: 20_000,
		maxResults: 200,
	},
});
