import type { RuntimeBoardCard, RuntimeBoardData, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn, updateTask } from "../core/task-board-mutations";
import type { RuntimeWorkspaceAtomicMutationResult } from "../state/workspace-state";

const TASK_SCHEDULE_POLL_INTERVAL_MS = 5_000;

interface WorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

interface TrpcClient {
	workspace: {
		ensureWorktree: {
			mutate: (input: { taskId: string; baseRef: string }) => Promise<{ ok: boolean; error?: string | null }>;
		};
	};
	runtime: {
		startTaskSession: {
			mutate: (input: {
				taskId: string;
				prompt: string;
				startInPlanMode: boolean;
				baseRef: string;
			}) => Promise<{ ok: boolean; summary: unknown; error?: string | null }>;
		};
	};
}

export interface CreateTaskScheduleMonitorDependencies {
	listWorkspaceIndexEntries: () => Promise<WorkspaceIndexEntry[]>;
	loadWorkspaceState: (cwd: string) => Promise<RuntimeWorkspaceStateResponse>;
	mutateWorkspaceState: <T>(
		cwd: string,
		mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
	) => Promise<{ value: T; saved: boolean }>;
	createTrpcClient: (workspaceId: string) => TrpcClient;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
	warn: (message: string) => void;
}

export interface TaskScheduleMonitor {
	close: () => void;
}

/** Finds a card in the backlog column, returning null if not found. */
function findBacklogCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	if (getTaskColumnId(board, taskId) !== "backlog") {
		return null;
	}
	const backlog = board.columns.find((col) => col.id === "backlog");
	return backlog?.cards.find((card) => card.id === taskId) ?? null;
}

/**
 * Builds an updateTask input that preserves all existing card fields while
 * overriding the specified schedule fields.
 */
function buildScheduleClearInput(
	card: RuntimeBoardCard,
	overrides: { scheduledStartAt?: number | null; scheduledEndAt?: number | null },
) {
	return {
		prompt: card.prompt,
		startInPlanMode: card.startInPlanMode,
		autoReviewEnabled: card.autoReviewEnabled,
		autoReviewMode: card.autoReviewMode,
		images: card.images,
		baseRef: card.baseRef,
		recurringEnabled: card.recurringEnabled,
		recurringMaxIterations: card.recurringMaxIterations,
		recurringPeriodMs: card.recurringPeriodMs,
		recurringCurrentIteration: card.recurringCurrentIteration,
		...overrides,
	};
}

/**
 * Server-side monitor that polls all workspaces on a fixed interval and
 * auto-starts backlog tasks whose `scheduledStartAt` timestamp has arrived.
 * Tasks whose `scheduledEndAt` has passed are expired instead of started.
 *
 * Uses atomic `mutateWorkspaceState` to claim tasks, preventing double-starts
 * with the web-UI's `useScheduleTimers` hook.
 */
