import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface DependencyLinkDraft {
	sourceTaskId: string;
	targetTaskId: string | null;
	pointerClientX: number;
	pointerClientY: number;
	/** Whether the linking was initiated via desktop (Cmd/Ctrl+click) or touch (long-press). */
	mode: "desktop" | "touch";
}

const CARD_GAP_CAPTURE_PX = 16;
const TOUCH_LINK_TOAST_ID = "touch-link-mode";
const TOUCH_LINK_AUTO_CANCEL_MS = 15_000;

/**
 * Finds the nearest card within a column by vertical proximity, allowing
 * clicks in the gap between cards to still resolve to a valid target.
 */
function getNearestCardTaskIdInColumn(columnElement: HTMLElement, clientY: number): string | null {
	const cards = Array.from(columnElement.querySelectorAll<HTMLElement>("[data-task-id]"));
	if (cards.length === 0) {
		return null;
	}

	let nearestBelow: { taskId: string; distance: number } | null = null;
	let nearestAbove: { taskId: string; distance: number } | null = null;

	for (const card of cards) {
		const taskId = card.dataset.taskId;
		if (!taskId) {
			continue;
		}
		const rect = card.getBoundingClientRect();
		if (clientY >= rect.top && clientY <= rect.bottom) {
			return taskId;
		}
		if (clientY < rect.top) {
			const distance = rect.top - clientY;
			if (!nearestBelow || distance < nearestBelow.distance) {
				nearestBelow = { taskId, distance };
			}
			continue;
		}
		const distance = clientY - rect.bottom;
		if (!nearestAbove || distance < nearestAbove.distance) {
			nearestAbove = { taskId, distance };
		}
	}

	if (nearestBelow && nearestBelow.distance <= CARD_GAP_CAPTURE_PX) {
		return nearestBelow.taskId;
	}
	if (nearestAbove && nearestAbove.distance <= CARD_GAP_CAPTURE_PX) {
		return nearestAbove.taskId;
	}

	return null;
}

/**
 * Resolves the task ID at a specific screen coordinate by checking elements
 * at that point, falling back to nearest-card-in-column heuristic.
 */
function getTaskIdFromPoint(clientX: number, clientY: number): string | null {
	if (typeof document === "undefined") {
		return null;
	}
	const elementsAtPoint = document.elementsFromPoint(clientX, clientY);
	let columnElement: HTMLElement | null = null;
	for (const element of elementsAtPoint) {
		const card = element.closest("[data-task-id]");
		if (card instanceof HTMLElement) {
			return card.dataset.taskId ?? null;
		}
		if (!columnElement) {
			const column = element.closest("[data-column-id]");
			if (column instanceof HTMLElement) {
				columnElement = column;
			}
		}
	}

	if (columnElement) {
		return getNearestCardTaskIdInColumn(columnElement, clientY);
	}
	return null;
}

/**
 * Manages the dependency linking interaction for both desktop (Cmd/Ctrl+click)
 * and touch (long-press → tap target) modes. On desktop, users hold a modifier
 * key and click source then target. On touch, users long-press a card to enter
 * linking mode, then tap another card to complete the link.
 */
