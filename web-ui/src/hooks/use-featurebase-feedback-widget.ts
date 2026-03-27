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
let currentWorkspaceId: string | null = null;

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

export function openFeaturebaseFeedbackWidget(): void {
	const workspaceId = currentWorkspaceId;
	if (workspaceId === null) {
		return;
	}

	const win = window as FeaturebaseWindow;
	ensureFeaturebaseCommand(win);

	void ensureFeaturebaseSdkLoaded()
		.then(async () => {
			const tokenResponse = await fetchFeaturebaseToken(workspaceId);
			const featurebase = ensureFeaturebaseCommand(win);
			featurebase(
				"identify",
				{
					organization: FEATUREBASE_ORGANIZATION,
					featurebaseJwt: tokenResponse.featurebaseJwt,
				},
				(error) => {
					if (error) {
						notifyError("Unable to authenticate with Featurebase. Please try again.");
						return;
					}
					// The widget is opened by the Featurebase SDK via data-featurebase-feedback.
					// We only need to identify here; do NOT manually post an open message
					// as that would cause a double-open flicker.
				},
			);
		})
		.catch(() => {
			// Fail closed: do not open the widget without valid JWT auth.
			notifyError("Unable to load feedback. Please try again.");
		});
}

export function useFeaturebaseFeedbackWidget(input: {
	workspaceId: string | null;
	clineProviderSettings: RuntimeClineProviderSettings | null;
}): void {
	const { workspaceId } = input;

	// Keep module-level workspace ID in sync for openFeaturebaseFeedbackWidget.
	useEffect(() => {
		currentWorkspaceId = workspaceId;
	}, [workspaceId]);

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
}
