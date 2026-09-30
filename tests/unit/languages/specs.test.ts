/**
 * Catalog invariants.
 *
 * A `binary_missing` hint is only actionable when the spec says how to install
 * the binary, so every built-in server must carry an `installCommand`. This
 * runs without any toolchain, unlike the real-server smoke tests.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_SERVERS } from "../../../src/languages/index.ts";

describe("built-in server catalog", () => {
	it("declares an install command for every server", () => {
		for (const spec of BUILTIN_SERVERS) {
			expect(spec.installCommand, `${spec.id} has no installCommand`).toBeTruthy();
		}
	});

	it("describes every server for the docs generator", () => {
		for (const spec of BUILTIN_SERVERS) {
			expect(spec.docs?.description, `${spec.id} has no docs.description`).toBeTruthy();
			expect(spec.docs?.url, `${spec.id} has no docs.url`).toBeTruthy();
		}
	});

	it("leaves auto-install off until a config opts in", () => {
		for (const spec of BUILTIN_SERVERS) {
			expect(spec.autoInstall, `${spec.id} must not auto-install by default`).toBeUndefined();
		}
	});
});
