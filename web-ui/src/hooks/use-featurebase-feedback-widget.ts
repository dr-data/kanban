import { useEffect } from "react";

import { notifyError } from "@/components/app-toaster";
import { fetchFeaturebaseToken } from "@/runtime/runtime-config-query";
import type { RuntimeClineProviderSettings } from "@/runtime/types";

const FEATUREBASE_SDK_ID = "featurebase-sdk";
const FEATUREBASE_SDK_SRC = "https://do.featurebase.app/js/sdk.js";
const FEATUREBASE_ORGANIZATION = "cline";

interface FeaturebaseCallbackPayload {
	action?: string;
	[key: string]: unknown;
}

type FeaturebaseCallback = (error: unknown, callback?: FeaturebaseCallbackPayload | null) => void;

interface FeaturebaseCommand {
	(command: string, payload?: unknown, callback?: FeaturebaseCallback): void;
	q?: unknown[][];
}

interface FeaturebaseWindow extends Window {
	Featurebase?: FeaturebaseCommand;
}

let featurebaseSdkLoadPromise: Promise<void> | null = null;

function ensureFeaturebaseCommand(win: FeaturebaseWindow): FeaturebaseCommand {
	if (typeof win.Featurebase === "function") {
		return win.Featurebase;
	}
	const queuedCommand: FeaturebaseCommand = (...args: unknown[]) => {
		queuedCommand.q = queuedCommand.q ?? [];
		queuedCommand.q.push(args);
	};
	win.Featurebase = queuedCommand;
	return queuedCommand;
}

function ensureFeaturebaseSdkLoaded(): Promise<void> {
	if (featurebaseSdkLoadPromise) {
		return featurebaseSdkLoadPromise;
	}

	featurebaseSdkLoadPromise = new Promise<void>((resolve, reject) => {
		const existingScript = document.getElementById(FEATUREBASE_SDK_ID) as HTMLScriptElement | null;
		if (existingScript?.dataset.loaded === "true") {
			resolve();
			return;
		}

		const script = existingScript ?? document.createElement("script");
		const handleLoad = () => {
			if (script.dataset) {
				script.dataset.loaded = "true";
			}
			resolve();
		};
		const handleError = () => {
			featurebaseSdkLoadPromise = null;
			reject(new Error("Failed to load Featurebase SDK."));
		};
		script.addEventListener("load", handleLoad, { once: true });
		script.addEventListener("error", handleError, { once: true });
		if (!existingScript) {
			script.id = FEATUREBASE_SDK_ID;
			script.src = FEATUREBASE_SDK_SRC;
			script.async = true;
			document.head.appendChild(script);
			return;
		}
		const existingScriptReadyState = (script as HTMLScriptElement & { readyState?: string }).readyState;
		if (existingScriptReadyState === "complete") {
			handleLoad();
		}
	});

	return featurebaseSdkLoadPromise;
}

/**
 * No-op click handler. The Featurebase SDK opens the widget automatically
 * via the `data-featurebase-feedback` attribute on the button.
 *
 * Identity is pre-attached by useFeaturebaseFeedbackWidget when auth state
 * changes, so the widget opens already authenticated — no first-click race.
 */
export function openFeaturebaseFeedbackWidget(): void {
	// Intentionally empty: the SDK handles open via data-featurebase-feedback,
	// and identity is pre-attached by the useEffect in useFeaturebaseFeedbackWidget.
}

export function useFeaturebaseFeedbackWidget(input: {
	workspaceId: string | null;
	clineProviderSettings: RuntimeClineProviderSettings | null;
}): void {
	const { workspaceId, clineProviderSettings } = input;

	// Initialize the Featurebase feedback widget once on mount.
	useEffect(() => {
		const win = window as FeaturebaseWindow;
		ensureFeaturebaseCommand(win);
		let cancelled = false;

		void ensureFeaturebaseSdkLoaded()
			.then(() => {
				if (cancelled) {
					return;
				}
				const featurebase = ensureFeaturebaseCommand(win);
				featurebase("initialize_feedback_widget", {
					organization: FEATUREBASE_ORGANIZATION,
					theme: "dark",
					locale: "en",
					metadata: { app: "kanban" },
				});
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, []);

	// Pre-identify the user whenever auth state changes so the widget is
	// already authenticated before the first click — no flash / race.
	const isAuthenticated =
		clineProviderSettings?.oauthAccessTokenConfigured === true &&
		clineProviderSettings?.oauthRefreshTokenConfigured === true;

	useEffect(() => {
		if (!workspaceId || !isAuthenticated) {
			return;
		}

		const win = window as FeaturebaseWindow;
		let cancelled = false;

		void ensureFeaturebaseSdkLoaded()
			.then(async () => {
				if (cancelled) {
					return;
				}
				const tokenResponse = await fetchFeaturebaseToken(workspaceId);
				if (cancelled) {
					return;
				}
				const featurebase = ensureFeaturebaseCommand(win);
				featurebase(
					"identify",
					{
						organization: FEATUREBASE_ORGANIZATION,
						featurebaseJwt: tokenResponse.featurebaseJwt,
					},
					(error) => {
						if (error && !cancelled) {
							notifyError("Unable to authenticate with Featurebase.");
						}
					},
				);
			})
			.catch(() => {
				// Pre-identify failed silently; will retry on next auth change.
			});

		return () => {
			cancelled = true;
		};
	}, [workspaceId, isAuthenticated]);
}
