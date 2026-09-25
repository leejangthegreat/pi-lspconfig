/**
 * Defaults shared by the config resolver and the LSP client.
 *
 * Everything here is plain data so the module stays dependency-free and cheap
 * to import from tests.
 */

import type { ClientCapabilities, PositionEncodingKind } from "../protocol.ts";

/** How long to wait for `initialize` before declaring a server broken. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;

/** How long to wait after SIGTERM before escalating to SIGKILL. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;

/** How long to wait for the first diagnostics after `didOpen`. */
export const DEFAULT_DIAGNOSTICS_QUIET_MS = 400;

/** Upper bound on `lsp_diagnostics` waiting for fresh results. */
export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 5_000;

/** Default cap on locations/symbols returned by one operation. */
export const DEFAULT_MAX_RESULTS = 100;

/**
 * Files above this size are not opened in the language server.
 *
 * Servers routinely choke or spend minutes on multi-megabyte generated files;
 * skipping them is cheaper than timing out.
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Preferred position encodings, most preferred first. UTF-16 is mandatory for servers. */
export const DEFAULT_POSITION_ENCODINGS: readonly PositionEncodingKind[] = ["utf-16", "utf-8"];

/** Symbol kinds 1..26, per the LSP specification. */
export const ALL_SYMBOL_KINDS: readonly number[] = Array.from({ length: 26 }, (_, i) => i + 1);

/** Code action kinds advertised to servers. */
export const CODE_ACTION_KINDS: readonly string[] = [
	"quickfix",
	"refactor",
	"refactor.extract",
	"refactor.inline",
	"refactor.rewrite",
	"source",
	"source.organizeImports",
	"source.fixAll",
];

/**
 * The client capability object sent in `initialize`.
 *
 * Deliberately full rather than minimal: several servers (notably PowerShell
 * Editor Services and some Java tooling) crash or fail the handshake when a
 * sub-capability they expect is absent. Advertising everything costs nothing
 * because servers only use what they support.
 */
export const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
	general: {
		positionEncodings: [...DEFAULT_POSITION_ENCODINGS],
		markdown: { parser: "marked" },
		staleRequestSupport: { cancel: true, retryOnContentModified: [] },
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		didChangeConfiguration: { dynamicRegistration: false },
		workspaceFolders: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: { valueSet: [...ALL_SYMBOL_KINDS] },
		},
		executeCommand: { dynamicRegistration: false },
		diagnostics: { refreshSupport: true },
	},
	textDocument: {
		synchronization: {
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
			didSave: true,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			codeDescriptionSupport: true,
			dataSupport: true,
		},
		hover: {
			dynamicRegistration: false,
			contentFormat: ["markdown", "plaintext"],
		},
		signatureHelp: {
			dynamicRegistration: false,
			contextSupport: true,
			signatureInformation: {
				documentationFormat: ["markdown", "plaintext"],
				parameterInformation: { labelOffsetSupport: true },
				activeParameterSupport: true,
			},
		},
		definition: { dynamicRegistration: false, linkSupport: true },
		typeDefinition: { dynamicRegistration: false, linkSupport: true },
		declaration: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: { valueSet: [...ALL_SYMBOL_KINDS] },
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: { codeActionKind: { valueSet: [...CODE_ACTION_KINDS] } },
			isPreferredSupport: true,
			disabledSupport: true,
			dataSupport: true,
			resolveSupport: { properties: ["edit", "command"] },
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
			honorsChangeAnnotations: true,
		},
		callHierarchy: { dynamicRegistration: false },
		diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
	},
};

/** Environment variables forwarded from the parent process to a spawned server. */
export const INHERITED_ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SystemRoot",
	"ComSpec",
	"APPDATA",
	"LOCALAPPDATA",
];
