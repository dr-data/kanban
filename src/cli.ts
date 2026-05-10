import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import type { Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config";
import type { RuntimeCommandRunResponse } from "./core/api-contract";
import { createGitProcessEnv } from "./core/git-process-env";
import {
	installGracefulShutdownHandlers,
	shouldSuppressImmediateDuplicateShutdownSignals,
} from "./core/graceful-shutdown";
import {
	buildKanbanRuntimeUrl,
	clearKanbanRuntimeTls,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getRuntimeFetch,
	isKanbanRemoteHost,
	parseRuntimePort,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
	setKanbanRuntimeTls,
} from "./core/runtime-endpoint";
import { disablePasscode, generateInternalToken, generatePasscode } from "./security/passcode-manager";
import { terminateProcessForTimeout } from "./server/process-termination";
import type { RuntimeStateHub } from "./server/runtime-state-hub";
import type { TerminalSessionManager } from "./terminal/session-manager";
import type { RuntimeAppRouter } from "./trpc/app-router";

/*
	Heavy command modules (`./commands/task`, `./commands/hooks`) and Sentry/
	Cline SDK telemetry are loaded lazily because their import graphs are very
	heavy (~3-4 seconds of cold-start tsx compilation each). They are only
	needed for specific subcommands or for error reporting/shutdown cleanup —
	never on the hot path to `console.log("Cline Kanban running at ...")`.

	Keeping them top-level caused the source CLI to take 12+ seconds even for
	`kanban --version` because tsx eagerly transpiles the full graph (trpc
	client, terminal stack, workspace state, telemetry) regardless of which
	subcommand is invoked. Route-level lazy loading mirrors how a web app would
	code-split per route — each subcommand is its own "route" through the CLI.
*/

/** Lazily import and dispose the Cline telemetry singleton. */
async function lazyDisposeCliTelemetryService(): Promise<void> {
	const { disposeCliTelemetryService } = await import("./cline-sdk/cline-telemetry-service.js");
	await disposeCliTelemetryService();
}

/** Lazily import Sentry and capture an exception. */
function lazyCaptureNodeException(error: unknown, options?: { area?: string }): void {
	void import("./telemetry/sentry-node.js").then(({ captureNodeException }) => {
		captureNodeException(error, options);
	});
}

/** Lazily import Sentry and flush pending telemetry events. */
async function lazyFlushNodeTelemetry(): Promise<void> {
	const { flushNodeTelemetry } = await import("./telemetry/sentry-node.js");
	await flushNodeTelemetry();
}

/**
 * Returns the subcommand name that the user is invoking, or null for the
 * default GUI launch path. Used to skip importing heavy command modules that
 * the user is not asking for.
 */
function detectInvokedSubcommand(argv: string[]): string | null {
	for (const arg of argv) {
		if (!arg) {
			continue;
		}
		// Stop scanning at the first non-flag positional argument.
		if (!arg.startsWith("-")) {
			return arg;
		}
	}
	return null;
}

/** Returns true when the help flag is present anywhere in argv. */
function argvContainsHelpFlag(argv: string[]): boolean {
	return argv.some((arg) => arg === "--help" || arg === "-h" || arg === "help");
}

interface CliOptions {
	noOpen: boolean;
	skipShutdownCleanup: boolean;
	host: string | null;
	port: { mode: "fixed"; value: number } | { mode: "auto" } | null;
	https: boolean;
	cert: string | null;
	key: string | null;
	noPasscode: boolean;
}

const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

function parseCliPortValue(rawValue: string): { mode: "fixed"; value: number } | { mode: "auto" } {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

interface RootCommandOptions {
	host?: string;
	port?: { mode: "fixed"; value: number } | { mode: "auto" };
	open?: boolean;
	skipShutdownCleanup?: boolean;
	update?: boolean;
	https?: boolean;
	cert?: string;
	key?: string;
	noPasscode?: boolean;
}

type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
}

/**
 * Decide whether this CLI invocation should auto-open a browser tab.
 *
 * This uses a positive allowlist for app-launch shapes like `kanban`,
 * `kanban --agent codex`, and `kanban --port 3484`. Any subcommand or
 * unexpected argument is treated as a command-style invocation instead.
 */
function shouldAutoOpenBrowserTabForInvocation(argv: string[]): boolean {
	const launchFlags = new Set(["--open", "--no-open", "--skip-shutdown-cleanup", "--https", "--no-passcode"]);
	const launchOptionsWithValues = new Set(["--host", "--port", "--agent", "--cert", "--key"]);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return false;
		}
		if (launchFlags.has(arg)) {
			continue;
		}
		const optionName = arg.split("=", 1)[0] ?? arg;
		if (!launchOptionsWithValues.has(optionName)) {
			return false;
		}
		if (arg.includes("=")) {
			continue;
		}
		const optionValue = argv[index + 1];
		if (!optionValue) {
			return false;
		}
		index += 1;
	}

	return true;
}

