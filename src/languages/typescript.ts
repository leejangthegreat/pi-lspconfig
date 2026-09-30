import type { LspServerSpec } from "../types.ts";

/**
 * TypeScript / JavaScript via `vtsls`.
 *
 * vtsls is preferred over the bundled `typescript-language-server` because it
 * exposes the richer VS Code feature set (call hierarchy, code actions, and
 * `workspace/executeCommand` for refactors) with a stable stdio entry point.
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
		url: "https://github.com/yioneko/vtsls",
	},
};
