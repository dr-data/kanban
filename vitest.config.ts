import { defineConfig } from "vitest/config";
import vitestNode22CiReporter from "./test/vitest-node22-ci-reporter.js";

process.env.NODE_ENV = "production";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@clinebot\/agents$/,
				replacement: "@clinebot/agents/node",
			},
			{
				find: /^@clinebot\/llms$/,
				replacement: "@clinebot/llms/node",
			},
		],
	},
	test: {
		globals: true,
		environment: "node",
		globalSetup: ["./test/vitest-global-teardown.ts"],
		reporters: ["default", vitestNode22CiReporter],
		exclude: ["apps/**", "web-ui/**", "third_party/**", "**/node_modules/**", "**/dist/**", ".worktrees/**"],
		testTimeout: 15_000,
	},
});
