import { stop as stopEsbuild } from "esbuild";

// Node 22 changed stream.pipeline() to wait for the "close" event before
// completing (nodejs/node#53462). The esbuild child process that vite spawns
// for TypeScript transforms holds stdio handles open indefinitely, which
// prevents the Node event loop from draining after tests finish. Explicitly
// stopping esbuild releases those handles so vitest can exit cleanly.
//
// On Node 20 (and locally on Node 22 with faster shutdown timing), vitest
// exits before this becomes a problem. In CI on Node 22, the slower runner
// timing consistently triggers the hang.
export async function teardown(): Promise<void> {
	await stopEsbuild();
}
