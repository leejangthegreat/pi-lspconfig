import type { LspServerSpec } from "../types.ts";

/**
 * Go via `gopls`.
 *
 * The `go.work`-ordering rationale lives in `docs.notes` so it is rendered into
 * docs/languages.md from here.
 *
 * @see https://pkg.go.dev/golang.org/x/tools/gopls
 */
export const gopls: LspServerSpec = {
	id: "gopls",
	cmd: ["gopls"],
	installCommand: "go install golang.org/x/tools/gopls@latest",
	filetypes: ["go", "gomod", "gowork", "gotmpl"],
	rootMarkers: ["go.work", "go.mod", "go.sum", ".git"],
	singleFileSupport: false,
	settings: {
		gopls: {
			usePlaceholders: true,
			completeUnimported: true,
			staticcheck: true,
			gofumpt: true,
			hints: {
				assignVariableTypes: true,
				parameterNames: true,
				compositeLiteralFields: true,
			},
		},
	},
	docs: {
		description: "Go language server.",
		notes:
			"`go.work` outranks `go.mod` so a multi-module workspace resolves to the " +
			"workspace root rather than to the first module.",
		url: "https://pkg.go.dev/golang.org/x/tools/gopls",
	},
};
