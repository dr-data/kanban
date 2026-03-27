import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeClineProviderSettings } from "@/runtime/types";

const defaultClineProviderSettings: RuntimeClineProviderSettings = {
	providerId: null,
	modelId: null,
	baseUrl: null,
	apiKeyConfigured: false,
	oauthProvider: null,
	oauthAccessTokenConfigured: false,
	oauthRefreshTokenConfigured: false,
	oauthAccountId: null,
	oauthExpiresAt: null,
};

async function importFeaturebaseModule() {
	const fetchFeaturebaseTokenMock = vi.fn();
	const notifyErrorMock = vi.fn();
	vi.resetModules();
	vi.doMock("@/runtime/runtime-config-query", () => ({
		fetchFeaturebaseToken: fetchFeaturebaseTokenMock,
	}));
	vi.doMock("@/components/app-toaster", () => ({
		notifyError: notifyErrorMock,
	}));
	const module = await import("@/hooks/use-featurebase-feedback-widget");
	return {
		module,
		fetchFeaturebaseTokenMock,
		notifyErrorMock,
	};
}

describe("useFeaturebaseFeedbackWidget", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		document.head.querySelector("#featurebase-sdk")?.remove();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.resetModules();
		delete (window as Window & { Featurebase?: unknown }).Featurebase;
		document.head.querySelector("#featurebase-sdk")?.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("initializes the feedback widget even if the SDK load event fires immediately", async () => {
		const { module } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: null,
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(featurebaseMock).toHaveBeenCalledWith(
			"initialize_feedback_widget",
			expect.objectContaining({
				organization: "cline",
				theme: "dark",
				locale: "en",
				metadata: { app: "kanban" },
			}),
			expect.any(Function),
		);
	});

	it("replays an early open request after the widget reports ready", async () => {
		vi.useFakeTimers();
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-123" });
		const featurebaseMock = vi.fn();
		const postMessageMock = vi.spyOn(window, "postMessage");
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "test-workspace",
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			module.openFeaturebaseFeedbackWidget();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// The widget is not yet ready, so postMessage should not have been called for the open.
		// But the identify call should have happened via the token fetch.
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeTruthy();
		expect(identifyCall?.[1]).toEqual(
			expect.objectContaining({
				organization: "cline",
				featurebaseJwt: "jwt-123",
			}),
		);

		// Now simulate widget ready
		const initializeCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "initialize_feedback_widget");
		const readyCallback = initializeCall?.[2];
		expect(typeof readyCallback).toBe("function");

		await act(async () => {
			(readyCallback as (error: unknown, callback?: { action?: string }) => void)(null, {
				action: "widgetReady",
			});
			await Promise.resolve();
		});

		// Widget is now ready, but the open flag is only set after identify succeeds.
		// Fire the identify success callback to complete the auth flow.
		const identifyCallback = identifyCall?.[2] as ((error: unknown) => void) | undefined;
		expect(typeof identifyCallback).toBe("function");
		await act(async () => {
			identifyCallback!(null);
			await Promise.resolve();
		});

		expect(postMessageMock).toHaveBeenCalledTimes(1);
		expect(postMessageMock).toHaveBeenCalledWith(
			{
				target: "FeaturebaseWidget",
				data: {
					action: "openFeedbackWidget",
				},
			},
			"*",
		);

		await act(async () => {
			vi.advanceTimersByTime(50);
			await Promise.resolve();
		});

		expect(postMessageMock).toHaveBeenCalledTimes(2);
	});

	it("does NOT call identify with email/name/userId at mount time", async () => {
		const { module } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "workspace-1",
				clineProviderSettings: {
					...defaultClineProviderSettings,
					oauthProvider: "cline",
					oauthAccessTokenConfigured: true,
					oauthAccountId: "account-123",
				},
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		// Mount-time should NOT call identify
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeUndefined();

		// But it should still initialize the widget
		expect(featurebaseMock).toHaveBeenCalledWith(
			"initialize_feedback_widget",
			expect.objectContaining({
				organization: "cline",
				theme: "dark",
				locale: "en",
			}),
			expect.any(Function),
		);
	});

	it("token fetch occurs on open and authenticates with featurebaseJwt", async () => {
		vi.useFakeTimers();
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-abc" });
		const featurebaseMock = vi.fn();
		const postMessageMock = vi.spyOn(window, "postMessage");
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "workspace-1",
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		// Token should NOT be fetched at mount time
		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();

		// Simulate widget ready
		const initializeCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "initialize_feedback_widget");
		const readyCallback = initializeCall?.[2];
		await act(async () => {
			(readyCallback as (error: unknown, callback?: { action?: string }) => void)(null, {
				action: "widgetReady",
			});
			await Promise.resolve();
		});

		// Open triggers token fetch
		await act(async () => {
			module.openFeaturebaseFeedbackWidget();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchFeaturebaseTokenMock).toHaveBeenCalledWith("workspace-1");
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall?.[1]).toEqual(
			expect.objectContaining({
				featurebaseJwt: "jwt-abc",
			}),
		);

		// Widget should NOT be open yet - identify callback has not fired
		expect(postMessageMock).not.toHaveBeenCalled();

		// Invoke the identify callback with success
		const identifyCallback = identifyCall?.[2] as ((error: unknown) => void) | undefined;
		expect(typeof identifyCallback).toBe("function");
		await act(async () => {
			identifyCallback!(null);
			await Promise.resolve();
		});

		// Now the widget should open
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				target: "FeaturebaseWidget",
				data: { action: "openFeedbackWidget" },
			}),
			"*",
		);
	});

	it("identify failure does not open the widget", async () => {
		vi.useFakeTimers();
		const { module, fetchFeaturebaseTokenMock, notifyErrorMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-fail" });
		const featurebaseMock = vi.fn();
		const postMessageMock = vi.spyOn(window, "postMessage");
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "test-workspace",
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		// Simulate widget ready
		const initializeCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "initialize_feedback_widget");
		const readyCallback = initializeCall?.[2];
		await act(async () => {
			(readyCallback as (error: unknown, callback?: { action?: string }) => void)(null, {
				action: "widgetReady",
			});
			await Promise.resolve();
		});

		// Open triggers token fetch
		await act(async () => {
			module.openFeaturebaseFeedbackWidget();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeTruthy();

		// Invoke the identify callback with an error
		const identifyCallback = identifyCall?.[2] as ((error: unknown) => void) | undefined;
		expect(typeof identifyCallback).toBe("function");
		await act(async () => {
			identifyCallback!(new Error("identify failed"));
			await Promise.resolve();
		});

		// Widget should NOT open
		expect(postMessageMock).not.toHaveBeenCalled();
		// Error toast should fire
		expect(notifyErrorMock).toHaveBeenCalledWith("Unable to authenticate with Featurebase. Please try again.");

		// Advance timers to make sure no delayed open occurs
		await act(async () => {
			vi.advanceTimersByTime(100);
			await Promise.resolve();
		});
		expect(postMessageMock).not.toHaveBeenCalled();
	});

	it("widget opens only after identify success callback", async () => {
		vi.useFakeTimers();
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-ok" });
		const featurebaseMock = vi.fn();
		const postMessageMock = vi.spyOn(window, "postMessage");
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "workspace-2",
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		// Simulate widget ready
		const initializeCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "initialize_feedback_widget");
		const readyCallback = initializeCall?.[2];
		await act(async () => {
			(readyCallback as (error: unknown, callback?: { action?: string }) => void)(null, {
				action: "widgetReady",
			});
			await Promise.resolve();
		});

		// Open
		await act(async () => {
			module.openFeaturebaseFeedbackWidget();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeTruthy();

		// Widget should NOT be open yet
		expect(postMessageMock).not.toHaveBeenCalled();

		// Invoke the identify success callback
		const identifyCallback = identifyCall?.[2] as ((error: unknown) => void) | undefined;
		await act(async () => {
			identifyCallback!(null);
			await Promise.resolve();
		});

		// Now it should open
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				target: "FeaturebaseWidget",
				data: { action: "openFeedbackWidget" },
			}),
			"*",
		);

		// The retry should also fire
		await act(async () => {
			vi.advanceTimersByTime(50);
			await Promise.resolve();
		});
		expect(postMessageMock).toHaveBeenCalledTimes(2);
	});

	it("missing token fails closed and does not open widget", async () => {
		vi.useFakeTimers();
		const { module, fetchFeaturebaseTokenMock, notifyErrorMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockRejectedValue(new Error("No token"));
		const featurebaseMock = vi.fn();
		const postMessageMock = vi.spyOn(window, "postMessage");
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "test-workspace",
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		// Simulate widget ready
		const initializeCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "initialize_feedback_widget");
		const readyCallback = initializeCall?.[2];
		await act(async () => {
			(readyCallback as (error: unknown, callback?: { action?: string }) => void)(null, {
				action: "widgetReady",
			});
			await Promise.resolve();
		});

		// Open triggers token fetch which fails
		await act(async () => {
			module.openFeaturebaseFeedbackWidget();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Widget should NOT open because token fetch failed (fail closed)
		expect(postMessageMock).not.toHaveBeenCalled();
		// Error toast should fire
		expect(notifyErrorMock).toHaveBeenCalledWith("Unable to load feedback. Please try again.");

		// No identify call should happen
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeUndefined();
	});
});
