import type { TouchEvent as ReactTouchEvent } from "react";
import { useCallback, useRef } from "react";

interface UseLongPressOptions {
	/** Callback fired when a long-press is detected. */
	onLongPress: () => void;
	/** Milliseconds to hold before firing. Default 500. */
	delay?: number;
	/** Pixels of movement that cancel the long-press. Default 5. */
	moveThreshold?: number;
}

interface LongPressHandlers {
	onTouchStart: (e: ReactTouchEvent) => void;
	onTouchMove: (e: ReactTouchEvent) => void;
	onTouchEnd: (e: ReactTouchEvent) => void;
	onTouchCancel: (e: ReactTouchEvent) => void;
}

/**
 * Detects long-press gestures on touch devices. Returns touch event handlers
 * to spread onto the target element. Fires after the configured delay (500ms
 * default) if the finger stays within the move threshold (5px default).
 *
 * Naturally exclusive with drag-and-drop: DnD requires movement within ~150ms
 * while long-press requires stillness for 500ms.
 */
export function useLongPress({ onLongPress, delay = 500, moveThreshold = 5 }: UseLongPressOptions): LongPressHandlers {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const startPosRef = useRef<{ x: number; y: number } | null>(null);
	const firedRef = useRef(false);

	const clear = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		startPosRef.current = null;
	}, []);

	const handleTouchStart = useCallback(
		(e: ReactTouchEvent) => {
			firedRef.current = false;
			const touch = e.touches[0];
			if (!touch) return;
			startPosRef.current = { x: touch.clientX, y: touch.clientY };

			timerRef.current = setTimeout(() => {
				firedRef.current = true;
				timerRef.current = null;
				onLongPress();
			}, delay);
		},
		[onLongPress, delay],
	);

	const handleTouchMove = useCallback(
		(e: ReactTouchEvent) => {
			if (!startPosRef.current || timerRef.current === null) return;
			const touch = e.touches[0];
			if (!touch) return;

			const dx = touch.clientX - startPosRef.current.x;
			const dy = touch.clientY - startPosRef.current.y;
			if (Math.sqrt(dx * dx + dy * dy) > moveThreshold) {
				clear();
			}
		},
		[moveThreshold, clear],
	);

	const handleTouchEnd = useCallback(
		(e: ReactTouchEvent) => {
			clear();
			/* Suppress the ghost click that follows a fired long-press */
			if (firedRef.current) {
				e.preventDefault();
			}
		},
		[clear],
	);

	const handleTouchCancel = useCallback(() => {
		clear();
	}, [clear]);

	return {
		onTouchStart: handleTouchStart,
		onTouchMove: handleTouchMove,
		onTouchEnd: handleTouchEnd,
		onTouchCancel: handleTouchCancel,
	};
}
