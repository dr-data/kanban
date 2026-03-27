import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeClineProviderSettings } from "@/runtime/types";
import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";

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

const tokensOnlySettings: RuntimeClineProviderSettings = {
	...defaultClineProviderSettings,
	oauthProvider: null,
	oauthAccessTokenConfigured: true,
	oauthRefreshTokenConfigured: true,
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
	// Re-export the real isClineOauthAuthenticated so the hook resolves it.
	const nativeAgent = await import("@/runtime/native-agent");
	vi.doMock("@/runtime/native-agent", () => ({
		...nativeAgent,
		isClineOauthAuthenticated: nativeAgent.isClineOauthAuthenticated,
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

	function mockSdkLoad(featurebaseMock: ReturnType<typeof vi.fn>) {
		const originalAppendChild = document.head.appendChild.bind(document.head);
		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});
	}

	it("initializes the feedback widget on mount", async () => {
		const { module } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

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

	it("returns idle state when unauthenticated", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
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

		expect(hookResult!.authState).toBe("idle");
		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();
	});

	it("requires oauthProvider=cline (tokens alone stay idle)", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
				workspaceId: "workspace-1",
				clineProviderSettings: tokensOnlySettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(hookResult!.authState).toBe("idle");
		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();
	});

	it("transitions to ready on successful pre-identify", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-abc" });
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
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

		// identify should have been called
		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		expect(identifyCall).toBeTruthy();

		// Simulate the identify callback succeeding
		const identifyCallback = identifyCall?.[2] as ((error: unknown) => void) | undefined;
		await act(async () => {
			identifyCallback?.(null);
			await Promise.resolve();
		});

		expect(hookResult!.authState).toBe("ready");
	});

	it("transitions to error on token fetch failure", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockRejectedValue(new Error("Network error"));
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
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

		expect(hookResult!.authState).toBe("error");
		expect(fetchFeaturebaseTokenMock).toHaveBeenCalledWith("workspace-1");
	});

	it("transitions to error on identify callback error", async () => {
		const { module, fetchFeaturebaseTokenMock, notifyErrorMock } = await importFeaturebaseModule();
		fetchFeaturebaseTokenMock.mockResolvedValue({ featurebaseJwt: "jwt-abc" });
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
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

		const identifyCall = featurebaseMock.mock.calls.find((call: unknown[]) => call[0] === "identify");
		const identifyCallback = identifyCall?.[2] as ((error: unknown) => void) | undefined;
		await act(async () => {
			identifyCallback?.(new Error("Featurebase error"));
			await Promise.resolve();
		});

		expect(hookResult!.authState).toBe("error");
		expect(notifyErrorMock).toHaveBeenCalledWith("Unable to authenticate with Featurebase.");
	});

	it("retry re-runs pre-identify after error", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		// First call fails, second succeeds
		fetchFeaturebaseTokenMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce({ featurebaseJwt: "jwt-retry" });
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
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

		expect(hookResult!.authState).toBe("error");
		expect(fetchFeaturebaseTokenMock).toHaveBeenCalledTimes(1);

		// Call retry
		await act(async () => {
			hookResult!.retry();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchFeaturebaseTokenMock).toHaveBeenCalledTimes(2);
		// After successful retry, identify is called
		const identifyCalls = featurebaseMock.mock.calls.filter((call: unknown[]) => call[0] === "identify");
		expect(identifyCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("does not pre-identify when workspaceId is null", async () => {
		const { module, fetchFeaturebaseTokenMock } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		mockSdkLoad(featurebaseMock);

		let hookResult: FeaturebaseFeedbackState | null = null;
		function HookHarness(): null {
			hookResult = module.useFeaturebaseFeedbackWidget({
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

		expect(hookResult!.authState).toBe("idle");
		expect(fetchFeaturebaseTokenMock).not.toHaveBeenCalled();
	});
});
