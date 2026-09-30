/**
 * User configuration schema.
 *
 * The schema is the contract for `pi-lspconfig.config.ts`. It validates the
 * *declarative* surface strictly (unknown keys are rejected so typos surface
 * immediately) and lets the two function-valued fields — `cmd` and `rootDir` —
 * through as opaque values, because a JSON Schema cannot describe a closure.
 *
 * `cmd` is checked structurally by {@link validateUserConfig} so a user who
 * writes `cmd: "pyright-langserver"` instead of `cmd: ["pyright-langserver"]`
 * gets a useful message rather than a spawn failure much later.
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import type { LspconfigUserConfig, LspServerSpecInput } from "../types.ts";

/** Per-server override schema. `id` is the record key, so it is not a property. */
export const ServerSpecInputSchema = Type.Object(
	{
		cmd: Type.Optional(
			Type.Unknown({
				description: "Argv array, or a function receiving LaunchContext and returning argv.",
			}),
		),
		filetypes: Type.Optional(
			Type.Array(Type.String(), { minItems: 1, description: "LSP language ids to handle." }),
		),
		rootMarkers: Type.Optional(
			Type.Array(Type.String(), { description: "Ordered root markers, highest priority first." }),
		),
		rootDir: Type.Optional(
			Type.Unknown({ description: "Async root resolver; takes precedence over rootMarkers." }),
		),
		initOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		capabilities: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		singleFileSupport: Type.Optional(Type.Boolean()),
		installCommand: Type.Optional(
			Type.String({ description: "Shell command that installs the server binary." }),
		),
		autoInstall: Type.Optional(
			Type.Boolean({
				description: "Run installCommand once when the binary is missing. Off by default.",
			}),
		),
		initializeTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
		docs: Type.Optional(
			Type.Object(
				{
					description: Type.String(),
					notes: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** The full config file schema. */
export const LspconfigUserConfigSchema = Type.Object(
	{
		servers: Type.Optional(
			Type.Record(Type.String(), ServerSpecInputSchema, {
				description: "Per-server overrides and new server definitions, keyed by server id.",
			}),
		),
		disabledServers: Type.Optional(Type.Array(Type.String())),
		languageIds: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "File-extension to LSP languageId overrides, e.g. { '.mts': 'typescript' }.",
			}),
		),
		defaults: Type.Optional(
			Type.Object(
				{
					initializeTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
					maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/**
 * Identity helper for config files.
 *
 * ```ts
 * import { defineConfig } from "pi-lspconfig";
 *
 * export default defineConfig({
 *   servers: { pyright: { settings: { python: { analysis: { typeCheckingMode: "strict" } } } } },
 * });
 * ```
 *
 * The value is returned unchanged; the only purpose is type inference and
 * editor completion inside the config file.
 */
export function defineConfig(config: LspconfigUserConfig): LspconfigUserConfig {
	return config;
}

export type ConfigValidationResult =
	| { ok: true; config: LspconfigUserConfig }
	| { ok: false; errors: string[] };

/** Validate a value loaded from a config file. Never throws. */
export function validateUserConfig(value: unknown): ConfigValidationResult {
	if (!Value.Check(LspconfigUserConfigSchema, value)) {
		const errors = Value.Errors(LspconfigUserConfigSchema, value).map(
			(error) => `${error.instancePath || "/"}: ${error.message}`,
		);
		return { ok: false, errors };
	}

	const config = value as LspconfigUserConfig;
	const structural = validateServerEntries(config.servers ?? {});
	if (structural.length > 0) {
		return { ok: false, errors: structural };
	}

	return { ok: true, config };
}

/**
 * Checks the parts of a server spec that TypeBox cannot express.
 *
 * `cmd` is optional (a partial override of a built-in server need not restate
 * it), but when present it must be a non-empty string array or a function.
 * `rootDir` must be a function when present.
 */
function validateServerEntries(servers: Record<string, LspServerSpecInput>): string[] {
	const errors: string[] = [];

	for (const [id, spec] of Object.entries(servers)) {
		const base = `/servers/${id}`;
		const cmd: unknown = spec.cmd;

		if (cmd === undefined || typeof cmd === "function") {
			// Omitted (override) or dynamic launch: accepted as-is.
		} else if (!Array.isArray(cmd) || cmd.length === 0) {
			errors.push(
				`${base}/cmd: expected a non-empty string array (or a function), received ${describe(cmd)}. ` +
					`Did you mean ["<command>", "--stdio"]?`,
			);
		} else if (!cmd.every((part) => typeof part === "string")) {
			errors.push(`${base}/cmd: every argv entry must be a string.`);
		}

		if (spec.rootDir !== undefined && typeof spec.rootDir !== "function") {
			errors.push(`${base}/rootDir: expected a function, received ${describe(spec.rootDir)}.`);
		}
	}

	return errors;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}
