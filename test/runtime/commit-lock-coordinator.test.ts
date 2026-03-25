import { describe, expect, it } from "vitest";

import { createCommitLockCoordinator } from "../../src/core/commit-lock-coordinator.js";

describe("CommitLockCoordinator", () => {
	it("acquires and releases a lock", () => {
		const coordinator = createCommitLockCoordinator();
		const result = coordinator.acquire("ws-1", "main", "task-a");
		expect(result).toEqual({ acquired: true });
		expect(coordinator.isHeld("ws-1", "main")).toMatchObject({ taskId: "task-a" });
		expect(coordinator.release("ws-1", "main", "task-a")).toBe(true);
		expect(coordinator.isHeld("ws-1", "main")).toBeNull();
	});

	it("allows idempotent re-acquire by the same task", () => {
		const coordinator = createCommitLockCoordinator();
		expect(coordinator.acquire("ws-1", "main", "task-a")).toEqual({ acquired: true });
		expect(coordinator.acquire("ws-1", "main", "task-a")).toEqual({ acquired: true });
		expect(coordinator.isHeld("ws-1", "main")).toMatchObject({ taskId: "task-a" });
	});

	it("blocks a different task on the same baseRef", () => {
		const coordinator = createCommitLockCoordinator();
		coordinator.acquire("ws-1", "main", "task-a");
		const result = coordinator.acquire("ws-1", "main", "task-b");
		expect(result.acquired).toBe(false);
		if (!result.acquired) {
			expect(result.holder.taskId).toBe("task-a");
			expect(result.holder.baseRef).toBe("main");
		}
	});

	it("returns false when releasing a lock not held by the caller", () => {
		const coordinator = createCommitLockCoordinator();
		coordinator.acquire("ws-1", "main", "task-a");
		expect(coordinator.release("ws-1", "main", "task-b")).toBe(false);
		expect(coordinator.isHeld("ws-1", "main")).toMatchObject({ taskId: "task-a" });
	});

	it("returns false when releasing a lock that does not exist", () => {
		const coordinator = createCommitLockCoordinator();
		expect(coordinator.release("ws-1", "main", "task-a")).toBe(false);
	});

	it("allows concurrent locks on different baseRef values", () => {
		const coordinator = createCommitLockCoordinator();
		expect(coordinator.acquire("ws-1", "main", "task-a")).toEqual({ acquired: true });
		expect(coordinator.acquire("ws-1", "develop", "task-b")).toEqual({ acquired: true });
		expect(coordinator.isHeld("ws-1", "main")).toMatchObject({ taskId: "task-a" });
		expect(coordinator.isHeld("ws-1", "develop")).toMatchObject({ taskId: "task-b" });
	});

	it("allows concurrent locks on different workspaces", () => {
		const coordinator = createCommitLockCoordinator();
		expect(coordinator.acquire("ws-1", "main", "task-a")).toEqual({ acquired: true });
		expect(coordinator.acquire("ws-2", "main", "task-b")).toEqual({ acquired: true });
	});

	it("releases all locks for a workspace", () => {
		const coordinator = createCommitLockCoordinator();
		coordinator.acquire("ws-1", "main", "task-a");
		coordinator.acquire("ws-1", "develop", "task-b");
		coordinator.acquire("ws-2", "main", "task-c");
		coordinator.releaseAllForWorkspace("ws-1");
		expect(coordinator.isHeld("ws-1", "main")).toBeNull();
		expect(coordinator.isHeld("ws-1", "develop")).toBeNull();
		expect(coordinator.isHeld("ws-2", "main")).toMatchObject({ taskId: "task-c" });
	});

	it("isHeld returns null when no lock exists", () => {
		const coordinator = createCommitLockCoordinator();
		expect(coordinator.isHeld("ws-1", "main")).toBeNull();
	});

	it("evicts stale locks on acquire", () => {
		const coordinator = createCommitLockCoordinator({ staleMs: 50 });
		coordinator.acquire("ws-1", "main", "task-a");
		const entry = coordinator.isHeld("ws-1", "main");
		expect(entry).not.toBeNull();
		(entry as { acquiredAt: number }).acquiredAt = Date.now() - 100;
		const result = coordinator.acquire("ws-1", "main", "task-b");
		expect(result).toEqual({ acquired: true });
		expect(coordinator.isHeld("ws-1", "main")).toMatchObject({ taskId: "task-b" });
	});

	it("evicts stale locks on isHeld", () => {
		const coordinator = createCommitLockCoordinator({ staleMs: 50 });
		coordinator.acquire("ws-1", "main", "task-a");
		const entry = coordinator.isHeld("ws-1", "main");
		expect(entry).not.toBeNull();
		(entry as { acquiredAt: number }).acquiredAt = Date.now() - 100;
		expect(coordinator.isHeld("ws-1", "main")).toBeNull();
	});

	it("does not evict fresh locks", () => {
		const coordinator = createCommitLockCoordinator({ staleMs: 60_000 });
		coordinator.acquire("ws-1", "main", "task-a");
		const result = coordinator.acquire("ws-1", "main", "task-b");
		expect(result.acquired).toBe(false);
	});
});

