/**
 * Path and URI helpers.
 *
 * Deliberately free of `node:url`-vs-`node:path` platform surprises: containment
 * checks compare path *shape* rather than trusting `process.platform`, so a
 * Windows-style path is handled correctly even when the tests run on POSIX.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

/** True when the path looks like a Windows path (`C:\...`, `C:/...`, `\\server\share`, `//server/share`). */
export function isWindowsPath(path: string): boolean {
	return /^[A-Za-z]:(?:[\\/]|$)/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

/**
 * Normalise a path for comparison: resolve `.`/`..`, collapse separators, strip
 * a trailing separator.
 *
 * Backslashes are treated as separators regardless of host, so a Windows path
 * normalises identically on POSIX and Windows. Drive letters are upper-cased and
 * a UNC share keeps its `//server/share` prefix. Relative paths keep a leading
 * `..` rather than escaping to the filesystem root.
 */
export function normalizePath(path: string): string {
	if (path.length === 0) return ".";

	let input = path.replace(/\\/g, "/");
	let prefix = "";

	if (input.startsWith("//")) {
		// UNC: `//server/share/rest` — the host and share are not navigable segments.
		const parts = input.slice(2).split("/");
		const server = parts.shift() ?? "";
		const share = parts.shift() ?? "";
		prefix = share.length > 0 ? `//${server}/${share}` : `//${server}`;
		input = `/${parts.join("/")}`;
	} else {
		const drive = /^([A-Za-z]):/.exec(input);
		if (drive !== null) {
			prefix = `${(drive[1] ?? "").toUpperCase()}:`;
			input = input.slice(2);
		}
	}

	const absolute = input.startsWith("/");
	const segments: string[] = [];
	for (const segment of input.split("/")) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			const last = segments[segments.length - 1];
			if (last !== undefined && last !== "..") segments.pop();
			else if (!absolute) segments.push("..");
			continue;
		}
		segments.push(segment);
	}

	const joined = segments.join("/");
	if (prefix.startsWith("//")) {
		return joined.length > 0 ? `${prefix}/${joined}` : prefix;
	}
	if (prefix.length > 0) {
		// A drive root keeps its trailing slash so `C:/` is never read as `C:`.
		return joined.length > 0 ? `${prefix}/${joined}` : `${prefix}/`;
	}
	if (absolute) return joined.length > 0 ? `/${joined}` : "/";
	return joined.length > 0 ? joined : ".";
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * Used to enforce the workspace root ceiling. Compares by path shape so that
 * `C:\repo` is recognised as a Windows path on any host, and so a POSIX path is
 * never mistaken for a Windows one (or vice versa).
 */
export function isSameOrWithin(child: string, parent: string): boolean {
	if (isWindowsPath(child) !== isWindowsPath(parent)) return false;

	const normalizedChild = normalizePath(child);
	const normalizedParent = normalizePath(parent);
	const separator = normalizedParent.endsWith("/") ? "" : "/";

	if (isWindowsPath(parent)) {
		const childLower = normalizedChild.toLowerCase();
		const parentLower = normalizedParent.toLowerCase();
		return childLower === parentLower || childLower.startsWith(`${parentLower}${separator}`);
	}
	return (
		normalizedChild === normalizedParent ||
		normalizedChild.startsWith(`${normalizedParent}${separator}`)
	);
}

/**
 * Convert a `file://` URI to an absolute filesystem path.
 *
 * Handles percent-encoding and Windows drive letters. A non-`file:` URI (a
 * virtual document, for example) is returned unchanged so callers can decide
 * what to do with it rather than losing the identifier.
 */
export function uriToPath(uri: string): string {
	if (!uri.startsWith("file:")) return uri;

	const withoutScheme = uri.slice("file:".length);

	// Windows drive: `file:///C:/x` or percent-encoded `file:///C%3A/x`.
	const driveMatch = /^\/{2,3}([A-Za-z])(?::|%3A)(\/.*)?$/i.exec(withoutScheme);
	if (driveMatch !== null) {
		const drive = (driveMatch[1] ?? "").toUpperCase();
		const rest = decodeURIComponent(driveMatch[2] ?? "/");
		return `${drive}:${rest.startsWith("/") ? rest : `/${rest}`}`;
	}

	// UNC: `file://server/share/x`.
	const uncMatch = /^\/{2}([^/]+)(\/.*)?$/.exec(withoutScheme);
	if (uncMatch !== null) {
		return `//${uncMatch[1] ?? ""}${decodeURIComponent(uncMatch[2] ?? "")}`;
	}

	try {
		return fileURLToPath(uri);
	} catch {
		return decodeURIComponent(withoutScheme);
	}
}

/** Convert an absolute filesystem path to a `file://` URI. */
export function pathToUri(path: string): string {
	const normalized = normalizePath(path);

	if (isWindowsPath(path)) {
		if (normalized.startsWith("//")) {
			// UNC: `//server/share/x` → `file://server/share/x`.
			const rest = normalized.slice(2);
			const slash = rest.indexOf("/");
			const host = slash === -1 ? rest : rest.slice(0, slash);
			const tail = slash === -1 ? "" : rest.slice(slash);
			return `file://${encodeURIComponent(host)}${encodePathSegments(tail)}`;
		}
		// Drive: `C:/x` → `file:///C:/x`.
		return `file:///${normalized.slice(0, 2)}${encodePathSegments(normalized.slice(2))}`;
	}

	return pathToFileURL(normalized).href;
}

/** Percent-encode each segment, keeping the `/` separators intact. */
function encodePathSegments(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}