export function createTaskScheduleMonitor(deps: CreateTaskScheduleMonitorDependencies): TaskScheduleMonitor {
	let refreshPromise: Promise<void> | null = null;

	/** Broadcasts state changes to connected web-UI clients. */
	const broadcastWorkspaceUpdate = async (workspace: WorkspaceIndexEntry): Promise<void> => {
		await deps.broadcastRuntimeWorkspaceStateUpdated(workspace.workspaceId, workspace.repoPath).catch(() => null);
		await deps.broadcastRuntimeProjectsUpdated(workspace.workspaceId).catch(() => null);
	};

	/** Expires a task whose `scheduledEndAt` has passed by clearing both schedule fields. */
	const expireScheduledTask = async (
		workspace: WorkspaceIndexEntry,
		taskSnapshot: RuntimeBoardCard,
	): Promise<void> => {
		const mutation = await deps.mutateWorkspaceState(workspace.repoPath, (state) => {
			const card = findBacklogCard(state.board, taskSnapshot.id);
			if (!card || card.scheduledStartAt == null) {
				return { board: state.board, value: false, save: false };
			}
			const updated = updateTask(
				state.board,
				taskSnapshot.id,
				buildScheduleClearInput(card, {
					scheduledStartAt: null,
					scheduledEndAt: null,
				}),
			);
			return { board: updated.updated ? updated.board : state.board, value: updated.updated };
		});
		if (mutation.saved) {
			deps.warn(`[kanban] Schedule monitor: expired past-due task ${taskSnapshot.id}`);
			await broadcastWorkspaceUpdate(workspace);
		}
	};

	/**
	 * Claims and starts a scheduled task. Atomically clears `scheduledStartAt`,
	 * then ensures the worktree, starts the agent session, and moves to in_progress.
	 */
	const startScheduledTask = async (workspace: WorkspaceIndexEntry, taskSnapshot: RuntimeBoardCard): Promise<void> => {
		/* Atomically claim the task by clearing scheduledStartAt under file lock. */
		const claim = await deps.mutateWorkspaceState<{ claimed: boolean; card: RuntimeBoardCard | null }>(
			workspace.repoPath,
			(state) => {
				const card = findBacklogCard(state.board, taskSnapshot.id);
				if (!card || card.scheduledStartAt == null) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}
				const updated = updateTask(
					state.board,
					taskSnapshot.id,
					buildScheduleClearInput(card, {
						scheduledStartAt: null,
					}),
				);
				if (!updated.updated) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}
				return { board: updated.board, value: { claimed: true, card } };
			},
		);

		if (!claim.value.claimed || !claim.value.card) {
			return;
		}

		const claimedCard = claim.value.card;
		const client = deps.createTrpcClient(workspace.workspaceId);

		const ensured = await client.workspace.ensureWorktree.mutate({
			taskId: claimedCard.id,
			baseRef: claimedCard.baseRef,
		});
		if (!ensured.ok) {
			deps.warn(
				`[kanban] Schedule monitor: worktree setup failed for task ${claimedCard.id}: ${ensured.error ?? "unknown"}`,
			);
			return;
		}

		const started = await client.runtime.startTaskSession.mutate({
			taskId: claimedCard.id,
			prompt: claimedCard.prompt,
			startInPlanMode: claimedCard.startInPlanMode,
			baseRef: claimedCard.baseRef,
		});
		if (!started.ok) {
			deps.warn(
				`[kanban] Schedule monitor: session start failed for task ${claimedCard.id}: ${started.error ?? "unknown"}`,
			);
			return;
		}

		/* Move to in_progress. */
		await deps.mutateWorkspaceState(workspace.repoPath, (state) => {
			const movement = moveTaskToColumn(state.board, claimedCard.id, "in_progress");
			return { board: movement.moved ? movement.board : state.board, value: movement.moved };
		});

		await broadcastWorkspaceUpdate(workspace);
	};

	/** Processes a single scheduled task — either expires it or starts it. */
	const processScheduledTask = async (
		workspace: WorkspaceIndexEntry,
		task: RuntimeBoardCard,
		now: number,
	): Promise<void> => {
		if (task.scheduledEndAt != null && task.scheduledEndAt < now) {
			await expireScheduledTask(workspace, task);
			return;
		}
		await startScheduledTask(workspace, task);
	};

	/** Scans all workspaces for backlog tasks whose scheduled time has arrived. */
	const doTick = async (): Promise<void> => {
		const workspaces = await deps.listWorkspaceIndexEntries().catch(() => [] as WorkspaceIndexEntry[]);
		const now = Date.now();

		for (const workspace of workspaces) {
			try {
				const state = await deps.loadWorkspaceState(workspace.repoPath);
				const backlog = state.board.columns.find((col) => col.id === "backlog");
				if (!backlog) {
					continue;
				}

				const dueTasks = backlog.cards.filter(
					(card) => card.scheduledStartAt != null && card.scheduledStartAt <= now,
				);

				for (const task of dueTasks) {
					try {
						await processScheduledTask(workspace, task, now);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						deps.warn(`[kanban] Schedule monitor: failed to process task ${task.id}: ${message}`);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				deps.warn(`[kanban] Schedule monitor: failed to scan workspace ${workspace.workspaceId}: ${message}`);
			}
		}
	};

	/** Guard that prevents overlapping ticks. */
	const tick = (): void => {
		if (refreshPromise) {
			return;
		}
		refreshPromise = doTick().finally(() => {
			refreshPromise = null;
		});
	};

	/* Run immediately to catch past-due tasks, then poll on interval. */
	tick();
	const pollTimer = setInterval(tick, TASK_SCHEDULE_POLL_INTERVAL_MS);
	pollTimer.unref();

	return {
		close: () => {
			clearInterval(pollTimer);
		},
	};
}
