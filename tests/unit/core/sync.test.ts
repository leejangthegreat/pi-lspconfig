import { describe, expect, it } from "vitest";
import { buildContentChanges, createDocumentSynchronizer } from "../../../src/core/client/sync.ts";
import type { LSPConnection } from "../../../src/core/client/connection.ts";

interface Notification {
	method: string;
	params: unknown;
}

/** A hand-rolled connection so these unit tests never spawn a process. */
function createStubConnection(): { connection: LSPConnection; notifications: Notification[] } {
	const notifications: Notification[] = [];
	const connection = {
		raw: undefined,
		sendRequest: () => Promise.reject(new Error("sendRequest is not used by the synchronizer")),
		sendNotification: (method: string, params: unknown) => {
			notifications.push({ method, params });
		},
		onNotification: () => ({ dispose: () => {} }),
		onRequest: () => ({ dispose: () => {} }),
		listen: () => {},
		cancelAll: () => {},
		dispose: () => {},
	} as unknown as LSPConnection;
	return { connection, notifications };
}

function didChangeVersions(notifications: readonly Notification[]): number[] {
	return notifications
		.filter((entry) => entry.method === "textDocument/didChange")
		.map((entry) => (entry.params as { textDocument: { version: number } }).textDocument.version);
}

const FILE = "/virtual/a.ts";

describe("buildContentChanges", () => {
	it("returns no changes for identical text", () => {
		expect(buildContentChanges("same", "same")).toEqual([]);
	});

	it("produces one incremental edit for an insertion", () => {
		const changes = buildContentChanges("hello world", "hello brave world");

		expect(changes).toHaveLength(1);
		expect(changes[0]?.range).toEqual({
			start: { line: 0, character: 6 },
			end: { line: 0, character: 6 },
		});
		expect(changes[0]?.text).toBe("brave ");
		// `rangeLength` is deprecated; emitting it is the invariant-#6 trap.
		expect(changes[0]?.rangeLength).toBeUndefined();
	});

	it("appends at the end of the document", () => {
		const changes = buildContentChanges("abc", "abcd");
		expect(changes).toEqual([
			{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, text: "d" },
		]);
	});

	it("edits the right line of a multi-line document", () => {
		const changes = buildContentChanges("a\n", "a\nb\n");
		expect(changes).toEqual([
			{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: "b\n" },
		]);
	});

	it("falls back to a single full change when the diff is not worth it", () => {
		expect(buildContentChanges("aaaa", "bbbb")).toEqual([{ text: "bbbb" }]);
		expect(buildContentChanges("", "abc")).toEqual([{ text: "abc" }]);
		expect(buildContentChanges("abc", "")).toEqual([{ text: "" }]);
	});

	it("never splits a surrogate pair", () => {
		// The astral character itself differs, so the whole pair is replaced.
		expect(buildContentChanges("😀", "😁")).toEqual([{ text: "😁" }]);
		// Only the BMP character differs; the shared pair stays intact and the
		// range covers exactly one unit, never the middle of the pair.
		expect(buildContentChanges("X😀", "Y😀")).toEqual([
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: "Y" },
		]);
	});

	it("emits ranges in the negotiated encoding", () => {
		const utf16 = buildContentChanges("😀", "😀x", "utf-16");
		const utf8 = buildContentChanges("😀", "😀x", "utf-8");
		const utf32 = buildContentChanges("😀", "😀x", "utf-32");

		expect(utf16[0]?.range?.start).toEqual({ line: 0, character: 2 });
		expect(utf8[0]?.range?.start).toEqual({ line: 0, character: 4 });
		expect(utf32[0]?.range?.start).toEqual({ line: 0, character: 1 });
		expect(utf16[0]?.text).toBe("x");
	});
});

describe("createDocumentSynchronizer", () => {
	it("opens, changes, and closes with increasing versions", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({
			connection,
			syncKind: 2,
			languageIdFor: () => "typescript",
		});

		await sync.touch(FILE, { content: "const a = 1;\n" });
		await sync.touch(FILE, { content: "const a = 2;\n" });
		await sync.touch(FILE, { content: "const a = 2;\nconst b = 3;\n" });
		await sync.close(FILE);

		expect(notifications.map((entry) => entry.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didChange",
			"textDocument/didChange",
			"textDocument/didClose",
		]);
		expect(didChangeVersions(notifications)).toEqual([2, 3]);
		expect(sync.isOpen(FILE)).toBe(false);
	});

	it("does not re-send an unchanged document", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({ connection, syncKind: 2, languageIdFor: () => "ts" });

		await sync.touch(FILE, { content: "same" });
		await sync.touch(FILE, { content: "same" });
		await sync.touch(FILE, { content: "same" });

		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.method).toBe("textDocument/didOpen");
	});

	it("does not emit didChange for a dirty document whose content is unchanged", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({ connection, syncKind: 2, languageIdFor: () => "ts" });

		await sync.touch(FILE, { content: "same" });
		sync.markDirty(FILE);
		await sync.touch(FILE, { content: "same" });

		expect(notifications).toHaveLength(1);
	});

	it("sends a single full change when full sync is negotiated", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({ connection, syncKind: 1, languageIdFor: () => "ts" });

		await sync.touch(FILE, { content: "one" });
		await sync.touch(FILE, { content: "two" });

		const change = notifications[1];
		expect(change?.method).toBe("textDocument/didChange");
		expect((change?.params as { contentChanges: unknown[] }).contentChanges).toEqual([{ text: "two" }]);
	});

	it("sends no changes when the server opted out of sync", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({ connection, syncKind: 0, languageIdFor: () => "ts" });

		await sync.touch(FILE, { content: "one" });
		await sync.touch(FILE, { content: "two" });

		expect(notifications.map((entry) => entry.method)).toEqual(["textDocument/didOpen"]);
		expect(sync.openDocuments()[0]?.byteLength).toBe(3);
	});

	it("never opens a document above the size limit, and closes one that grows past it", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({
			connection,
			syncKind: 2,
			languageIdFor: () => "ts",
			maxDocumentBytes: 4,
		});

		await sync.touch(FILE, { content: "12345" });
		expect(sync.isOpen(FILE)).toBe(false);
		expect(notifications).toHaveLength(0);

		await sync.touch(FILE, { content: "123" });
		expect(sync.isOpen(FILE)).toBe(true);

		await sync.touch(FILE, { content: "12345" });
		expect(sync.isOpen(FILE)).toBe(false);
		expect(notifications.map((entry) => entry.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didClose",
		]);
	});

	it("closes every open document", async () => {
		const { connection, notifications } = createStubConnection();
		const sync = createDocumentSynchronizer({ connection, syncKind: 2, languageIdFor: () => "ts" });

		await sync.touch("/virtual/a.ts", { content: "a" });
		await sync.touch("/virtual/b.ts", { content: "b" });
		expect(sync.openDocuments()).toHaveLength(2);

		await sync.closeAll();

		expect(sync.openDocuments()).toHaveLength(0);
		expect(notifications.filter((entry) => entry.method === "textDocument/didClose")).toHaveLength(2);
	});
});
