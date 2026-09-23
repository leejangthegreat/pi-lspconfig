/**
 * Deep merge with the pi-lspconfig override policy.
 *
 * This is the single place that defines how a user's config wins over a
 * built-in server spec. The policy is intentionally *not* nvim-lspconfig's
 * `tbl_deep_extend('keep', ...)`, which merges lists index-by-index — a known
 * footgun. The rules here are:
 *
 * | User value      | Result                                              |
 * | --------------- | --------------------------------------------------- |
 * | plain object    | merged recursively; user keys win                   |
 * | array           | replaces the default entirely                       |
 * | function        | replaces the default entirely (never composed)      |
 * | `undefined`     | keeps the default                                   |
 * | `null`          | deletes the key from the result                     |
 * | anything else   | replaces the default                                |
 *
 * `undefined` and `null` are distinguishable on purpose: `undefined` means
 * "I did not set this", `null` means "remove this".
 */

export type Mergeable = Record<string, unknown>;

/**
 * Recursively merge `override` onto `base`.
 *
 * Neither input is mutated, and the result never aliases a nested plain object
 * or array from either input.
 *
 * The parameters are typed `object` rather than `Mergeable` on purpose:
 * interfaces (`LspServerSpec`, `LspconfigUserConfig`) have no implicit index
 * signature, so a `Record<string, unknown>` constraint would not infer.
 */
export function deepMerge<T extends object>(base: T, override: object): T {
	const result = cloneValue(base) as Mergeable;

	for (const key of Object.keys(override)) {
		const value = (override as Mergeable)[key];

		if (value === undefined) continue; // "I did not set this": keep the default.
		if (value === null) {
			delete result[key]; // "remove this".
			continue;
		}

		const existing = result[key];
		if (isPlainObject(value) && isPlainObject(existing)) {
			assign(result, key, deepMerge(existing, value));
		} else {
			assign(result, key, cloneValue(value));
		}
	}

	return result as T;
}

/** True for a value that should be treated as a merge container (not arrays, not `null`). */
export function isPlainObject(value: unknown): value is Mergeable {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Apply a `null` deletion sentinel to a key set.
 *
 * Exposed separately so config resolution can report *which* keys a user
 * deleted, which is useful for `/lsp-config` output. Paths are dotted so a
 * nested deletion (`settings.python.analysis.inlayHints: null`) is reported in
 * full rather than as a useless top-level `settings`.
 */
export function collectDeletedKeys(override: object): string[] {
	const deleted: string[] = [];
	collectNulls(override as Mergeable, "", deleted);
	return deleted;
}

function collectNulls(node: Mergeable, prefix: string, out: string[]): void {
	for (const key of Object.keys(node)) {
		const value = node[key];
		const path = prefix ? `${prefix}.${key}` : key;

		if (value === null) {
			out.push(path);
		} else if (isPlainObject(value)) {
			collectNulls(value, path, out);
		}
	}
}

/**
 * Deep-copy a merge value.
 *
 * Only containers are copied; everything else is returned by reference.
 * Functions must replace by identity (a closure cannot be cloned), and
 * `Date`/`RegExp`/class instances are left alone because copying them changes
 * their semantics. Copying plain objects and arrays keeps the merged result
 * from aliasing either input — mutating `resolveConfig()` output must not
 * corrupt `BUILTIN_SERVERS`.
 */
function cloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneValue);
	if (isPlainObject(value)) {
		const out: Mergeable = {};
		for (const key of Object.keys(value)) {
			assign(out, key, cloneValue(value[key]));
		}
		return out;
	}
	return value;
}

/**
 * Write an own enumerable property.
 *
 * `Object.defineProperty` rather than `target[key] =` so an own `__proto__`
 * key (reachable through `JSON.parse` or a programmatic config) cannot mutate
 * the prototype instead of creating a property.
 */
function assign(target: Mergeable, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}
