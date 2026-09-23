import type { LspServerSpec } from "../types.ts";

/**
 * Python via Pyright.
 *
 * Settings land under `python.analysis.*` because Pyright reads them from the
 * `workspace/didChangeConfiguration` payload rather than from
 * `initializationOptions`.
 *
 * @see https://github.com/microsoft/pyright
 */
export const pyright: LspServerSpec = {
	id: "pyright",
	cmd: ["pyright-langserver", "--stdio"],
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
		url: "https://github.com/microsoft/pyright",
	},
};
