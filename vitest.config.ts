import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// The repository is a skeleton while milestone M0 lands; an empty suite
		// is expected rather than a failure.
		passWithNoTests: true,
	},
});