export function useDependencyLinking({
	canLinkTasks,
	onCreateDependency,
}: {
	canLinkTasks?: (fromTaskId: string, toTaskId: string) => boolean;
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
}): {
	draft: DependencyLinkDraft | null;
	onDependencyPointerDown: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter: (taskId: string) => void;
	onTouchLinkStart: (taskId: string) => void;
	onTouchLinkTarget: (taskId: string) => void;
	cancelTouchLink: () => void;
} {
	const [draft, setDraft] = useState<DependencyLinkDraft | null>(null);
	const draftRef = useRef<DependencyLinkDraft | null>(null);
	const modifierPressedRef = useRef(false);
	const touchCancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const getValidTargetTaskId = useCallback(
		(sourceTaskId: string, targetTaskId: string | null): string | null => {
			if (!targetTaskId || targetTaskId === sourceTaskId) {
				return null;
			}
			if (canLinkTasks && !canLinkTasks(sourceTaskId, targetTaskId)) {
				return null;
			}
			return targetTaskId;
		},
		[canLinkTasks],
	);

	const completeDependencyLink = useCallback(
		(taskId: string | null): boolean => {
			const current = draftRef.current;
			const validTaskId = current ? getValidTargetTaskId(current.sourceTaskId, taskId) : null;
			if (!current || !validTaskId) {
				return false;
			}
			onCreateDependency?.(current.sourceTaskId, validTaskId);
			draftRef.current = null;
			setDraft(null);
			return true;
		},
		[getValidTargetTaskId, onCreateDependency],
	);

	/** Clears any active touch linking state and removes visual indicators. */
	const clearTouchLinkState = useCallback(() => {
		if (touchCancelTimerRef.current !== null) {
			clearTimeout(touchCancelTimerRef.current);
			touchCancelTimerRef.current = null;
		}
		document.body.classList.remove("kb-dependency-link-mode-touch");
		toast.dismiss(TOUCH_LINK_TOAST_ID);
	}, []);

	useEffect(() => {
		draftRef.current = draft;
	}, [draft]);

	useEffect(() => {
		const handleKeyStateChange = (event: KeyboardEvent) => {
			modifierPressedRef.current = event.metaKey || event.ctrlKey;
		};
		const handleWindowBlur = () => {
			modifierPressedRef.current = false;
			draftRef.current = null;
			setDraft(null);
		};
		window.addEventListener("keydown", handleKeyStateChange);
		window.addEventListener("keyup", handleKeyStateChange);
		window.addEventListener("blur", handleWindowBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyStateChange);
			window.removeEventListener("keyup", handleKeyStateChange);
			window.removeEventListener("blur", handleWindowBlur);
		};
	}, []);

	const isLinking = draft !== null;

	useEffect(() => {
		if (!isLinking) {
			if (typeof document !== "undefined") {
				document.body.classList.remove("kb-dependency-link-mode");
			}
			return;
		}

		const currentDraft = draftRef.current;

		/* Touch mode: cancel linking when tapping outside the board area.
		   Uses pointerdown (not touchstart) for cross-platform support — works
		   on both real touch devices and desktop narrow windows. Ignores taps
		   inside the board, column tabs, and buttons to allow swiping between
		   columns and tapping the Link button without cancelling. */
		if (currentDraft?.mode === "touch") {
			const handleOutsideCancel = (event: Event) => {
				const target = event.target;
				if (!(target instanceof Element)) return;
				if (
					target.closest("[data-task-id]") ||
					target.closest(".kb-board") ||
					target.closest(".kb-mobile-column-tabs") ||
					target.closest("button")
				) {
					return;
				}
				clearTouchLinkState();
				draftRef.current = null;
				setDraft(null);
			};

			document.addEventListener("pointerdown", handleOutsideCancel, { capture: true });
			return () => {
				document.removeEventListener("pointerdown", handleOutsideCancel, { capture: true });
				clearTouchLinkState();
			};
		}

		/* Desktop mode: track mouse movement and modifier keys */
		document.body.classList.add("kb-dependency-link-mode");

		const handleMouseMove = (event: MouseEvent) => {
			setDraft((current) => {
				if (!current) {
					return current;
				}
				const targetTaskId = getValidTargetTaskId(
					current.sourceTaskId,
					getTaskIdFromPoint(event.clientX, event.clientY),
				);
				return {
					...current,
					pointerClientX: event.clientX,
					pointerClientY: event.clientY,
					targetTaskId,
				};
			});
		};

		const handleMouseUp = (event: MouseEvent) => {
			setDraft(() => {
				const current = draftRef.current;
				if (!current) {
					return null;
				}
				const resolvedTargetTaskId = getValidTargetTaskId(
					current.sourceTaskId,
					getTaskIdFromPoint(event.clientX, event.clientY) ?? current.targetTaskId,
				);
				if (modifierPressedRef.current && completeDependencyLink(resolvedTargetTaskId ?? null)) {
					return null;
				}
				if (!modifierPressedRef.current) {
					draftRef.current = null;
					return null;
				}
				const nextDraft = {
					...current,
					targetTaskId: resolvedTargetTaskId ?? null,
					pointerClientX: event.clientX,
					pointerClientY: event.clientY,
				};
				draftRef.current = nextDraft;
				return nextDraft;
			});
		};

		const handleModifierRelease = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey) {
				return;
			}
			modifierPressedRef.current = false;
			const current = draftRef.current;
			if (!current) {
				return;
			}
			const resolvedTargetTaskId = getValidTargetTaskId(
				current.sourceTaskId,
				current.targetTaskId ?? getTaskIdFromPoint(current.pointerClientX, current.pointerClientY),
			);
			if (completeDependencyLink(resolvedTargetTaskId)) {
				return;
			}
			draftRef.current = null;
			setDraft(null);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		window.addEventListener("keyup", handleModifierRelease);
		return () => {
			document.body.classList.remove("kb-dependency-link-mode");
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			window.removeEventListener("keyup", handleModifierRelease);
		};
	}, [clearTouchLinkState, completeDependencyLink, getValidTargetTaskId, isLinking]);

	/** Desktop: initiates linking via Cmd/Ctrl + mouse down on a card. */
	const handleDependencyPointerDown = useCallback((taskId: string, event: ReactMouseEvent<HTMLElement>) => {
		modifierPressedRef.current = event.metaKey || event.ctrlKey;
		setDraft((current) => {
			if (current?.sourceTaskId === taskId) {
				draftRef.current = null;
				return null;
			}
			const nextDraft: DependencyLinkDraft = {
				sourceTaskId: taskId,
				targetTaskId: null,
				pointerClientX: event.clientX,
				pointerClientY: event.clientY,
				mode: "desktop",
			};
			draftRef.current = nextDraft;
			return nextDraft;
		});
	}, []);

	const handleDependencyPointerEnter = useCallback(
		(taskId: string) => {
			setDraft((current) => {
				if (!current) {
					return current;
				}
				const nextDraft = {
					...current,
					targetTaskId: getValidTargetTaskId(current.sourceTaskId, taskId),
				};
				draftRef.current = nextDraft;
				return nextDraft;
			});
		},
		[getValidTargetTaskId],
	);

	/**
	 * Touch: initiates linking mode via long-press on a card. Shows a toast
	 * with instructions and sets a 15-second auto-cancel timeout.
	 */
	const handleTouchLinkStart = useCallback((taskId: string) => {
		document.body.classList.add("kb-dependency-link-mode-touch");
		toast("Tap another card to link, or tap elsewhere to cancel", {
			id: TOUCH_LINK_TOAST_ID,
			duration: TOUCH_LINK_AUTO_CANCEL_MS,
		});

		const nextDraft: DependencyLinkDraft = {
			sourceTaskId: taskId,
			targetTaskId: null,
			pointerClientX: 0,
			pointerClientY: 0,
			mode: "touch",
		};
		draftRef.current = nextDraft;
		setDraft(nextDraft);

		/* Auto-cancel after timeout */
		touchCancelTimerRef.current = setTimeout(() => {
			touchCancelTimerRef.current = null;
			document.body.classList.remove("kb-dependency-link-mode-touch");
			draftRef.current = null;
			setDraft(null);
		}, TOUCH_LINK_AUTO_CANCEL_MS);
	}, []);

	/**
	 * Touch: completes the link by validating and creating the dependency
	 * between the source (from long-press) and the tapped target card.
	 */
	const handleTouchLinkTarget = useCallback(
		(taskId: string) => {
			const current = draftRef.current;
			if (!current || current.mode !== "touch") return;

			const validTarget = getValidTargetTaskId(current.sourceTaskId, taskId);
			if (validTarget) {
				completeDependencyLink(validTarget);
			} else {
				draftRef.current = null;
				setDraft(null);
			}
			clearTouchLinkState();
		},
		[clearTouchLinkState, completeDependencyLink, getValidTargetTaskId],
	);

	/** Touch: cancels the active touch linking mode without creating a link. */
	const handleCancelTouchLink = useCallback(() => {
		clearTouchLinkState();
		draftRef.current = null;
		setDraft(null);
	}, [clearTouchLinkState]);

	return {
		draft,
		onDependencyPointerDown: handleDependencyPointerDown,
		onDependencyPointerEnter: handleDependencyPointerEnter,
		onTouchLinkStart: handleTouchLinkStart,
		onTouchLinkTarget: handleTouchLinkTarget,
		cancelTouchLink: handleCancelTouchLink,
	};
}