/**
 * Build the shutdown spinner. Takes the `ora` factory as an argument so that
 * the caller can lazy-import the module — keeping `ora` (a ~700ms cold-start
 * dependency) off the top-level import graph for non-runtime subcommands.
 */
function createShutdownIndicator(
	oraFactory: typeof import("ora").default,
	stream: NodeJS.WriteStream = process.stderr,
): ShutdownIndicator {
	let spinner: Ora | null = null;
	let running = false;

	return {
		start() {
			if (running) {
				return;
			}
			running = true;
			if (!stream.isTTY) {
				stream.write("Cleaning up...\n");
				return;
			}
			spinner = oraFactory({
				text: "Cleaning up...",
				stream,
			}).start();
		},
		stop(result = "done") {
			if (!running) {
				return;
			}
			running = false;
			if (spinner) {
				if (result === "done") {
					spinner.succeed("Cleaning up... done");
				} else if (result === "failed") {
					spinner.fail("Cleaning up... failed");
				} else {
					spinner.warn("Cleaning up... interrupted");
				}
				spinner = null;
				return;
			}

			const suffix = result === "done" ? "done" : result === "interrupted" ? "interrupted" : "failed";
			stream.write(`Cleanup ${suffix}.\n`);
		},
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => {
			resolve(false);
		});
		probe.listen(port, getKanbanRuntimeHost(), () => {
			probe.close(() => {
				resolve(true);
			});
		});
	});
}

async function findAvailableRuntimePort(startPort: number): Promise<number> {
	for (let candidate = startPort; candidate <= 65535; candidate += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
	}
	throw new Error("No available runtime port found.");
}

async function applyRuntimePortOption(portOption: CliOptions["port"]): Promise<number | null> {
	if (!portOption) {
		return null;
	}
	if (portOption.mode === "fixed") {
		setKanbanRuntimePort(portOption.value);
		return portOption.value;
	}
	const autoPort = await findAvailableRuntimePort(DEFAULT_KANBAN_RUNTIME_PORT);
	setKanbanRuntimePort(autoPort);
	return autoPort;
}

type TlsResult = { enabled: false } | { enabled: true };

async function resolveRuntimeTls(options: CliOptions): Promise<TlsResult> {
	const wantsHttps = options.https || options.cert !== null || options.key !== null;
	if (!wantsHttps) {
		clearKanbanRuntimeTls();
		return { enabled: false };
	}
	if (!options.cert || !options.key) {
		throw new Error("HTTPS requires both --cert and --key. Use plain HTTP if you do not have a TLS certificate.");
	}
	const cert = readFileSync(resolve(options.cert), "utf8");
	const key = readFileSync(resolve(options.key), "utf8");
	// Trust the exact configured cert for Kanban's own subcommands without
	// disabling certificate validation for unrelated HTTPS endpoints.
	setKanbanRuntimeTls({ cert, key, ca: cert });
	return { enabled: true };
}

