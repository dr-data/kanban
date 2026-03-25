// Serializes same-baseRef commit dispatch at the runtime layer.
// The lock prevents two tasks targeting the same baseRef from running the
// managed commit workflow concurrently, which would overlap in the shared
// base worktree and corrupt git state.
//
// Locks auto-expire after a configurable stale timeout so that crashed
// frontends or abandoned dispatches do not permanently block other tasks.
// The frontend also releases explicitly on commit dispatch completion.

// Default: 90 seconds. Generous enough for the agent to finish a cherry-pick
// workflow, short enough that a crashed tab does not block indefinitely.
const DEFAULT_STALE_MS = 90_000;

export interface CommitLockEntry {
	workspaceId: string;
	baseRef: string;
	taskId: string;
	acquiredAt: number;
}

export type CommitLockAcquireResult =
	| { acquired: true }
	| { acquired: false; holder: CommitLockEntry };

export interface CommitLockCoordinator {
	acquire(workspaceId: string, baseRef: string, taskId: string): CommitLockAcquireResult;
	release(workspaceId: string, baseRef: string, taskId: string): boolean;
	isHeld(workspaceId: string, baseRef: string): CommitLockEntry | null;
	releaseAllForWorkspace(workspaceId: string): void;
}

export interface CreateCommitLockCoordinatorOptions {
	staleMs?: number;
}

export function createCommitLockCoordinator(options?: CreateCommitLockCoordinatorOptions): CommitLockCoordinator {
	const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
	const locks = new Map<string, CommitLockEntry>();

	function key(workspaceId: string, baseRef: string): string {
		return `${workspaceId}\0${baseRef}`;
	}

	function isStale(entry: CommitLockEntry): boolean {
		return Date.now() - entry.acquiredAt > staleMs;
	}

	function getIfFresh(k: string): CommitLockEntry | null {
		const entry = locks.get(k);
		if (!entry) {
			return null;
		}
		if (isStale(entry)) {
			locks.delete(k);
			return null;
		}
		return entry;
	}

	return {
		acquire(workspaceId, baseRef, taskId) {
			const k = key(workspaceId, baseRef);
			const existing = getIfFresh(k);
			if (existing && existing.taskId !== taskId) {
				return { acquired: false, holder: existing };
			}
			locks.set(k, { workspaceId, baseRef, taskId, acquiredAt: Date.now() });
			return { acquired: true };
		},

		release(workspaceId, baseRef, taskId) {
			const k = key(workspaceId, baseRef);
			const existing = locks.get(k);
			if (!existing || existing.taskId !== taskId) {
				return false;
			}
			locks.delete(k);
			return true;
		},

		isHeld(workspaceId, baseRef) {
			return getIfFresh(key(workspaceId, baseRef));
		},

		releaseAllForWorkspace(workspaceId) {
			for (const [k, entry] of locks) {
				if (entry.workspaceId === workspaceId) {
					locks.delete(k);
				}
			}
		},
	};
}
