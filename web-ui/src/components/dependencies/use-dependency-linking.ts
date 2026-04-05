import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface DependencyLinkDraft {
	sourceTaskId: string;
	targetTaskId: string | null;
	pointerClientX: number;
	pointerClientY: number;
}

export interface MobileLinkMode {
	/** Whether mobile link mode is currently active (tap-based dependency linking). */
	isActive: boolean;
	/** Activate mobile link mode so card taps create dependency links. */
	enter: () => void;
	/** Deactivate mobile link mode and cancel any in-progress draft. */
	exit: () => void;
	/** Toggle mobile link mode on or off. */
	toggle: () => void;
}

const CARD_GAP_CAPTURE_PX = 16;

/** Find the nearest card within a column that is close to the given vertical position. */
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

/** Resolve the task ID at a given screen coordinate by checking the DOM for card and column elements. */
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
 * Hook that manages the dependency linking interaction for both desktop (modifier-key + click)
 * and mobile (tap-based link mode). Desktop flow: hold Cmd/Ctrl, click source card, hover target
 * card, release modifier. Mobile flow: activate link mode, tap source card, tap target card.
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
	mobileLinkMode: MobileLinkMode;
	/**
	 * Handle a tap on a card while mobile link mode is active.
	 * First tap sets the source card; second tap on a different card completes the link.
	 * Returns true if the tap was consumed by the linking flow.
	 */
	onMobileLinkTap: (taskId: string) => boolean;
} {
	const [draft, setDraft] = useState<DependencyLinkDraft | null>(null);
	const draftRef = useRef<DependencyLinkDraft | null>(null);
	const modifierPressedRef = useRef(false);
	const [mobileLinkModeActive, setMobileLinkModeActive] = useState(false);
	const mobileLinkModeActiveRef = useRef(false);

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
	}, [completeDependencyLink, getValidTargetTaskId, isLinking]);

	const handleDependencyPointerDown = useCallback((taskId: string, event: ReactMouseEvent<HTMLElement>) => {
		modifierPressedRef.current = event.metaKey || event.ctrlKey;
		setDraft((current) => {
			if (current?.sourceTaskId === taskId) {
				draftRef.current = null;
				return null;
			}
			const nextDraft = {
				sourceTaskId: taskId,
				targetTaskId: null,
				pointerClientX: event.clientX,
				pointerClientY: event.clientY,
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

	/* --- Mobile link mode --- */

	useEffect(() => {
		mobileLinkModeActiveRef.current = mobileLinkModeActive;
	}, [mobileLinkModeActive]);

	/** Activate mobile link mode so taps on cards create dependency links. */
	const enterMobileLinkMode = useCallback(() => {
		setMobileLinkModeActive(true);
		mobileLinkModeActiveRef.current = true;
	}, []);

	/** Deactivate mobile link mode and cancel any in-progress draft. */
	const exitMobileLinkMode = useCallback(() => {
		setMobileLinkModeActive(false);
		mobileLinkModeActiveRef.current = false;
		draftRef.current = null;
		setDraft(null);
	}, []);

	/** Toggle mobile link mode on or off. */
	const toggleMobileLinkMode = useCallback(() => {
		if (mobileLinkModeActiveRef.current) {
			exitMobileLinkMode();
		} else {
			enterMobileLinkMode();
		}
	}, [enterMobileLinkMode, exitMobileLinkMode]);

	/**
	 * Handle a tap on a card in mobile link mode.
	 * If no source is set, this tap sets the source. If a source is already set
	 * and the tapped card is a valid target, the dependency is created.
	 * Returns true if the tap was consumed by the linking flow.
	 */
	const handleMobileLinkTap = useCallback(
		(taskId: string): boolean => {
			if (!mobileLinkModeActiveRef.current) {
				return false;
			}
			const current = draftRef.current;
			if (!current) {
				const nextDraft: DependencyLinkDraft = {
					sourceTaskId: taskId,
					targetTaskId: null,
					pointerClientX: 0,
					pointerClientY: 0,
				};
				draftRef.current = nextDraft;
				setDraft(nextDraft);
				return true;
			}
			if (current.sourceTaskId === taskId) {
				draftRef.current = null;
				setDraft(null);
				return true;
			}
			const validTarget = getValidTargetTaskId(current.sourceTaskId, taskId);
			if (validTarget) {
				onCreateDependency?.(current.sourceTaskId, validTarget);
				draftRef.current = null;
				setDraft(null);
				return true;
			}
			return true;
		},
		[getValidTargetTaskId, onCreateDependency],
	);

	const mobileLinkMode: MobileLinkMode = {
		isActive: mobileLinkModeActive,
		enter: enterMobileLinkMode,
		exit: exitMobileLinkMode,
		toggle: toggleMobileLinkMode,
	};

	return {
		draft,
		onDependencyPointerDown: handleDependencyPointerDown,
		onDependencyPointerEnter: handleDependencyPointerEnter,
		mobileLinkMode,
		onMobileLinkTap: handleMobileLinkTap,
	};
}
