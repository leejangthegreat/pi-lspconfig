/**
 * Minimal Language Server Protocol wire types.
 *
 * pi-lspconfig deliberately does not depend on `vscode-languageserver-protocol`.
 * Only the transport (`vscode-jsonrpc`) is borrowed; the type surface below is
 * the subset of the specification this extension actually sends, receives, or
 * re-shapes into tool results.
 *
 * This module is the bottom of the dependency graph: it imports nothing.
 *
 * @see https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
 */

/** UTF-16 code units are the only encoding every server is required to support. */
export type PositionEncodingKind = "utf-8" | "utf-16" | "utf-32";

/** How a server wants documents synchronised. */
export type TextDocumentSyncKind = 0 | 1 | 2;

export type DocumentUri = string;

/** Zero-based line and character offset, in the negotiated position encoding. */
export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: DocumentUri;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: DocumentUri;
	targetRange: Range;
	targetSelectionRange: Range;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface TextDocumentEdit {
	textDocument: { uri: DocumentUri; version: number | null };
	edits: TextEdit[];
}

export interface WorkspaceEdit {
	changes?: Record<DocumentUri, TextEdit[]>;
	documentChanges?: TextDocumentEdit[];
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export const DiagnosticSeverity = {
	Error: 1,
	Warning: 2,
	Information: 3,
	Hint: 4,
} as const;

export type DiagnosticSeverityValue =
	(typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverityValue;
	code?: string | number;
	source?: string;
	message: string;
	relatedInformation?: DiagnosticRelatedInformation[];
}

export interface PublishDiagnosticsParams {
	uri: DocumentUri;
	version?: number;
	diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Hover / markup
// ---------------------------------------------------------------------------

export type MarkupKind = "plaintext" | "markdown";

export interface MarkupContent {
	kind: MarkupKind;
	value: string;
}

export interface Hover {
	contents: MarkupContent | string | (MarkupContent | string)[];
	range?: Range;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export const SymbolKind = {
	File: 1,
	Module: 2,
	Namespace: 3,
	Package: 4,
	Class: 5,
	Method: 6,
	Property: 7,
	Field: 8,
	Constructor: 9,
	Enum: 10,
	Interface: 11,
	Function: 12,
	Variable: 13,
	Constant: 14,
	String: 15,
	Number: 16,
	Boolean: 17,
	Array: 18,
	Object: 19,
	Key: 20,
	Null: 21,
	EnumMember: 22,
	Struct: 23,
	Event: 24,
	Operator: 25,
	TypeParameter: 26,
} as const;

export type SymbolKindValue = (typeof SymbolKind)[keyof typeof SymbolKind];

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKindValue;
	tags?: number[];
	deprecated?: boolean;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKindValue;
	tags?: number[];
	deprecated?: boolean;
	location: Location;
	containerName?: string;
}

export interface WorkspaceSymbolParams {
	query: string;
}

// ---------------------------------------------------------------------------
// Signature help
// ---------------------------------------------------------------------------

export interface ParameterInformation {
	label: string | [number, number];
	documentation?: string | MarkupContent;
}

export interface SignatureInformation {
	label: string;
	documentation?: string | MarkupContent;
	parameters?: ParameterInformation[];
	activeParameter?: number;
}

export interface SignatureHelp {
	signatures: SignatureInformation[];
	activeSignature?: number;
	activeParameter?: number;
}

// ---------------------------------------------------------------------------
// Code actions / commands
// ---------------------------------------------------------------------------

export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface CodeAction {
	title: string;
	kind?: string;
	diagnostics?: Diagnostic[];
	isPreferred?: boolean;
	edit?: WorkspaceEdit;
	command?: Command;
}

// ---------------------------------------------------------------------------
// Call hierarchy
// ---------------------------------------------------------------------------

export interface CallHierarchyItem {
	name: string;
	kind: SymbolKindValue;
	tags?: number[];
	detail?: string;
	uri: DocumentUri;
	range: Range;
	selectionRange: Range;
	data?: unknown;
}

export interface CallHierarchyIncomingCall {
	from: CallHierarchyItem;
	fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
	to: CallHierarchyItem;
	fromRanges: Range[];
}

// ---------------------------------------------------------------------------
// Document synchronisation
// ---------------------------------------------------------------------------

export interface TextDocumentItem {
	uri: DocumentUri;
	languageId: string;
	version: number;
	text: string;
}

export interface TextDocumentIdentifier {
	uri: DocumentUri;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version: number;
}

export interface TextDocumentContentChangeEvent {
	range?: Range;
	rangeLength?: number;
	text: string;
}

// ---------------------------------------------------------------------------
// Capabilities (deliberately partial — only what we negotiate)
// ---------------------------------------------------------------------------

/** A capability value that may be a boolean or an options object. */
export type CapabilityOption<T> = boolean | T;

export interface PositionEncodingOptions {
	positionEncoding?: PositionEncodingKind;
}

export interface TextDocumentSyncOptions {
	openClose?: boolean;
	change?: TextDocumentSyncKind;
}

export interface ServerCapabilities {
	positionEncoding?: PositionEncodingKind;
	textDocumentSync?: CapabilityOption<TextDocumentSyncOptions>;
	hoverProvider?: CapabilityOption<unknown>;
	definitionProvider?: CapabilityOption<unknown>;
	typeDefinitionProvider?: CapabilityOption<unknown>;
	declarationProvider?: CapabilityOption<unknown>;
	implementationProvider?: CapabilityOption<unknown>;
	referencesProvider?: CapabilityOption<unknown>;
	documentSymbolProvider?: CapabilityOption<unknown>;
	workspaceSymbolProvider?: CapabilityOption<unknown>;
	codeActionProvider?: CapabilityOption<unknown>;
	renameProvider?: CapabilityOption<unknown>;
	signatureHelpProvider?: CapabilityOption<unknown>;
	callHierarchyProvider?: CapabilityOption<unknown>;
	executeCommandProvider?: { commands?: string[] };
	diagnosticProvider?: unknown;
	workspace?: { diagnostics?: unknown };
}

/** The client capability object is intentionally loose here; see `util/defaults.ts`. */
export type ClientCapabilities = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Lifecycle messages
// ---------------------------------------------------------------------------

export interface WorkspaceFolder {
	uri: DocumentUri;
	name: string;
}

export interface InitializeParams {
	processId: number | null;
	clientInfo?: { name: string; version?: string };
	rootUri: DocumentUri | null;
	workspaceFolders: WorkspaceFolder[] | null;
	capabilities: ClientCapabilities;
	initializationOptions?: unknown;
	/** Negotiated position encodings, most preferred first. */
	general?: { positionEncodings?: PositionEncodingKind[] };
	/** Experimental settings delivered before `initialized`. */
	trace?: "off" | "messages" | "verbose";
}

export interface InitializeResult {
	capabilities: ServerCapabilities;
	serverInfo?: { name: string; version?: string };
}

export interface ExecuteCommandParams {
	command: string;
	arguments?: unknown[];
}
