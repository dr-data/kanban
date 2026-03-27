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

const authenticatedClineSettings: RuntimeClineProviderSettings = {
	...defaultClineProviderSettings,
	oauthProvider: "cline",
	oauthAccessTokenConfigured: true,
	oauthRefreshTokenConfigured: true,
	oauthAccountId: "acc-1",
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

		const initCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "initialize_feedback_widget");
		expect(initCall).toBeTruthy();
		expect(initCall?.[1]).toEqual(
			expect.objectContaining({
				organization: "cline",
				theme: "dark",
				locale: "en",
				metadata: { app: "kanban" },
			}),
		);
	});

	it("does NOT pre-identify when user is not authenticated", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
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
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		// No token fetch for unauthenticated users
		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();
		// No identify call
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeUndefined();
	});

	it("pre-identifies the user when authenticated (no first-click race)", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-abc" });
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
				clineProviderSettings: authenticatedClineSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Token should be fetched proactively
		expect(fetchFeaturebaseTokenMock).toHaveBeenCalledWith("workspace-1");

		// identify should be called with the JWT
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeTruthy();
		expect(identifyCall?.[1]).toEqual(
			expect.objectContaining({
				organization: "cline",
				featurebaseJwt: "jwt-abc",
			}),
		);
	});

	it("does not pre-identify when workspaceId is null", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
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
				clineProviderSettings: authenticatedClineSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();
	});

	it("pre-identify failure shows error toast but does not crash", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockRejectedValue(new Error("No token"));
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
				clineProviderSettings: authenticatedClineSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Token was requested
		expect(fetchFeaturebaseTokenMock).toHaveBeenCalledWith("workspace-1");
		// No identify call (token fetch failed)
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeUndefined();
		// Error is caught silently (pre-identify failure will retry on next auth change)
	});

	it("openFeaturebaseFeedbackWidget is a no-op (SDK handles open via attribute)", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		const postMessageMock = vi.spyOn(window, "postMessage");

		// Call the function — it should do nothing
		module.openFeaturebaseFeedbackWidget();

		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();
		expect(postMessageMock).not.toHaveBeenCalled();
	});
});
