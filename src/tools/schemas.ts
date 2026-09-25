/**
 * Tool parameter schemas.
 *
 * These TypeBox schemas are the single definition of the tool surface. They are
 * plain JSON Schema once serialised, so the same objects could back an MCP
 * `inputSchema` without translation.
 *
 * Everything here is a pure value: this module must never touch
 * `ExtensionAPI`/`ExtensionContext`, so the tool definitions stay unit-testable
 * with a plain context stub.
 */

import { Type, type Static, type TUnsafe } from "typebox";
import { DEFAULT_MAX_RESULTS } from "../util/defaults.ts";
import { LSP_OPERATIONS } from "../core/operations.ts";

/**
 * Build a string enum that providers can express.
 *
 * Some providers reject `anyOf`/`const` unions, so an enum is encoded as a
 * single `{ type: "string", enum: [...] }` node. This mirrors the helper Pi
 * ships internally; it is duplicated here because that helper lives at an
 * unexported `@earendil-works/pi-ai/utils/*` subpath that is absent from Pi's
 * virtual-module map and therefore unresolvable in bundled builds.
 */
function stringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description === undefined ? {} : { description: options.description }),
		...(options?.default === undefined ? {} : { default: options.default }),
	});
}

/** Symbol kind names accepted by `kinds`, mapped to their LSP numeric values in `core/operations.ts`. */
export const SYMBOL_KIND_NAMES = [
	"file",
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"string",
	"number",
	"boolean",
	"array",
	"object",
	"key",
	"null",
	"enumMember",
	"struct",
	"event",
	"operator",
	"typeParameter",
] as const;

export const OPERATION_VALUES = LSP_OPERATIONS;

/**
 * Parameters for the unified `lsp` tool.
 *
 * `line`/`character` are 1-based. `symbol` + `occurrence` exist so the model can
 * name a target instead of guessing a column — guessing is the usual cause of a
 * wrong or empty result from position-based tools.
 */
export const LspToolParameters = Type.Object({
	operation: stringEnum(OPERATION_VALUES, {
		description:
			"The language-server operation to perform. Navigation operations need `path` plus a position (or `symbol`).",
	}),
	path: Type.Optional(
		Type.String({ description: "File path, absolute or relative to the working directory." }),
	),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line number." })),
	character: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based character offset within the line." }),
	),
	endLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based end line, for ranges." })),
	endCharacter: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-based end character, for ranges." }),
	),
	symbol: Type.Optional(
		Type.String({
			description:
				"Symbol name to target instead of a column, e.g. \"handleRequest\". Preferred over guessing `character`.",
		}),
	),
	occurrence: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Which occurrence of `symbol` to use, 1-based. Defaults to the first.",
		}),
	),
	query: Type.Optional(
		Type.String({ description: "Search text for `workspaceSymbol`." }),
	),
	kinds: Type.Optional(
		Type.Array(stringEnum(SYMBOL_KIND_NAMES), {
			description: "Restrict symbol results to these kinds.",
		}),
	),
	exactMatch: Type.Optional(
		Type.Boolean({ description: "Require an exact name match for symbol lookups." }),
	),
	topLevelOnly: Type.Optional(
		Type.Boolean({ description: "Only return top-level symbols." }),
	),
	maxResults: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: `Cap on returned locations. Defaults to ${DEFAULT_MAX_RESULTS}.`,
		}),
	),
	newName: Type.Optional(Type.String({ description: "New name for `rename`." })),
	apply: Type.Optional(
		Type.Boolean({
			description:
				"For `rename`: when false (the default) the edits are previewed, not written.",
		}),
	),
	command: Type.Optional(
		Type.String({ description: "Command id for `executeCommand`." }),
	),
	commandArguments: Type.Optional(
		Type.Array(Type.Unknown(), { description: "Arguments for `executeCommand`." }),
	),
	callHierarchyItem: Type.Optional(
		Type.Unknown({
			description:
				"Opaque item returned by `prepareCallHierarchy`; pass it back for incoming/outgoing calls.",
		}),
	),
});

export type LspToolInput = Static<typeof LspToolParameters>;

/** Parameters for the `lsp_diagnostics` tool. */
export const LspDiagnosticsParameters = Type.Object({
	path: Type.Optional(
		Type.String({ description: "File path. Required unless `scope` is \"workspace\"." }),
	),
	scope: Type.Optional(
		stringEnum(["file", "workspace"], {
			description:
				"\"file\" (default) reports one file; \"workspace\" reports every open document.",
		}),
	),
	severity: Type.Optional(
		stringEnum(["error", "warning", "information", "hint"], {
			description: "Minimum severity to include. Defaults to \"hint\" (everything).",
		}),
	),
	waitForFresh: Type.Optional(
		Type.Boolean({
			description:
				"When true (the default) wait for a quiet window so results reflect the latest edit.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({ minimum: 0, description: "Upper bound on waiting for fresh diagnostics." }),
	),
	maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type LspDiagnosticsInput = Static<typeof LspDiagnosticsParameters>;
