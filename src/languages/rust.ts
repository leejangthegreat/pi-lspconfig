import type { LspServerSpec } from "../types.ts";

/**
 * Rust via `rust-analyzer`.
 *
 * The `rust-project.json` rationale lives in `docs.notes` so it is rendered
 * into docs/languages.md from here.
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
		notes:
			"`rust-project.json` is listed so non-Cargo workspaces (Bazel, Buck) resolve " +
			"a root too.",
		url: "https://rust-analyzer.github.io/",
	},
};
