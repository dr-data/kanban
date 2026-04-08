import type { RuntimeBoardCard, RuntimeBoardData, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import {
	getLinkedBacklogTaskIdsBlockedByTrashTask,
	getTaskColumnId,
	moveTaskToColumn,
	shouldTaskRecur,
	updateTask,
} from "../core/task-board-mutations";
import type { RuntimeWorkspaceAtomicMutationResult } from "../state/workspace-state";

const TASK_RECURRING_POLL_INTERVAL_MS = 5_000;
const MINIMUM_RECURRING_PERIOD_MS = 180_000;

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

export interface CreateTaskRecurringMonitorDependencies {
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

export interface TaskRecurringMonitor {
	close: () => void;
}

/** Finds a card in the trash column, returning null if not found. */
function findTrashCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	if (getTaskColumnId(board, taskId) !== "trash") {
		return null;
	}
	const trash = board.columns.find((col) => col.id === "trash");
	return trash?.cards.find((card) => card.id === taskId) ?? null;
}

/**
 * Builds an updateTask input that preserves all existing card fields while
 * overriding the specified recurring fields.
 */
function buildRecurringUpdateInput(card: RuntimeBoardCard, overrides: { recurringCurrentIteration?: number }) {
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
		recurringCurrentIteration: overrides.recurringCurrentIteration ?? card.recurringCurrentIteration,
		scheduledStartAt: card.scheduledStartAt,
		scheduledEndAt: card.scheduledEndAt,
	};
}

/**
 * Computes the remaining delay before a recurring task is ready to restart.
 * Returns 0 or negative when the task is ready now. Returns a positive value
 * when the task needs more time before recycling.
 */
function computeRemainingRecurringDelay(card: RuntimeBoardCard): number {
	const period = Math.max(card.recurringPeriodMs ?? MINIMUM_RECURRING_PERIOD_MS, MINIMUM_RECURRING_PERIOD_MS);
	const elapsed = Date.now() - card.updatedAt;
	return period - elapsed;
}

/**
 * Server-side monitor that polls all workspaces on a fixed interval and
 * auto-restarts recurring tasks whose recurrence period has elapsed.
 *
 * Only scans the trash column — recurring tasks restart after they are
 * fully done (moved to trash by auto-review, manual user action, or
 * session stop). Tasks in review are left alone so the user can inspect
 * results without the task being snatched away for the next iteration.
 *
 * For each eligible task in trash:
 * 1. Checks `shouldTaskRecur()` and that `scheduledEndAt` has not passed.
 * 2. Waits until at least `recurringPeriodMs` (minimum 180s) has elapsed
 *    since the task's `updatedAt` timestamp.
 * 3. Atomically claims the task via `mutateWorkspaceState` (increments
 *    `recurringCurrentIteration` and moves it to backlog), then starts
 *    a new agent session via tRPC.
 *
 * Uses the same atomic claim pattern as the schedule monitor to prevent
 * double-starts with the web-UI.
 */