async function assertPathIsDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Project path is not a directory: ${path}`);
	}
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

function hasGitRepository(path: string): boolean {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: path,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	return result.status === 0 && result.stdout.trim() === "true";
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "EADDRINUSE"
	);
}

async function canReachKanbanServer(workspaceId: string | null): Promise<boolean> {
	try {
		const headers: Record<string, string> = {};
		if (workspaceId) {
			headers["x-kanban-workspace-id"] = workspaceId;
		}
		const runtimeFetch = await getRuntimeFetch();
		const response = await runtimeFetch(buildKanbanRuntimeUrl("/api/trpc/projects.list"), {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(1_500),
		});
		if (response.status === 404) {
			return false;
		}
		const payload = (await response.json().catch(() => null)) as {
			result?: { data?: unknown };
			error?: unknown;
		} | null;
		return Boolean(payload && (payload.result || payload.error));
	} catch {
		return false;
	}
}

async function tryOpenExistingServer(options: { noOpen: boolean; shouldAutoOpenBrowser: boolean }): Promise<boolean> {
	let workspaceId: string | null = null;
	if (hasGitRepository(process.cwd())) {
		const { loadWorkspaceContext } = await import("./state/workspace-state.js");
		const context = await loadWorkspaceContext(process.cwd());
		workspaceId = context.workspaceId;
	}
	const running = await canReachKanbanServer(workspaceId);
	if (!running) {
		return false;
	}
	const projectUrl = workspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(workspaceId)}`)
		: getKanbanRuntimeOrigin();
	console.log(`Kanban already running at ${getKanbanRuntimeOrigin()}`);
	if (!options.noOpen && options.shouldAutoOpenBrowser) {
		try {
			const { openInBrowser } = await import("./server/browser.js");
			openInBrowser(projectUrl, {
				warn: (message) => {
					console.warn(message);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Could not open browser automatically: ${message}`);
		}
	}
	console.log(`Project URL: ${projectUrl}`);
	return true;
}

async function runScopedCommand(command: string, cwd: string): Promise<RuntimeCommandRunResponse> {
	const startedAt = Date.now();
	const outputLimitBytes = 64 * 1024;

	return await new Promise<RuntimeCommandRunResponse>((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (!child.stdout || !child.stderr) {
			reject(new Error("Shortcut process did not expose stdout/stderr."));
			return;
		}

		let stdout = "";
		let stderr = "";

		const appendOutput = (current: string, chunk: string): string => {
			const next = current + chunk;
			if (next.length <= outputLimitBytes) {
				return next;
			}
			return next.slice(0, outputLimitBytes);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout = appendOutput(stdout, String(chunk));
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr = appendOutput(stderr, String(chunk));
		});

		child.on("error", (error) => {
			reject(error);
		});

		const timeout = setTimeout(() => {
			terminateProcessForTimeout(child);
		}, 60_000);

		child.on("close", (code) => {
			clearTimeout(timeout);
			const exitCode = typeof code === "number" ? code : 1;
			const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			resolve({
				exitCode,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				combinedOutput,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

async function startServer(): Promise<{
	url: string;
	close: () => Promise<void>;
	shutdown: (options?: { skipSessionCleanup?: boolean }) => Promise<void>;
}> {
	/*
		Server-only modules are loaded lazily because task-oriented subcommands like
		`kanban task create` and `kanban hooks ingest` do not need the runtime server.

		A regression in 25ba59f showed that eagerly importing the runtime stack here
		could leave the source CLI process alive after the command had already printed
		its JSON result. The issue first appeared after the native Cline SDK runtime
		was added to the server import graph. We have not yet isolated the deepest
		handle creator inside that graph, so we keep command-style subcommands on the
		lightweight path and only load the server stack when we actually start Kanban.
	*/
	const [
		{ resolveProjectInputPath },
		{ pickDirectoryPathFromSystemDialog },
		{ createRuntimeServer },
		{ createRuntimeStateHub },
		{ resolveInteractiveShellCommand },
		{ shutdownRuntimeServer },
		{ collectProjectWorktreeTaskIdsForRemoval, createWorkspaceRegistry },
		{ listWorkspaceIndexEntries, loadWorkspaceState, mutateWorkspaceState },
		{ createTRPCProxyClient, httpBatchLink },
		{ createTaskScheduleMonitor },
		{ createTaskRecurringMonitor },
		{ clearPendingUpdateNotification, getPendingUpdateNotification, runOnDemandUpdate },
	] = await Promise.all([
		import("./projects/project-path.js"),
		import("./server/directory-picker.js"),
		import("./server/runtime-server.js"),
		import("./server/runtime-state-hub.js"),
		import("./server/shell.js"),
		import("./server/shutdown-coordinator.js"),
		import("./server/workspace-registry.js"),
		import("./state/workspace-state.js"),
		import("@trpc/client"),
		import("./server/task-schedule-monitor.js"),
		import("./server/task-recurring-monitor.js"),
		import("./update/update.js"),
	]);
	let runtimeStateHub: RuntimeStateHub | undefined;
	const workspaceRegistry = await createWorkspaceRegistry({
		cwd: process.cwd(),
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository,
		pathIsDirectory,
		onTerminalManagerReady: (workspaceId, manager) => {
			runtimeStateHub?.trackTerminalManager(workspaceId, manager);
		},
	});
	runtimeStateHub = createRuntimeStateHub({
		workspaceRegistry,
	});
	const runtimeHub = runtimeStateHub;
	for (const { workspaceId, terminalManager } of workspaceRegistry.listManagedWorkspaces()) {
		runtimeHub.trackTerminalManager(workspaceId, terminalManager);
	}

	const disposeTrackedWorkspace = (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const disposed = workspaceRegistry.disposeWorkspace(workspaceId, {
			stopTerminalSessions: options?.stopTerminalSessions,
		});
		runtimeHub.disposeWorkspace(workspaceId);
		return disposed;
	};

	const runtimeServer = await createRuntimeServer({
		workspaceRegistry,
		runtimeStateHub: runtimeHub,
		warn: (message) => {
			console.warn(`[kanban] ${message}`);
		},
		ensureTerminalManagerForWorkspace: workspaceRegistry.ensureTerminalManagerForWorkspace,
		resolveInteractiveShellCommand,
		runCommand: runScopedCommand,
		resolveProjectInputPath,
		assertPathIsDirectory,
		hasGitRepository,
		disposeWorkspace: disposeTrackedWorkspace,
		collectProjectWorktreeTaskIdsForRemoval,
		pickDirectoryPathFromSystemDialog,
		getUpdateStatus: () => {
			const notification = getPendingUpdateNotification();
			if (!notification) {
				return {
					currentVersion: KANBAN_VERSION,
					latestVersion: null,
					updateAvailable: false,
					updateTiming: null,
					installCommand: null,
				};
			}
			return {
				currentVersion: notification.currentVersion,
				latestVersion: notification.latestVersion,
				updateAvailable: true,
				updateTiming: notification.updateTiming,
				installCommand: notification.installCommand,
			};
		},
		runUpdateNow: async () => {
			const result = await runOnDemandUpdate({
				currentVersion: KANBAN_VERSION,
			});
			if (
				result.status === "updated" ||
				result.status === "already_up_to_date" ||
				result.status === "cache_refreshed"
			) {
				// The pending notification is a one-shot signal recorded at startup.
				// Clearing it here prevents the modal from reappearing on page reload
				// after the user has already applied the update.
				clearPendingUpdateNotification();
			}
			return {
				status: result.status,
				currentVersion: result.currentVersion,
				latestVersion: result.latestVersion,
				message: result.message,
			};
		},
	});

	/** Creates a tRPC proxy client that targets the local runtime server for a given workspace. */
	const createLocalTrpcClient = (workspaceId: string) =>
		createTRPCProxyClient<RuntimeAppRouter>({
			links: [
				httpBatchLink({
					url: buildKanbanRuntimeUrl("/api/trpc"),
					headers: () => ({ "x-kanban-workspace-id": workspaceId }),
				}),
			],
		});

	const monitorWarn = (message: string) => console.warn(`[kanban] ${message}`);

	/** Loads workspace state with live in-memory session summaries overlaid on
	 *  the persisted disk data. Without this overlay the lifecycle sweep sees
	 *  stale session state and may trash actively-running tasks. */
	const loadWorkspaceStateWithLiveSessions = async (cwd: string) => {
		const workspaceId = workspaceRegistry.getActiveWorkspaceId();
		if (workspaceId) {
			return workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, cwd);
		}
		return loadWorkspaceState(cwd);
	};

	const monitorDeps = {
		listWorkspaceIndexEntries,
		loadWorkspaceState: loadWorkspaceStateWithLiveSessions,
		mutateWorkspaceState,
		createTrpcClient: createLocalTrpcClient,
		broadcastRuntimeWorkspaceStateUpdated: runtimeHub.broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated: runtimeHub.broadcastRuntimeProjectsUpdated,
		warn: monitorWarn,
	};

	const scheduleMonitor = createTaskScheduleMonitor(monitorDeps);
	const recurringMonitor = createTaskRecurringMonitor(monitorDeps);

	const close = async () => {
		scheduleMonitor.close();
		recurringMonitor.close();
		await runtimeServer.close();
	};

	const shutdown = async (options?: { skipSessionCleanup?: boolean }) => {
		scheduleMonitor.close();
		recurringMonitor.close();
		await shutdownRuntimeServer({
			workspaceRegistry,
			warn: (message) => {
				console.warn(`[kanban] ${message}`);
			},
			closeRuntimeServer: async () => {
				await runtimeServer.close();
			},
			skipSessionCleanup: options?.skipSessionCleanup ?? false,
		});
	};

	return {
		url: runtimeServer.url,
		close,
		shutdown,
	};
}

async function startServerWithAutoPortRetry(options: CliOptions): Promise<Awaited<ReturnType<typeof startServer>>> {
	if (options.port?.mode !== "auto") {
		return await startServer();
	}

	while (true) {
		try {
			return await startServer();
		} catch (error) {
			if (!isAddressInUseError(error)) {
				throw error;
			}
			const currentPort = getKanbanRuntimePort();
			const retryPort = await findAvailableRuntimePort(currentPort + 1);
			setKanbanRuntimePort(retryPort);
			console.warn(`Runtime port ${currentPort} became busy during startup, retrying on ${retryPort}.`);
		}
	}
}

async function runMainCommand(options: CliOptions, shouldAutoOpenBrowser: boolean): Promise<void> {
	if (options.host) {
		setKanbanRuntimeHost(options.host);
		console.log(`Binding to host ${options.host}.`);
	}

	const [{ openInBrowser }, { autoUpdateOnStartup, runPendingAutoUpdateOnShutdown }, { default: oraFactory }] =
		await Promise.all([import("./server/browser.js"), import("./update/update.js"), import("ora")]);

	const selectedPort = await applyRuntimePortOption(options.port);
	if (selectedPort !== null) {
		console.log(`Using runtime port ${selectedPort}.`);
	}

	const tlsResult = await resolveRuntimeTls(options);
	if (tlsResult.enabled) {
		console.log(`HTTPS enabled on ${getKanbanRuntimeOrigin()}`);
	}

	// Handle passcode generation for remote mode — deferred until after TLS
	// validation so that an invalid --cert/--key fails before a passcode is
	// printed (a passcode for a server that never starts is confusing).
	if (isKanbanRemoteHost()) {
		if (options.noPasscode) {
			disablePasscode();
			console.log("Passcode authentication disabled (--no-passcode). Ensure you have your own auth layer.");
		} else {
			const passcode = generatePasscode();
			generateInternalToken();
			// NOTE: passcode is printed ONLY here and never stored in logs or env.
			console.log(`\n🔐 Remote access passcode: ${passcode}\n\nShare this with users who need access.\n`);
		}
	}

	autoUpdateOnStartup({
		currentVersion: KANBAN_VERSION,
	});

	let runtime: Awaited<ReturnType<typeof startServer>>;
	try {
		runtime = await startServerWithAutoPortRetry(options);
	} catch (error) {
		if (
			options.port?.mode !== "auto" &&
			isAddressInUseError(error) &&
			(await tryOpenExistingServer({ noOpen: options.noOpen, shouldAutoOpenBrowser }))
		) {
			return;
		}
		throw error;
	}
	console.log(`Cline Kanban running at ${runtime.url}`);
	if (!options.noOpen && shouldAutoOpenBrowser) {
		try {
			openInBrowser(runtime.url, {
				warn: (message) => {
					console.warn(message);
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Could not open browser automatically: ${message}`);
		}
	}
	console.log("Press Ctrl+C to stop.");

	let isShuttingDown = false;
	const shutdownIndicator = createShutdownIndicator(oraFactory);
	const shutdown = async () => {
		if (isShuttingDown) {
			return;
		}
		isShuttingDown = true;
		runPendingAutoUpdateOnShutdown();
		if (options.skipShutdownCleanup) {
			console.warn("Skipping shutdown task cleanup for this instance.");
		}
		await runtime.shutdown({
			skipSessionCleanup: options.skipShutdownCleanup,
		});
		await lazyDisposeCliTelemetryService().catch(() => {});
	};

	installGracefulShutdownHandlers({
		process,
		delayMs: 10000,
		exit: (code) => {
			process.exit(code);
		},
		reraiseSignal: (signal) => {
			process.kill(process.pid, signal);
		},
		onShutdown: async () => {
			shutdownIndicator.start();
			try {
				await shutdown();
				shutdownIndicator.stop("done");
			} catch (error) {
				shutdownIndicator.stop("failed");
				throw error;
			}
		},
		onShutdownError: (error) => {
			shutdownIndicator.stop("failed");
			lazyCaptureNodeException(error, { area: "shutdown" });
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Shutdown failed: ${message}`);
		},
		onTimeout: (delayMs) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit after shutdown timeout (${delayMs}ms).`);
		},
		onSecondSignal: (signal) => {
			shutdownIndicator.stop("interrupted");
			console.error(`Forced exit on second signal: ${signal}`);
		},
		suppressImmediateDuplicateSignals: shouldSuppressImmediateDuplicateShutdownSignals(),
	});
}

