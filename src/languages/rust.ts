import type { LspServerSpec } from "../types.ts";

/**
 * Rust via `rust-analyzer`.
 *
 * `rust-analyzer` speaks stdio with no arguments. `rust-project.json` is listed
 * so non-Cargo (Bazel, Buck) workspaces resolve a root too.
 *
 * @see https://rust-analyzer.github.io/
 */
export const rustAnalyzer: LspServerSpec = {
	id: "rust-analyzer",
	cmd: ["rust-analyzer"],
	installCommand: "rustup component add rust-analyzer",
	filetypes: ["rust"],
	rootMarkers: ["Cargo.toml", "Cargo.lock", "rust-project.json", ".git"],
	singleFileSupport: true,
	settings: {
		"rust-analyzer": {
			cargo: { allFeatures: false, buildScripts: { enable: true } },
			checkOnSave: true,
			inlayHints: { closureReturnTypeHints: { enable: "always" } },
			imports: { granularity: { group: "module" } },
		},
	},
	docs: {
		description: "Rust language server.",
		url: "https://rust-analyzer.github.io/",
	},
};
