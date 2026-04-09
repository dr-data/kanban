import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	addTaskDependency,
	getLinkedBacklogTaskIdsBlockedByTrashTask,
	getTaskColumnId,
	moveTaskToColumn,
	shouldTaskRecur,
	updateTask,
} from "../core/task-board-mutations";
import type { RuntimeWorkspaceAtomicMutationResult } from "../state/workspace-state";

const TASK_RECURRING_POLL_INTERVAL_MS = 5_000;
const MINIMUM_RECURRING_PERIOD_MS = 180_000;
/** Grace period before moving orphaned in_progress cards with no session. */
const ORPHAN_GRACE_PERIOD_MS = 60_000;

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
		recurringLinkedTaskIds: card.recurringLinkedTaskIds,
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

		/* Restore recurring dependencies from the card's durable linked task IDs.
		   This is necessary because updateTaskDependencies may have pruned the
		   board.dependencies entry during a previous iteration when both tasks
		   were outside backlog. */
		const linkedIds = claimedCard.recurringLinkedTaskIds ?? [];
		if (linkedIds.length > 0) {
			await deps.mutateWorkspaceState(workspace.repoPath, (state) => {
				let nextBoard = state.board;
				for (const linkedId of linkedIds) {
					const result = addTaskDependency(nextBoard, claimedCard.id, linkedId);
					if (result.added) {
						nextBoard = result.board;
						deps.warn(`[kanban] Recurring monitor: restored dependency ${claimedCard.id} <-> ${linkedId}`);
					}
				}
				if (nextBoard === state.board) {
					return { board: state.board, value: false, save: false };
				}
				return { board: nextBoard, value: true };
			});
		}

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

	/**
	 * Detects tasks stuck in in_progress whose session has already finished.
	 * Returns a list of moves that the server should perform. This closes the
	 * gap where the frontend auto-move logic was not running (browser closed,
	 * missed state transition, React batching race).
	 */
	const sweepStuckInProgressTasks = (
		state: RuntimeWorkspaceStateResponse,
	): Array<{ taskId: string; fromColumn: RuntimeBoardColumnId; targetColumn: "review" | "trash" }> => {
		const inProgress = state.board.columns.find((col) => col.id === "in_progress");
		if (!inProgress) {
			return [];
		}
		const moves: Array<{ taskId: string; fromColumn: RuntimeBoardColumnId; targetColumn: "review" | "trash" }> = [];
		const now = Date.now();

		for (const card of inProgress.cards) {
			const session = state.sessions[card.id];
			if (!session) {
				/* No session at all — orphaned card. Wait for the grace period. */
				if (now - card.updatedAt > ORPHAN_GRACE_PERIOD_MS) {
					moves.push({ taskId: card.id, fromColumn: "in_progress", targetColumn: "trash" });
				}
				continue;
			}
			if (session.state === "awaiting_review") {
				/* Mirror the frontend auto-trash logic: clean exit + no auto-review → trash. */
				const shouldAutoTrash = session.reviewReason === "exit" && card.autoReviewEnabled !== true;
				moves.push({
					taskId: card.id,
					fromColumn: "in_progress",
					targetColumn: shouldAutoTrash ? "trash" : "review",
				});
			} else if (session.state === "interrupted" || session.state === "failed") {
				moves.push({ taskId: card.id, fromColumn: "in_progress", targetColumn: "trash" });
			}
			/* state === "running" or "idle" → leave alone, task is active or starting. */
		}
		return moves;
	};

	/**
	 * Detects recurring tasks stuck in review that should have gone straight to
	 * trash. Non-recurring tasks are left alone — the user wants to inspect them.
	 */
	const sweepStuckReviewTasks = (
		state: RuntimeWorkspaceStateResponse,
	): Array<{ taskId: string; fromColumn: RuntimeBoardColumnId; targetColumn: "trash" }> => {
		const review = state.board.columns.find((col) => col.id === "review");
		if (!review) {
			return [];
		}
		const moves: Array<{ taskId: string; fromColumn: RuntimeBoardColumnId; targetColumn: "trash" }> = [];

		for (const card of review.cards) {
			/* Only auto-move recurring tasks that don't have auto-review enabled.
			   Tasks with auto-review wait for the frontend's commit/PR automation. */
			if (card.recurringEnabled === true && card.autoReviewEnabled !== true) {
				moves.push({ taskId: card.id, fromColumn: "review", targetColumn: "trash" });
			}
		}
		return moves;
	};

	/**
	 * Atomically moves a task from one column to another if it's still in the
	 * expected source column. When moving to trash, also captures any linked
	 * backlog tasks that were blocked by this task so they can be started
	 * immediately (without waiting for the recurring period). Returns the list
	 * of linked task IDs that became ready, or null if the move didn't happen.
	 */
	const moveStuckTask = async (
		workspace: WorkspaceIndexEntry,
		taskId: string,
		expectedFrom: RuntimeBoardColumnId,
		target: RuntimeBoardColumnId,
	): Promise<{ moved: boolean; readyLinkedTaskIds: string[] }> => {
		const result = await deps.mutateWorkspaceState<{ moved: boolean; readyLinkedTaskIds: string[] }>(
			workspace.repoPath,
			(state) => {
				if (getTaskColumnId(state.board, taskId) !== expectedFrom) {
					return { board: state.board, value: { moved: false, readyLinkedTaskIds: [] }, save: false };
				}
				const movement = moveTaskToColumn(state.board, taskId, target);
				if (!movement.moved) {
					return { board: state.board, value: { moved: false, readyLinkedTaskIds: [] }, save: false };
				}
				/* When moving to trash, find linked backlog tasks that can now start.
				   Compute this against the post-move board so the task is actually in trash. */
				const readyLinkedTaskIds =
					target === "trash" ? getLinkedBacklogTaskIdsBlockedByTrashTask(movement.board, taskId) : [];
				return { board: movement.board, value: { moved: true, readyLinkedTaskIds } };
			},
		);
		return result.value;
	};

	/** Scans all workspaces for stuck tasks and recurring tasks in trash whose recurrence period has elapsed. */
	const doTick = async (): Promise<void> => {
		const workspaces = await deps.listWorkspaceIndexEntries().catch(() => [] as WorkspaceIndexEntry[]);

		for (const workspace of workspaces) {
			try {
				const state = await deps.loadWorkspaceState(workspace.repoPath);

				/* Phase 1: Lifecycle sweep — move stuck tasks to the right column.
				   This must run before the recurring restart phase so tasks that move
				   from review → trash become immediately eligible for restart. */
				const stuckMoves = [...sweepStuckInProgressTasks(state), ...sweepStuckReviewTasks(state)];
				const aggregatedReadyTaskIds = new Set<string>();
				for (const { taskId, fromColumn, targetColumn } of stuckMoves) {
					try {
						const { moved, readyLinkedTaskIds } = await moveStuckTask(
							workspace,
							taskId,
							fromColumn,
							targetColumn,
						);
						if (moved) {
							deps.warn(`[kanban] Lifecycle sweep: moved task ${taskId} from ${fromColumn} to ${targetColumn}`);
							await broadcastWorkspaceUpdate(workspace);
							for (const readyId of readyLinkedTaskIds) {
								aggregatedReadyTaskIds.add(readyId);
							}
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						deps.warn(`[kanban] Lifecycle sweep: failed to move task ${taskId}: ${message}`);
					}
				}

				/* Start linked backlog tasks that became ready during the sweep.
				   This unblocks Task B immediately when Task A (its dependency) hits
				   trash, instead of waiting for the recurring period to elapse. */
				if (aggregatedReadyTaskIds.size > 0) {
					await startLinkedBacklogTasks(workspace, Array.from(aggregatedReadyTaskIds));
				}

				/* Additional pass: find backlog tasks that are blocked by trash tasks
				   and are ready to start. This handles tasks that entered trash via a
				   path other than the lifecycle sweep (e.g., direct user action, or
				   tasks that were already in trash when the server restarted). The
				   operation is idempotent — started tasks will have moved out of
				   backlog and won't be picked up again. */
				const freshStateForLinked = await deps.loadWorkspaceState(workspace.repoPath);
				const trashForLinkedScan = freshStateForLinked.board.columns.find((col) => col.id === "trash");
				if (trashForLinkedScan) {
					const additionalReadyIds = new Set<string>();
					for (const trashedCard of trashForLinkedScan.cards) {
						const readyIds = getLinkedBacklogTaskIdsBlockedByTrashTask(freshStateForLinked.board, trashedCard.id);
						for (const readyId of readyIds) {
							additionalReadyIds.add(readyId);
						}
					}
					if (additionalReadyIds.size > 0) {
						await startLinkedBacklogTasks(workspace, Array.from(additionalReadyIds));
					}
				}

				/* Phase 2: Recurring restart — restart eligible tasks in trash.
				   Re-load state since the sweep phase may have moved tasks into trash. */
				const freshState = stuckMoves.length > 0 ? await deps.loadWorkspaceState(workspace.repoPath) : state;
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