async function runUpdateCommand(): Promise<void> {
	// Lazy-import the update module so `kanban update` doesn't pay for it
	// being on the top-level import graph of every other subcommand.
	const { runOnDemandUpdate } = await import("./update/update.js");
	const result = await runOnDemandUpdate({
		currentVersion: KANBAN_VERSION,
	});

	if (result.status === "updated" || result.status === "already_up_to_date" || result.status === "cache_refreshed") {
		console.log(result.message);
		return;
	}

	throw new Error(result.message);
}

/**
 * Build the commander program. Heavy subcommands (`task`, `hooks`) are
 * registered conditionally based on the invocation argv to avoid loading
 * their import graphs (~2.4s combined) for the default GUI launch path.
 */
async function createProgram(invocationArgs: string[]): Promise<Command> {
	const shouldAutoOpenBrowser = shouldAutoOpenBrowserTabForInvocation(invocationArgs);
	const program = new Command();
	program
		.name("kanban")
		.description("Local orchestration board for coding agents.")
		.version(KANBAN_VERSION, "-v, --version", "Output the version number")
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortValue)
		.option("--no-open", "Do not open browser automatically.")
		.option("--skip-shutdown-cleanup", "Do not move sessions to done or delete task worktrees on shutdown.")
		.option("--https", "Enable HTTPS. Requires both --cert and --key.")
		.option("--cert <path>", "Path to a TLS certificate PEM file (implies HTTPS).")
		.option("--key <path>", "Path to a TLS private key PEM file (implies HTTPS).")
		.option("--update", "Update Kanban to the latest published version and exit.")
		.option(
			"--no-passcode",
			"Disable auto-generated passcode for remote access (for advanced users behind a reverse proxy).",
		)
		.showHelpAfterError()
		.addHelpText("after", `\nRuntime URL: ${getKanbanRuntimeOrigin()}`);

	program.addOption(new Option("--agent <id>", "Deprecated compatibility flag. Ignored.").hideHelp());

	const subcommand = detectInvokedSubcommand(invocationArgs);
	const wantsTopLevelHelp = subcommand === null && argvContainsHelpFlag(invocationArgs);
	const needsTaskCommand = subcommand === "task" || subcommand === "tasks" || wantsTopLevelHelp;
	const needsHooksCommand = subcommand === "hooks" || wantsTopLevelHelp;
	const lazyImports: Promise<void>[] = [];
	if (needsTaskCommand) {
		lazyImports.push(
			import("./commands/task.js").then(({ registerTaskCommand }) => {
				registerTaskCommand(program);
			}),
		);
	}
	if (needsHooksCommand) {
		lazyImports.push(
			import("./commands/hooks.js").then(({ registerHooksCommand }) => {
				registerHooksCommand(program);
			}),
		);
	}
	await Promise.all(lazyImports);

	program
		.command("mcp")
		.description("Deprecated compatibility command.")
		.action(() => {
			console.warn("Deprecated. Please uninstall Kanban MCP.");
		});

	program
		.command("update")
		.description("Update Kanban to the latest published version.")
		.action(async () => {
			await runUpdateCommand();
		});

	program.action(async (options: RootCommandOptions) => {
		if (options.update === true) {
			await runUpdateCommand();
			return;
		}
		await runMainCommand(
			{
				host: options.host ?? null,
				port: options.port ?? null,
				noOpen: options.open === false,
				skipShutdownCleanup: options.skipShutdownCleanup === true,
				https: options.https === true,
				cert: options.cert ?? null,
				key: options.key ?? null,
				noPasscode: options.noPasscode === true,
			},
			shouldAutoOpenBrowser,
		);
	});

	return program;
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	const program = await createProgram(argv);
	await program.parseAsync(argv, { from: "user" });
	if (!shouldAutoOpenBrowserTabForInvocation(argv)) {
		await Promise.allSettled([lazyDisposeCliTelemetryService(), lazyFlushNodeTelemetry()]);
		process.exit(process.exitCode ?? 0);
	}
}

void run().catch(async (error) => {
	lazyCaptureNodeException(error, { area: "startup" });
	await Promise.allSettled([lazyDisposeCliTelemetryService(), lazyFlushNodeTelemetry()]);
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to start Kanban: ${message}`);
	process.exit(1);
});
