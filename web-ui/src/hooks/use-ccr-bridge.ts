import { useCallback, useMemo } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeTaskSessionState } from "@/runtime/types";

interface UseCcrBridgeOptions {
	selectedTaskId: string | null;
	selectedAgentId: RuntimeAgentId | null;
	sessionState: RuntimeTaskSessionState | null;
	remoteControlEnabled: boolean;
	currentProjectId: string | null;
}

interface UseCcrBridgeResult {
	isTeleportDisabled: boolean;
	isTeleportActive: boolean;
	teleport: () => Promise<void>;
}

/**
 * Manages CCR bridge (teleport/remote-control) state for Claude Code sessions.
 *
 * When teleport is activated, this hook calls the backend to enable remote
 * control on the selected task session and opens claude.ai/code in a new tab.
 */
export function useCcrBridge(options: UseCcrBridgeOptions): UseCcrBridgeResult {
	const { selectedTaskId, selectedAgentId, sessionState, remoteControlEnabled, currentProjectId } = options;

	/** Disabled when no Claude task is selected or session isn't active. */
	const isTeleportDisabled = useMemo(() => {
		return selectedTaskId === null || selectedAgentId !== "claude" || sessionState === null;
	}, [selectedTaskId, selectedAgentId, sessionState]);

	const isTeleportActive = remoteControlEnabled;

	const teleport = useCallback(async () => {
		if (!selectedTaskId || !currentProjectId) {
			return;
		}
		try {
			const client = getRuntimeTrpcClient(currentProjectId);
			const result = await client.runtime.enableRemoteControl.mutate({
				taskId: selectedTaskId,
				enabled: true,
			});
			if (!result.ok) {
				if (result.requiresRestart) {
					showAppToast({ intent: "warning", message: "Restart the task to enable remote control" });
				} else {
					showAppToast({ intent: "danger", message: result.error ?? "Failed to enable remote control" });
				}
				return;
			}
			showAppToast({ intent: "success", message: "Remote control enabled — opening claude.ai" });
			window.open("https://claude.ai/code", "_blank");
		} catch {
			showAppToast({ intent: "danger", message: "Failed to enable remote control" });
		}
	}, [selectedTaskId, currentProjectId]);

	return { isTeleportDisabled, isTeleportActive, teleport };
}
