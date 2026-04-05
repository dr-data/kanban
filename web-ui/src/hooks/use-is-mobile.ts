import { useMedia } from "@/utils/react-use";

const MOBILE_BREAKPOINT = "(max-width: 767px)";

/** Returns true when the viewport is at or below the mobile breakpoint (767px). */
export function useIsMobile(): boolean {
	return useMedia(MOBILE_BREAKPOINT, false);
}
