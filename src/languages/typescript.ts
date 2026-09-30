import type { LspServerSpec } from "../types.ts";

/**
 * TypeScript / JavaScript via `vtsls`.
 *
 * The rationale for choosing it over `typescript-language-server` lives in
 * `docs.notes` so it is rendered into docs/languages.md from here.
 *
 * @see https://github.com/yioneko/vtsls
 */
export const vtsls: LspServerSpec = {
	id: "vtsls",
	cmd: ["vtsls", "--stdio"],
	installCommand: "npm install -g @vtsls/language-server typescript",
	filetypes: ["javascript", "javascriptreact", "typescript", "typescriptreact"],
	rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
	singleFileSupport: true,
	settings: {
		typescript: {
			updateImportsOnFileMove: { enabled: "always" },
			inlayHints: { parameterNames: { enabled: "literals" } },
			preferences: { includePackageJsonAutoImports: "auto" },
		},
		javascript: {
			updateImportsOnFileMove: { enabled: "always" },
		},
		vtsls: {
			autoUseWorkspaceTsdk: true,
			experimental: { completion: { enableServerSideFuzzyMatch: true } },
		},
	},
	docs: {
		description: "TypeScript and JavaScript language server (VS Code feature set).",
		notes:
			"Chosen over the bundled `typescript-language-server` because it exposes the " +
			"richer VS Code feature set — call hierarchy, code actions, and " +
			"`workspace/executeCommand` refactors — behind a stable stdio entry point.",
		url: "https://github.com/yioneko/vtsls",
	},
};
