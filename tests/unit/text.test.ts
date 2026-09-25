import { describe, expect, it } from "vitest";
import {
	clampPosition,
	offsetToPosition,
	positionToOffset,
	splitLines,
} from "../../src/util/text.ts";
import type { PositionEncoding } from "../../src/util/text.ts";

const ENCODINGS: readonly PositionEncoding[] = ["utf-16", "utf-8", "utf-32"];

/**
 * Every JS index that is a valid line/character position.
 *
 * Code-point boundaries only, and never the interior of a `\r\n`: both offsets
 * of a CRLF describe the same end-of-line, so no position can distinguish them
 * and the mapping is not invertible there.
 */
function roundTrippableOffsets(text: string): number[] {
	const offsets: number[] = [];
	for (let i = 0; i < text.length; ) {
		if (!(i > 0 && text[i - 1] === "\r" && text[i] === "\n")) offsets.push(i);
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;
		i += codePoint > 0xffff ? 2 : 1;
	}
	offsets.push(text.length);
	return offsets;
}

describe("splitLines", () => {
	it("drops \\n, \\r\\n, and lone \\r terminators", () => {
		expect(splitLines("a\nb")).toEqual(["a", "b"]);
		expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
		expect(splitLines("a\rb")).toEqual(["a", "b"]);
		expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
	});

	it("keeps a trailing empty line and handles the empty string", () => {
		expect(splitLines("a\n")).toEqual(["a", ""]);
		expect(splitLines("")).toEqual([""]);
	});
});

describe("positionToOffset / offsetToPosition", () => {
	const samples = [
		"const x = 1;\nconst y = 2;\n",
		"line one\nline two\r\nline three\rline four",
		"emoji 😀 here",
		"CJK ext B 𠀀 done",
		"😀\n𠀀\n",
	];

	it("round-trips every valid position in every encoding", () => {
		for (const text of samples) {
			for (const encoding of ENCODINGS) {
				for (const offset of roundTrippableOffsets(text)) {
					const position = offsetToPosition(text, offset, encoding);
					expect(positionToOffset(text, position, encoding), `${encoding} @ ${offset}`).toBe(offset);
				}
			}
		}
	});

	it("counts astral characters in the negotiated encoding", () => {
		const text = "a😀b";
		// 'a' is one unit, '😀' is two UTF-16 units, four UTF-8 bytes, one UTF-32 unit.
		expect(offsetToPosition(text, 3, "utf-16")).toEqual({ line: 0, character: 3 });
		expect(offsetToPosition(text, 3, "utf-8")).toEqual({ line: 0, character: 5 });
		expect(offsetToPosition(text, 3, "utf-32")).toEqual({ line: 0, character: 2 });
	});

	it("resolves positions on later lines", () => {
		const text = "ab\ncd";
		expect(offsetToPosition(text, 3, "utf-16")).toEqual({ line: 1, character: 0 });
		expect(offsetToPosition(text, 2, "utf-16")).toEqual({ line: 0, character: 2 });
		expect(positionToOffset(text, { line: 1, character: 1 }, "utf-16")).toBe(4);
	});

	it("clamps a character past the line end to the terminator", () => {
		const text = "ab\ncd";
		expect(positionToOffset(text, { line: 0, character: 99 }, "utf-16")).toBe(2);
		expect(positionToOffset(text, { line: 1, character: 99 }, "utf-16")).toBe(5);
	});

	it("clamps a line past the end to the end of the text", () => {
		expect(positionToOffset("ab\ncd", { line: 9, character: 0 }, "utf-16")).toBe(5);
		expect(positionToOffset("ab\ncd", { line: -1, character: 0 }, "utf-16")).toBe(0);
	});

	it("never lands inside a surrogate pair", () => {
		// Character 1 would split "😀"; it clamps back to the code point start.
		expect(positionToOffset("😀", { line: 0, character: 1 }, "utf-16")).toBe(0);
		expect(positionToOffset("😀", { line: 0, character: 2 }, "utf-16")).toBe(2);
	});

	it("clamps out-of-range offsets", () => {
		expect(offsetToPosition("abc", -5, "utf-16")).toEqual({ line: 0, character: 0 });
		expect(offsetToPosition("abc", 99, "utf-16")).toEqual({ line: 0, character: 3 });
	});
});

describe("clampPosition", () => {
	it("clamps the line and then the character", () => {
		const text = "ab\ncd";
		expect(clampPosition(text, { line: 0, character: 99 }, "utf-16")).toEqual({ line: 0, character: 2 });
		expect(clampPosition(text, { line: 9, character: 0 }, "utf-16")).toEqual({ line: 1, character: 0 });
		expect(clampPosition(text, { line: 1, character: 99 }, "utf-16")).toEqual({ line: 1, character: 2 });
		expect(clampPosition(text, { line: -1, character: -1 }, "utf-16")).toEqual({ line: 0, character: 0 });
	});

	it("counts the clamp in the negotiated encoding", () => {
		expect(clampPosition("😀", { line: 0, character: 99 }, "utf-16")).toEqual({ line: 0, character: 2 });
		expect(clampPosition("😀", { line: 0, character: 99 }, "utf-8")).toEqual({ line: 0, character: 4 });
		expect(clampPosition("😀", { line: 0, character: 99 }, "utf-32")).toEqual({ line: 0, character: 1 });
	});
});