export function createTaskRecurringMonitor(deps: CreateTaskRecurringMonitorDependencies): TaskRecurringMonitor {
	let refreshPromise: Promise<void> | null = null;

	/** Broadcasts state changes to connected web-UI clients. */
	const broadcastWorkspaceUpdate = async (workspace: WorkspaceIndexEntry): Promise<void> => {
		await deps.broadcastRuntimeWorkspaceStateUpdated(workspace.workspaceId, workspace.repoPath).catch(() => null);
		await deps.broadcastRuntimeProjectsUpdated(workspace.workspaceId).catch(() => null);
	};

	/**
	 * Claims and restarts a recurring task. Atomically increments the iteration
	 * counter and moves the task from trash to backlog, then ensures the worktree
	 * and starts a new agent session. Also resolves dependency links: any backlog
	 * tasks that were blocked by this recurring task (while it sat in trash) are
	 * started as well.
	 */
	const restartRecurringTask = async (
		workspace: WorkspaceIndexEntry,
		taskSnapshot: RuntimeBoardCard,
	): Promise<void> => {
		/* Atomically claim the task by incrementing recurringCurrentIteration and moving to backlog.
		   Also capture linked backlog task IDs that were blocked by this task while it was in trash. */
		const claim = await deps.mutateWorkspaceState<{
			claimed: boolean;
			card: RuntimeBoardCard | null;
			readyLinkedTaskIds: string[];
		}>(workspace.repoPath, (state) => {
			const card = findTrashCard(state.board, taskSnapshot.id);
			if (!card || !shouldTaskRecur(card)) {
				return { board: state.board, value: { claimed: false, card: null, readyLinkedTaskIds: [] }, save: false };
			}

			/* Check if scheduledEndAt has passed — if so, do not recur. */
			if (card.scheduledEndAt != null && card.scheduledEndAt < Date.now()) {
				return { board: state.board, value: { claimed: false, card: null, readyLinkedTaskIds: [] }, save: false };
			}

			/* Re-check the delay under the lock to avoid races. */
			const remaining = computeRemainingRecurringDelay(card);
			if (remaining > 0) {
				return { board: state.board, value: { claimed: false, card: null, readyLinkedTaskIds: [] }, save: false };
			}

			/* Snapshot linked backlog tasks before moving the recurring task out of trash. */
			const readyLinkedTaskIds = getLinkedBacklogTaskIdsBlockedByTrashTask(state.board, taskSnapshot.id);

			const nextIteration = (card.recurringCurrentIteration ?? 0) + 1;
			const updated = updateTask(
				state.board,
				taskSnapshot.id,
				buildRecurringUpdateInput(card, {
					recurringCurrentIteration: nextIteration,
				}),
			);
			if (!updated.updated) {
				return { board: state.board, value: { claimed: false, card: null, readyLinkedTaskIds: [] }, save: false };
			}

			/* Move from trash to backlog. */
			const movement = moveTaskToColumn(updated.board, taskSnapshot.id, "backlog");
			if (!movement.moved) {
				return { board: state.board, value: { claimed: false, card: null, readyLinkedTaskIds: [] }, save: false };
			}

			return { board: movement.board, value: { claimed: true, card, readyLinkedTaskIds } };
		});

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
				`[kanban] Recurring monitor: worktree setup failed for task ${claimedCard.id}: ${ensured.error ?? "unknown"}`,
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
				`[kanban] Recurring monitor: session start failed for task ${claimedCard.id}: ${started.error ?? "unknown"}`,
			);
			return;
		}

		/* Move to in_progress. */
		await deps.mutateWorkspaceState(workspace.repoPath, (state) => {
			const movement = moveTaskToColumn(state.board, claimedCard.id, "in_progress");
			return { board: movement.moved ? movement.board : state.board, value: movement.moved };
		});

		await broadcastWorkspaceUpdate(workspace);

		/* Start any linked backlog tasks whose blocking dependency (this recurring task) just completed. */
		await startLinkedBacklogTasks(workspace, claim.value.readyLinkedTaskIds);
	};

	/**
	 * Starts linked backlog tasks that became ready because their blocking
	 * dependency completed. For each task: ensures the worktree, starts an
	 * agent session, and moves the task to in_progress.
	 */
	const startLinkedBacklogTasks = async (workspace: WorkspaceIndexEntry, readyTaskIds: string[]): Promise<void> => {
		if (readyTaskIds.length === 0) {
			return;
		}

		const client = deps.createTrpcClient(workspace.workspaceId);

		for (const readyTaskId of readyTaskIds) {
			try {
				/* Re-load state to verify the task is still in backlog. */
				const freshState = await deps.loadWorkspaceState(workspace.repoPath);
				if (getTaskColumnId(freshState.board, readyTaskId) !== "backlog") {
					continue;
				}

				const backlog = freshState.board.columns.find((col) => col.id === "backlog");
				const readyCard = backlog?.cards.find((card) => card.id === readyTaskId);
				if (!readyCard) {
					continue;
				}

				const ensured = await client.workspace.ensureWorktree.mutate({
					taskId: readyTaskId,
					baseRef: readyCard.baseRef,
				});
				if (!ensured.ok) {
					deps.warn(
						`[kanban] Recurring monitor: worktree setup failed for linked task ${readyTaskId}: ${ensured.error ?? "unknown"}`,
					);
					continue;
				}

				const started = await client.runtime.startTaskSession.mutate({
					taskId: readyTaskId,
					prompt: readyCard.prompt,
					startInPlanMode: readyCard.startInPlanMode,
					baseRef: readyCard.baseRef,
				});
				if (!started.ok) {
					deps.warn(
						`[kanban] Recurring monitor: session start failed for linked task ${readyTaskId}: ${started.error ?? "unknown"}`,
					);
					continue;
				}

				await deps.mutateWorkspaceState(workspace.repoPath, (state) => {
					const movement = moveTaskToColumn(state.board, readyTaskId, "in_progress");
					return { board: movement.moved ? movement.board : state.board, value: movement.moved };
				});

				await broadcastWorkspaceUpdate(workspace);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				deps.warn(`[kanban] Recurring monitor: failed to start linked task ${readyTaskId}: ${message}`);
			}
		}
	};

	/** Processes a single recurring task — restarts it if the delay has elapsed. */
	const processRecurringTask = async (workspace: WorkspaceIndexEntry, task: RuntimeBoardCard): Promise<void> => {
		/* Skip tasks past their scheduledEndAt. */
		if (task.scheduledEndAt != null && task.scheduledEndAt < Date.now()) {
			return;
		}

		/* Skip tasks whose recurring period has not yet elapsed. */
		const remaining = computeRemainingRecurringDelay(task);
		if (remaining > 0) {
			return;
		}

		await restartRecurringTask(workspace, task);
	};

	/** Scans all workspaces for recurring tasks in trash whose recurrence period has elapsed. */
	const doTick = async (): Promise<void> => {
		const workspaces = await deps.listWorkspaceIndexEntries().catch(() => [] as WorkspaceIndexEntry[]);

		for (const workspace of workspaces) {
			try {
				const state = await deps.loadWorkspaceState(workspace.repoPath);
				const trash = state.board.columns.find((col) => col.id === "trash");
				if (!trash) {
					continue;
				}

				const recurringTasks = trash.cards.filter(
					(card) => card.recurringEnabled === true && shouldTaskRecur(card),
				);

				for (const task of recurringTasks) {
					try {
						await processRecurringTask(workspace, task);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						deps.warn(`[kanban] Recurring monitor: failed to process task ${task.id}: ${message}`);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				deps.warn(`[kanban] Recurring monitor: failed to scan workspace ${workspace.workspaceId}: ${message}`);
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

	/* Run immediately to catch eligible tasks, then poll on interval. */
	tick();
	const pollTimer = setInterval(tick, TASK_RECURRING_POLL_INTERVAL_MS);
	pollTimer.unref();

	return {
		close: () => {
			clearInterval(pollTimer);
		},
	};
}
