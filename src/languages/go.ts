import type { LspServerSpec } from "../types.ts";

/**
 * Go via `gopls`.
 *
 * `go.work` outranks `go.mod` so multi-module workspaces resolve to the
 * workspace root rather than to the first module.
 *
 * @see https://pkg.go.dev/golang.org/x/tools/gopls
 */
export const gopls: LspServerSpec = {
	id: "gopls",
	cmd: ["gopls"],
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
		url: "https://pkg.go.dev/golang.org/x/tools/gopls",
	},
};
