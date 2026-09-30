import type { LspServerSpec } from "../types.ts";

/**
 * Python via Pyright.
 *
 * The settings-routing rationale lives in `docs.notes` so it is rendered into
 * docs/languages.md from here.
 *
 * @see https://github.com/microsoft/pyright
 */
export const pyright: LspServerSpec = {
	id: "pyright",
	cmd: ["pyright-langserver", "--stdio"],
	installCommand: "npm install -g pyright",
	filetypes: ["python"],
	rootMarkers: [
		"pyrightconfig.json",
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"requirements.txt",
		"Pipfile",
		".git",
	],
	singleFileSupport: true,
	settings: {
		python: {
			analysis: {
				autoSearchPaths: true,
				useLibraryCodeForTypes: true,
				diagnosticMode: "openFilesOnly",
				typeCheckingMode: "standard",
				inlayHints: { variableTypes: true, callArgumentNames: true },
			},
		},
	},
	docs: {
		description: "Python type checker and language server.",
		notes:
			"Settings land under `python.analysis.*` because Pyright reads them from the " +
			"`workspace/didChangeConfiguration` payload rather than from `initializationOptions`.",
		url: "https://github.com/microsoft/pyright",
	},
};
