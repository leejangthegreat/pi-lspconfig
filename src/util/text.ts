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
export function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/** Offsets at which each line begins. The first entry is always `0`. */
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x0a) {
			starts.push(i + 1);
		} else if (code === 0x0d) {
			if (text.charCodeAt(i + 1) === 0x0a) i++;
			starts.push(i + 1);
		}
	}
	return starts;
}

/** Offset just past the last character of the line beginning at `start`. */
function lineEnd(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x0a || code === 0x0d) return i;
	}
	return text.length;
}

/** Number of code units a code point occupies in `encoding`. */
function unitWidth(codePoint: number, encoding: PositionEncoding): number {
	switch (encoding) {
		case "utf-16":
			return codePoint > 0xffff ? 2 : 1;
		case "utf-32":
			return 1;
		case "utf-8":
			if (codePoint <= 0x7f) return 1;
			if (codePoint <= 0x7ff) return 2;
			if (codePoint <= 0xffff) return 3;
			return 4;
	}
}

/** JS string index advance for one code point (1 for BMP, 2 for astral). */
function advance(codePoint: number): number {
	return codePoint > 0xffff ? 2 : 1;
}

/** Clamp an integer into `[min, max]`, treating non-finite input as `min`. */
function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Count the code units between two offsets in `encoding`, without splitting code points. */
function unitsBetween(text: string, start: number, end: number, encoding: PositionEncoding): number {
	let units = 0;
	for (let i = start; i < end; ) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;
		const step = advance(codePoint);
		if (i + step > end) break;
		units += unitWidth(codePoint, encoding);
		i += step;
	}
	return units;
}

/**
 * Convert a 0-based `(line, character)` into an absolute string offset.
 *
 * `character` is interpreted as code units in `encoding`, so the returned
 * offset is always a JavaScript string index (UTF-16 code units). A character
 * that would land inside a code point clamps back to that code point's start;
 * a character past the end of the line clamps to the line terminator.
 */
export function positionToOffset(
	text: string,
	position: ZeroBasedPosition,
	encoding: PositionEncoding,
): number {
	const starts = lineStarts(text);
	if (position.line < 0) return 0;
	if (position.line >= starts.length) return text.length;

	const start = starts[position.line] ?? text.length;
	const end = lineEnd(text, start);
	let units = 0;
	let i = start;
	while (i < end) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;
		const width = unitWidth(codePoint, encoding);
		if (units + width > position.character) break;
		units += width;
		i += advance(codePoint);
	}
	return i;
}

/** Inverse of {@link positionToOffset}. */
export function offsetToPosition(
	text: string,
	offset: number,
	encoding: PositionEncoding,
): ZeroBasedPosition {
	const target = clampInt(offset, 0, text.length);
	const starts = lineStarts(text);

	let line = 0;
	for (let candidate = 0; candidate < starts.length; candidate++) {
		if ((starts[candidate] ?? 0) <= target) line = candidate;
		else break;
	}
	const start = starts[line] ?? text.length;

	// UTF-16 `character` is literally a code-unit count, so no walking is needed
	// and every offset round-trips exactly.
	if (encoding === "utf-16") return { line, character: target - start };

	return { line, character: unitsBetween(text, start, target, encoding) };
}

/** Clamp a 0-based position into the bounds of `text`. */
export function clampPosition(
	text: string,
	position: ZeroBasedPosition,
	encoding: PositionEncoding,
): ZeroBasedPosition {
	const starts = lineStarts(text);
	const line = clampInt(position.line, 0, starts.length - 1);
	const start = starts[line] ?? 0;
	const end = lineEnd(text, start);
	return { line, character: clampInt(position.character, 0, unitsBetween(text, start, end, encoding)) };
}
