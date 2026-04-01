import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT_PX = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px)`;

/**
 * Detects whether the viewport width is below the mobile breakpoint (768px).
 * Uses matchMedia for efficient, non-polling detection with automatic updates
 * on viewport resize. Call once in App.tsx and pass down via props.
 */
export function useIsMobile(): boolean {
	const [isMobile, setIsMobile] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia(MOBILE_QUERY).matches;
	});

	useEffect(() => {
		const mql = window.matchMedia(MOBILE_QUERY);
		const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);

	return isMobile;
}
