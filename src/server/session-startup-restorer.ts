import type { RuntimeBoardCard, RuntimeBoardData, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import type { RuntimeWorkspaceAtomicMutationResult } from "../state/workspace-state";

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
				resumeFromTrash?: boolean;
			}) => Promise<{ ok: boolean; summary: unknown; error?: string | null }>;
		};
	};
}

export interface RestoreInterruptedSessionsDependencies {
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

/** Delay helper that resolves after the given number of milliseconds. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds cards in the trash column whose associated session was interrupted by
 * the shutdown coordinator (`state === "interrupted"` and
 * `reviewReason === "interrupted"`). Returns the matching cards.
 */
function findInterruptedTrashCards(
	board: RuntimeBoardData,
	sessions: Record<string, { state: string; reviewReason: string | null }>,
): RuntimeBoardCard[] {
	const trashColumn = board.columns.find((col) => col.id === "trash");
	if (!trashColumn) {
		return [];
	}
	return trashColumn.cards.filter((card) => {
		const session = sessions[card.id];
		return session?.state === "interrupted" && session?.reviewReason === "interrupted";
	});
}

/**
 * Restores a single interrupted task: moves it from trash to in_progress,
 * resets its session state, ensures the worktree, and starts the agent session.
 */
async function restoreSingleTask(
	deps: RestoreInterruptedSessionsDependencies,
	workspace: WorkspaceIndexEntry,
	card: RuntimeBoardCard,
): Promise<void> {
	deps.warn(`Restoring interrupted session: ${card.id}`);

	/* Verify the card is still in trash and atomically move it to in_progress. */
	const mutation = await deps.mutateWorkspaceState(workspace.repoPath, (state) => {
		if (getTaskColumnId(state.board, card.id) !== "trash") {
			return { board: state.board, value: false, save: false };
		}
		const session = state.sessions[card.id];
		if (!session || session.state !== "interrupted" || session.reviewReason !== "interrupted") {
			return { board: state.board, value: false, save: false };
		}
		const movement = moveTaskToColumn(state.board, card.id, "in_progress");
		if (!movement.moved) {
			return { board: state.board, value: false, save: false };
		}
		/* Update the session to running and clear the review reason. */
		const updatedSessions = {
			...state.sessions,
			[card.id]: {
				...session,
				state: "running" as const,
				reviewReason: null,
			},
		};
		return { board: movement.board, sessions: updatedSessions, value: true };
	});

	if (!mutation.saved) {
		return;
	}

	const client = deps.createTrpcClient(workspace.workspaceId);

	const ensured = await client.workspace.ensureWorktree.mutate({
		taskId: card.id,
		baseRef: card.baseRef,
	});
	if (!ensured.ok) {
		deps.warn(`[kanban] Session restorer: worktree setup failed for task ${card.id}: ${ensured.error ?? "unknown"}`);
		return;
	}

	const started = await client.runtime.startTaskSession.mutate({
		taskId: card.id,
		prompt: "",
		startInPlanMode: card.startInPlanMode,
		baseRef: card.baseRef,
		resumeFromTrash: true,
	});
	if (!started.ok) {
		deps.warn(`[kanban] Session restorer: session start failed for task ${card.id}: ${started.error ?? "unknown"}`);
		return;
	}

	await deps.broadcastRuntimeWorkspaceStateUpdated(workspace.workspaceId, workspace.repoPath).catch(() => null);
}

/**
 * Scans all workspaces for tasks that were interrupted by the shutdown
 * coordinator and automatically restores them.
 *
 * The shutdown coordinator moves running tasks to trash with
 * `state: "interrupted"` and `reviewReason: "interrupted"`. This function
 * runs once on startup to find those tasks, move them back to in_progress,
 * and restart their agent sessions.
 *
 * Tasks are restored sequentially with a 500ms delay between each to avoid
 * overwhelming the system. Errors are handled per-task so one failure does
 * not block others.
 */
export async function restoreInterruptedSessions(deps: RestoreInterruptedSessionsDependencies): Promise<void> {
	const workspaces = await deps.listWorkspaceIndexEntries().catch(() => [] as WorkspaceIndexEntry[]);

	for (const workspace of workspaces) {
		try {
			const state = await deps.loadWorkspaceState(workspace.repoPath);
			const interruptedCards = findInterruptedTrashCards(state.board, state.sessions);

			for (let i = 0; i < interruptedCards.length; i++) {
				const card = interruptedCards[i];
				if (!card) {
					continue;
				}
				try {
					await restoreSingleTask(deps, workspace, card);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					deps.warn(`[kanban] Session restorer: failed to restore task ${card.id}: ${message}`);
				}
				/* Wait 500ms between restarts to avoid overwhelming the system. */
				if (i < interruptedCards.length - 1) {
					await delay(500);
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			deps.warn(`[kanban] Session restorer: failed to scan workspace ${workspace.workspaceId}: ${message}`);
		}
	}

	/* Broadcast projects updated after all workspaces have been processed. */
	await deps.broadcastRuntimeProjectsUpdated(null).catch(() => null);
}
