/**
 * Path and URI helpers.
 *
 * Deliberately free of `node:url`-vs-`node:path` platform surprises: containment
 * checks compare path *shape* rather than trusting `process.platform`, so a
 * Windows-style path is handled correctly even when the tests run on POSIX.
 */

/**
 * Convert a `file://` URI to an absolute filesystem path.
 *
 * Handles percent-encoding and Windows drive letters.
 */
export function uriToPath(_uri: string): string {
	throw new Error("Not implemented: uriToPath");
}

/** Convert an absolute filesystem path to a `file://` URI. */
export function pathToUri(_path: string): string {
	throw new Error("Not implemented: pathToUri");
}

/** Normalise a path for comparison: resolve `.`/`..`, collapse separators, strip a trailing separator. */
export function normalizePath(_path: string): string {
	throw new Error("Not implemented: normalizePath");
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * Used to enforce the workspace root ceiling. Compares by path shape so that
 * `C:\repo` is recognised as a Windows path on any host.
 */
export function isSameOrWithin(_child: string, _parent: string): boolean {
	throw new Error("Not implemented: isSameOrWithin");
}

/** True when the path looks like a Windows path (`C:\...`, `\\server\share`). */
export function isWindowsPath(_path: string): boolean {
	throw new Error("Not implemented: isWindowsPath");
}
