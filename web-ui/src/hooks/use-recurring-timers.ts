import { shouldTaskRecur } from "@runtime-task-state";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { findCardSelection, moveTaskToColumn, updateTask } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

/** Minimum allowed recurring period in milliseconds (3 minutes). */
const MIN_RECURRING_PERIOD_MS = 180_000;

interface UseRecurringTimersOptions {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	startBacklogTask: (task: BoardCard) => Promise<boolean>;
}

/** Clamps a period value to the minimum recurring period threshold. */
function clampPeriodMs(periodMs: number): number {
	return Math.max(periodMs, MIN_RECURRING_PERIOD_MS);
}

/**
 * Watches for recurring-eligible tasks entering the trash column and
 * automatically restarts them after the configured period. Only processes
 * tasks in trash — tasks in review are left alone so the user can inspect
 * results before the next iteration begins. Also respects `scheduledEndAt`
 * — if set and past, the task will not recur even if iterations remain.
 * Mirrors the ref + useEffect pattern used by `useReviewAutoActions`.
 */
export function useRecurringTimers({ board, setBoard, startBacklogTask }: UseRecurringTimersOptions): void {
	const boardRef = useRef<BoardData>(board);
	const startBacklogTaskRef = useRef(startBacklogTask);
	const pendingTimersRef = useRef<Map<string, number>>(new Map());

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	useEffect(() => {
		startBacklogTaskRef.current = startBacklogTask;
	}, [startBacklogTask]);

	/**
	 * Determines whether a task has passed its scheduled end time.
	 * Returns true if `scheduledEndAt` is set and the current time is past it.
	 */
	const isTaskPastScheduledEnd = useCallback((card: BoardCard): boolean => {
		return card.scheduledEndAt != null && Date.now() > card.scheduledEndAt;
	}, []);

	/**
	 * Restarts a recurring-eligible task by moving it from trash to backlog
	 * with an incremented iteration counter, then auto-starting it. Only
	 * processes tasks in trash — review tasks are left for user inspection.
	 */
	const restartRecurringTask = useCallback(
		(taskId: string) => {
			const currentBoard = boardRef.current;
			const selection = findCardSelection(currentBoard, taskId);
			if (!selection || selection.column.id !== "trash") {
				return;
			}
			if (!shouldTaskRecur(selection.card) || isTaskPastScheduledEnd(selection.card)) {
				return;
			}

			const nextIteration = (selection.card.recurringCurrentIteration ?? 0) + 1;

			setBoard((prevBoard) => {
				const latestSelection = findCardSelection(prevBoard, taskId);
				if (!latestSelection || latestSelection.column.id !== "trash") {
					return prevBoard;
				}
				if (!shouldTaskRecur(latestSelection.card) || isTaskPastScheduledEnd(latestSelection.card)) {
					return prevBoard;
				}

				const updated = updateTask(prevBoard, taskId, {
					prompt: latestSelection.card.prompt,
					startInPlanMode: latestSelection.card.startInPlanMode,
					autoReviewEnabled: latestSelection.card.autoReviewEnabled,
					autoReviewMode: latestSelection.card.autoReviewMode,
					images: latestSelection.card.images,
					baseRef: latestSelection.card.baseRef,
					recurringEnabled: latestSelection.card.recurringEnabled,
					recurringMaxIterations: latestSelection.card.recurringMaxIterations,
					recurringPeriodMs: latestSelection.card.recurringPeriodMs,
					recurringCurrentIteration: nextIteration,
					scheduledStartAt: latestSelection.card.scheduledStartAt,
					scheduledEndAt: latestSelection.card.scheduledEndAt,
				});
				if (!updated.updated) {
					return prevBoard;
				}

				const moved = moveTaskToColumn(updated.board, taskId, "backlog", { insertAtTop: true });
				return moved.moved ? moved.board : prevBoard;
			});

			showAppToast({
				intent: "primary",
				message: `Recurring task restarted: ${truncateTaskPromptLabel(selection.card.prompt)}`,
			});

			/* Wait for React commit phase so boardRef is synced before starting. */
			requestAnimationFrame(() => {
				const afterBoard = boardRef.current;
				const afterSelection = findCardSelection(afterBoard, taskId);
				if (!afterSelection || afterSelection.column.id !== "backlog") {
					return;
				}
				void startBacklogTaskRef.current(afterSelection.card);
			});
		},
		[isTaskPastScheduledEnd, setBoard],
	);

	/**
	 * Scans the trash column for recurring-eligible tasks and schedules (or
	 * immediately triggers) their restart based on the configured period.
	 * Review column is intentionally excluded — tasks stay in review for
	 * user inspection until explicitly moved to trash.
	 */
	const evaluateRecurringTimers = useCallback(() => {
		const currentBoard = boardRef.current;
		const trashColumn = currentBoard.columns.find((col) => col.id === "trash");

		/* Collect eligible cards from trash only. */
		const eligibleCards: BoardCard[] = [];
		if (trashColumn) {
			for (const card of trashColumn.cards) {
				if (card.recurringEnabled && shouldTaskRecur(card) && !isTaskPastScheduledEnd(card)) {
					eligibleCards.push(card);
				}
			}
		}

		const eligibleIds = new Set(eligibleCards.map((card) => card.id));

		/* Clear timers for tasks no longer eligible. */
		for (const [taskId, timerId] of pendingTimersRef.current) {
			if (!eligibleIds.has(taskId)) {
				window.clearTimeout(timerId);
				pendingTimersRef.current.delete(taskId);
			}
		}

		/* Schedule new timers for eligible tasks not yet tracked. */
		for (const card of eligibleCards) {
			if (pendingTimersRef.current.has(card.id)) {
				continue;
			}

			const periodMs = clampPeriodMs(card.recurringPeriodMs ?? 0);
			const elapsed = Date.now() - card.updatedAt;
			const remaining = periodMs - elapsed;

			if (remaining <= 0) {
				restartRecurringTask(card.id);
			} else {
				const timerId = window.setTimeout(() => {
					pendingTimersRef.current.delete(card.id);
					restartRecurringTask(card.id);
				}, remaining);
				pendingTimersRef.current.set(card.id, timerId);
			}
		}
	}, [isTaskPastScheduledEnd, restartRecurringTask]);

	/* Re-evaluate whenever the board changes. */
	useEffect(() => {
		evaluateRecurringTimers();
	}, [board, evaluateRecurringTimers]);

	/* Clear all pending timers on unmount. */
	useEffect(() => {
		return () => {
			for (const timerId of pendingTimersRef.current.values()) {
				window.clearTimeout(timerId);
			}
			pendingTimersRef.current.clear();
		};
	}, []);
}
