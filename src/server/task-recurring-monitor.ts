import type { RuntimeBoardCard, RuntimeBoardData, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn, shouldTaskRecur, updateTask } from "../core/task-board-mutations";
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

/** Finds a card in the review column, returning null if not found. */
function findReviewCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	if (getTaskColumnId(board, taskId) !== "review") {
		return null;
	}
	const review = board.columns.find((col) => col.id === "review");
	return review?.cards.find((card) => card.id === taskId) ?? null;
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
 * Scans both the review and trash columns:
 * - Review: recurring tasks are moved to trash automatically so the
 *   lifecycle continues even when auto-review is disabled or the browser
 *   tab is closed.
 * - Trash: eligible tasks are claimed and restarted.
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
	 * and starts a new agent session.
	 */
	const restartRecurringTask = async (
		workspace: WorkspaceIndexEntry,
		taskSnapshot: RuntimeBoardCard,
	): Promise<void> => {
		/* Atomically claim the task by incrementing recurringCurrentIteration and moving to backlog. */
		const claim = await deps.mutateWorkspaceState<{ claimed: boolean; card: RuntimeBoardCard | null }>(
			workspace.repoPath,
			(state) => {
				const card = findTrashCard(state.board, taskSnapshot.id);
				if (!card || !shouldTaskRecur(card)) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}

				/* Check if scheduledEndAt has passed — if so, do not recur. */
				if (card.scheduledEndAt != null && card.scheduledEndAt < Date.now()) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}

				/* Re-check the delay under the lock to avoid races. */
				const remaining = computeRemainingRecurringDelay(card);
				if (remaining > 0) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}

				const nextIteration = (card.recurringCurrentIteration ?? 0) + 1;
				const updated = updateTask(
					state.board,
					taskSnapshot.id,
					buildRecurringUpdateInput(card, {
						recurringCurrentIteration: nextIteration,
					}),
				);
				if (!updated.updated) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}

				/* Move from trash to backlog. */
				const movement = moveTaskToColumn(updated.board, taskSnapshot.id, "backlog");
				if (!movement.moved) {
					return { board: state.board, value: { claimed: false, card: null }, save: false };
				}

				return { board: movement.board, value: { claimed: true, card } };
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
	};

	/**
	 * Moves a recurring task from the review column to trash so the restart
	 * logic can pick it up. This handles the case where auto-review is disabled
	 * or the browser is closed — the server ensures the lifecycle continues.
	 */
	const moveReviewTaskToTrash = async (
		workspace: WorkspaceIndexEntry,
		taskSnapshot: RuntimeBoardCard,
	): Promise<boolean> => {
		const result = await deps.mutateWorkspaceState<boolean>(workspace.repoPath, (state) => {
			const card = findReviewCard(state.board, taskSnapshot.id);
			if (!card || !shouldTaskRecur(card)) {
				return { board: state.board, value: false, save: false };
			}
			const movement = moveTaskToColumn(state.board, taskSnapshot.id, "trash");
			if (!movement.moved) {
				return { board: state.board, value: false, save: false };
			}
			return { board: movement.board, value: true };
		});

		if (result.value) {
			await broadcastWorkspaceUpdate(workspace);
		}
		return result.value;
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

	/** Scans all workspaces for recurring tasks in review or trash whose recurrence period has elapsed. */
	const doTick = async (): Promise<void> => {
		const workspaces = await deps.listWorkspaceIndexEntries().catch(() => [] as WorkspaceIndexEntry[]);

		for (const workspace of workspaces) {
			try {
				const state = await deps.loadWorkspaceState(workspace.repoPath);

				/* Move recurring tasks stuck in review to trash so the restart
				   logic below can pick them up. This handles the case where
				   auto-review is disabled or the browser tab is closed. */
				const review = state.board.columns.find((col) => col.id === "review");
				if (review) {
					const reviewRecurring = review.cards.filter(
						(card) => card.recurringEnabled === true && shouldTaskRecur(card),
					);
					for (const task of reviewRecurring) {
						try {
							await moveReviewTaskToTrash(workspace, task);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							deps.warn(
								`[kanban] Recurring monitor: failed to move review task ${task.id} to trash: ${message}`,
							);
						}
					}
				}

				/* Re-load state after potential review->trash moves above. */
				const freshState = review ? await deps.loadWorkspaceState(workspace.repoPath) : state;
				const trash = freshState.board.columns.find((col) => col.id === "trash");
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
