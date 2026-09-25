import { describe, expect, it } from "vitest";
import {
	isSameOrWithin,
	isWindowsPath,
	normalizePath,
	pathToUri,
	uriToPath,
} from "../../../src/util/paths.ts";

describe("isWindowsPath", () => {
	it("recognises drive letters and UNC paths", () => {
		expect(isWindowsPath("C:\\repo\\a.ts")).toBe(true);
		expect(isWindowsPath("C:/repo/a.ts")).toBe(true);
		expect(isWindowsPath("c:/repo")).toBe(true);
		expect(isWindowsPath("\\\\server\\share")).toBe(true);
		expect(isWindowsPath("//server/share")).toBe(true);
	});

	it("rejects POSIX paths and drive-relative names", () => {
		expect(isWindowsPath("/home/lee/a.ts")).toBe(false);
		expect(isWindowsPath("src/a.ts")).toBe(false);
		// `C:foo` is drive-relative, not absolute; treating it as Windows would
		// make containment checks meaningless.
		expect(isWindowsPath("C:foo")).toBe(false);
	});
});

describe("normalizePath", () => {
	it("resolves dot segments and collapses separators", () => {
		expect(normalizePath("/a/b/../c")).toBe("/a/c");
		expect(normalizePath("/a//b/")).toBe("/a/b");
		expect(normalizePath("/a/./b")).toBe("/a/b");
		expect(normalizePath("/")).toBe("/");
	});

	it("cannot escape the filesystem root", () => {
		expect(normalizePath("/a/../../b")).toBe("/b");
		expect(normalizePath("/..")).toBe("/");
	});

	it("keeps a leading `..` for relative paths", () => {
		expect(normalizePath("../a")).toBe("../a");
		expect(normalizePath("./a")).toBe("a");
	});

	it("normalises Windows paths on any host", () => {
		expect(normalizePath("C:\\repo\\.\\src")).toBe("C:/repo/src");
		expect(normalizePath("c:\\Repo\\..\\other")).toBe("C:/other");
		expect(normalizePath("C:\\")).toBe("C:/");
	});

	it("preserves a UNC server and share", () => {
		expect(normalizePath("\\\\server\\share\\dir\\..\\other")).toBe("//server/share/other");
		expect(normalizePath("//server/share")).toBe("//server/share");
	});
});

describe("isSameOrWithin", () => {
	it("accepts the parent itself and anything beneath it", () => {
		expect(isSameOrWithin("/repo", "/repo")).toBe(true);
		expect(isSameOrWithin("/repo/a/b.ts", "/repo")).toBe(true);
	});

	it("does not match a sibling or a name-prefixed directory", () => {
		expect(isSameOrWithin("/repo/a", "/repo/b")).toBe(false);
		expect(isSameOrWithin("/repository", "/repo")).toBe(false);
		expect(isSameOrWithin("/repo", "/repo/a")).toBe(false);
	});

	it("is case-insensitive and separator-agnostic for Windows paths", () => {
		expect(isSameOrWithin("C:\\repo\\a.ts", "c:/repo")).toBe(true);
		expect(isSameOrWithin("C:/repo/a.ts", "C:\\repo")).toBe(true);
		expect(isSameOrWithin("C:/other", "C:/repo")).toBe(false);
	});

	it("never conflates a Windows path with a POSIX one", () => {
		expect(isSameOrWithin("C:\\repo\\a.ts", "/repo")).toBe(false);
		expect(isSameOrWithin("/repo/a.ts", "C:/repo")).toBe(false);
	});
});

describe("uriToPath", () => {
	it("decodes percent-encoding", () => {
		expect(uriToPath("file:///home/lee/a%20b.ts")).toBe("/home/lee/a b.ts");
	});

	it("restores Windows drive letters", () => {
		expect(uriToPath("file:///C:/repo/a.ts")).toBe("C:/repo/a.ts");
		expect(uriToPath("file:///c%3A/repo")).toBe("C:/repo");
	});

	it("restores UNC hosts", () => {
		expect(uriToPath("file://server/share/x")).toBe("//server/share/x");
	});

	it("passes a non-file URI through unchanged", () => {
		expect(uriToPath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
	});
});

describe("pathToUri", () => {
	it("encodes spaces and round-trips a POSIX path", () => {
		const path = "/home/lee/a b.ts";
		const uri = pathToUri(path);
		expect(uri).toBe("file:///home/lee/a%20b.ts");
		expect(uriToPath(uri)).toBe(path);
	});

	it("round-trips a Windows drive path", () => {
		const uri = pathToUri("C:\\repo\\a b.ts");
		expect(uri).toBe("file:///C:/repo/a%20b.ts");
		expect(uriToPath(uri)).toBe("C:/repo/a b.ts");
	});

	it("round-trips a UNC path", () => {
		const uri = pathToUri("//server/share/a.ts");
		expect(uri).toBe("file://server/share/a.ts");
		expect(uriToPath(uri)).toBe("//server/share/a.ts");
	});
});
