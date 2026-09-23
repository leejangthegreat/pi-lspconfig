/**
 * Line/character ↔ offset conversion.
 *
 * The LSP `character` field counts *code units* in the position encoding the
 * client and server negotiated — UTF-16 by default, but UTF-8 and UTF-32 are
 * legal. Models think in columns, so pi-lspconfig converts at the boundary:
 * tool input is 1-based line/character, the wire is 0-based in the negotiated
 * encoding.
 */

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

/** A 0-based LSP position. */
export interface ZeroBasedPosition {
	line: number;
	character: number;
}

/**
 * Convert a 1-based tool-facing position into a 0-based LSP position.
 *
 * Tool input is 1-based because that is what editors, compilers, and models
 * report; the wire protocol is 0-based.
 */
export function toLspPosition(line: number, character: number): ZeroBasedPosition {
	return { line: line - 1, character: character - 1 };
}

/** Convert a 0-based LSP position into the 1-based tool-facing form. */
export function fromLspPosition(position: ZeroBasedPosition): { line: number; character: number } {
	return { line: position.line + 1, character: position.character + 1 };
}

/** Split into lines, dropping the terminators. Handles `\n`, `\r\n`, and lone `\r`. */
export function splitLines(_text: string): string[] {
	throw new Error("Not implemented: splitLines");
}

/**
 * Convert a 0-based `(line, character)` into an absolute string offset.
 *
 * `character` is interpreted as code units in `encoding`, so the returned
 * offset is always a JavaScript string index (UTF-16 code units).
 */
export function positionToOffset(
	_text: string,
	_position: ZeroBasedPosition,
	_encoding: PositionEncoding,
): number {
	throw new Error("Not implemented: positionToOffset");
}

/** Inverse of {@link positionToOffset}. */
export function offsetToPosition(
	_text: string,
	_offset: number,
	_encoding: PositionEncoding,
): ZeroBasedPosition {
	throw new Error("Not implemented: offsetToPosition");
}

/** Clamp a 0-based position into the bounds of `text`. */
export function clampPosition(
	_text: string,
	_position: ZeroBasedPosition,
	_encoding: PositionEncoding,
): ZeroBasedPosition {
	throw new Error("Not implemented: clampPosition");
}
