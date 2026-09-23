import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { invalidateConfigCache, loadUserConfig } from "../../../src/config/load.ts";

const dir = (name: string) => fileURLToPath(new URL(`../../fixtures/config/${name}`, import.meta.url));
const MISSING_HOME = fileURLToPath(new URL("../../fixtures/config/__missing_home__", import.meta.url));

beforeEach(() => {
	invalidateConfigCache();
});

describe("loadUserConfig with real jiti", () => {
	it("loads a TypeScript config's default export", async () => {
		const loaded = await loadUserConfig({
			cwd: dir("project"),
			homeDir: MISSING_HOME,
			projectTrusted: true,
		});

		expect(loaded.errors).toEqual([]);
		expect(loaded.files).toEqual([join(dir("project"), "pi-lspconfig.config.ts")]);
		expect(loaded.config.disabledServers).toEqual(["gopls"]);
		expect(loaded.config.languageIds).toEqual({ ".vue": "vue" });
		expect(loaded.config.defaults).toEqual({ maxResults: 42 });
	});

	it("reports an invalid config as an error without throwing", async () => {
		const loaded = await loadUserConfig({
			cwd: dir("invalid"),
			homeDir: MISSING_HOME,
			projectTrusted: true,
		});

		expect(loaded.files).toEqual([]);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]?.file).toBe(join(dir("invalid"), "pi-lspconfig.config.ts"));
		expect(loaded.errors[0]?.message).toContain("cmd");
	});
});
