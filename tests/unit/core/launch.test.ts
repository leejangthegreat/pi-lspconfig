import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEnv } from "../../../src/core/client/launch.ts";

describe("buildEnv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("forwards toolchain locators so proxies can find their installation", () => {
		vi.stubEnv("CARGO_HOME", "/opt/cargo");
		vi.stubEnv("RUSTUP_HOME", "/opt/rustup");
		vi.stubEnv("GOPATH", "/opt/go");

		const env = buildEnv();

		expect(env.CARGO_HOME).toBe("/opt/cargo");
		expect(env.RUSTUP_HOME).toBe("/opt/rustup");
		expect(env.GOPATH).toBe("/opt/go");
	});

	it("does not forward the rest of the parent environment", () => {
		vi.stubEnv("PI_LSPCONFIG_TEST_SECRET", "leak-me");

		expect(buildEnv().PI_LSPCONFIG_TEST_SECRET).toBeUndefined();
	});

	it("lets spec.env add and override entries", () => {
		vi.stubEnv("LANG", "en_US.UTF-8");

		const env = buildEnv({ LANG: "C", MY_VAR: "x" });

		expect(env.LANG).toBe("C");
		expect(env.MY_VAR).toBe("x");
	});
});
