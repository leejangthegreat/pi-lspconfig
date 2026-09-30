/**
 * Config schema — the fields that must survive validation.
 *
 * `installCommand` was documented but missing from the schema until M6, which
 * made a valid override fail with "unexpected property". `autoInstall` and
 * `docs.notes` are the M6 additions, so all three are pinned here.
 */

import { describe, expect, it } from "vitest";
import { validateUserConfig } from "../../../src/config/schema.ts";

describe("validateUserConfig", () => {
	it("accepts installCommand, autoInstall, and docs.notes on a server override", () => {
		const result = validateUserConfig({
			servers: {
				gopls: {
					installCommand: "go install golang.org/x/tools/gopls@latest",
					autoInstall: true,
					docs: { description: "Go language server.", notes: "Why go.work wins." },
				},
			},
		});

		expect(result.ok).toBe(true);
	});

	it("rejects a non-boolean autoInstall", () => {
		const result = validateUserConfig({ servers: { gopls: { autoInstall: "yes" } } });

		expect(result.ok).toBe(false);
	});

	it("rejects unknown keys inside docs", () => {
		const result = validateUserConfig({
			servers: { gopls: { docs: { description: "Go.", tagline: "nope" } } },
		});

		expect(result.ok).toBe(false);
	});

	it("still rejects unknown top-level server keys", () => {
		const result = validateUserConfig({ servers: { gopls: { filetype: ["go"] } } });

		expect(result.ok).toBe(false);
	});
});
