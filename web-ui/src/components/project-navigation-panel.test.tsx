import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeClineProviderSettings } from "@/runtime/types";
import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";

import { FeedbackCard } from "./project-navigation-panel";

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

const tokenOnlySettings: RuntimeClineProviderSettings = {
	...defaultClineProviderSettings,
	oauthProvider: null,
	oauthAccessTokenConfigured: true,
	oauthRefreshTokenConfigured: true,
};

const accessOnlyNoRefreshSettings: RuntimeClineProviderSettings = {
	...defaultClineProviderSettings,
	oauthProvider: "cline",
	oauthAccessTokenConfigured: true,
	oauthRefreshTokenConfigured: false,
	oauthAccountId: "acc-1",
};

describe("FeedbackCard", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	function getFeedbackButton(): HTMLButtonElement | null {
		const buttons = container.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.includes("Share Feedback")) {
				return btn;
			}
		}
		return null;
	}

	// 1. Non-Cline agent => render nothing
	it("renders nothing when selected agent is not Cline (Claude API key)", () => {
		act(() => {
			root.render(<FeedbackCard selectedAgentId={"claude" as never} clineProviderSettings={authenticatedClineSettings} />);
		});
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing when selectedAgentId is null", () => {
		act(() => {
			root.render(<FeedbackCard selectedAgentId={null} clineProviderSettings={authenticatedClineSettings} />);
		});
		expect(container.innerHTML).toBe("");
	});

	// 2. Cline agent, not signed in => sign-in/settings CTA
	it("shows disabled button and clickable sign-in message when not authenticated", () => {
		const onOpenSettings = vi.fn();
		act(() => {
			root.render(
				<FeedbackCard
					selectedAgentId={"cline"}
					clineProviderSettings={defaultClineProviderSettings}
					onOpenSettings={onOpenSettings}
				/>,
			);
		});

		const button = getFeedbackButton();
		expect(button).toBeTruthy();
		expect(button!.disabled).toBe(true);
		expect(button!.hasAttribute("data-featurebase-feedback")).toBe(false);

		const signInLink = container.querySelector("button:not(:disabled)");
		expect(signInLink?.textContent).toContain("Sign in to Cline");
		signInLink?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("shows disabled button and sign-in message when clineProviderSettings is null", () => {
		act(() => {
			root.render(<FeedbackCard selectedAgentId={"cline"} clineProviderSettings={null} />);
		});

		const button = getFeedbackButton();
		expect(button).toBeTruthy();
		expect(button!.disabled).toBe(true);
		expect(button!.hasAttribute("data-featurebase-feedback")).toBe(false);
		expect(container.textContent).toContain("Sign in to Cline");
	});

	// 3. Auth detection requires oauthProvider === "cline"
	it("treats tokens without oauthProvider=cline as unauthenticated", () => {
		act(() => {
			root.render(<FeedbackCard selectedAgentId={"cline"} clineProviderSettings={tokenOnlySettings} />);
		});

		const button = getFeedbackButton();
		expect(button!.disabled).toBe(true);
		expect(button!.hasAttribute("data-featurebase-feedback")).toBe(false);
		expect(container.textContent).toContain("Sign in to Cline");
	});

	// 3b. Access token with cline provider but no refresh token => sign-in CTA (predicate alignment)
	it("shows sign-in CTA when oauthProvider=cline but refresh token is missing", () => {
		act(() => {
			root.render(<FeedbackCard selectedAgentId={"cline"} clineProviderSettings={accessOnlyNoRefreshSettings} />);
		});

		const button = getFeedbackButton();
		expect(button!.disabled).toBe(true);
		expect(button!.hasAttribute("data-featurebase-feedback")).toBe(false);
		expect(container.textContent).toContain("Sign in to Cline");
	});

	// 4. Featurebase loading => renders nothing (hidden until ready)
	it("renders nothing when pre-identify is loading", () => {
		const fbState: FeaturebaseFeedbackState = { authState: "loading", retry: vi.fn() };
		act(() => {
			root.render(
				<FeedbackCard
					selectedAgentId={"cline"}
					clineProviderSettings={authenticatedClineSettings}
					featurebaseFeedbackState={fbState}
				/>,
			);
		});

		expect(container.innerHTML).toBe("");
	});

	// 5. Featurebase idle => renders nothing
	it("renders nothing when pre-identify is idle", () => {
		const fbState: FeaturebaseFeedbackState = { authState: "idle", retry: vi.fn() };
		act(() => {
			root.render(
				<FeedbackCard
					selectedAgentId={"cline"}
					clineProviderSettings={authenticatedClineSettings}
					featurebaseFeedbackState={fbState}
				/>,
			);
		});

		expect(container.innerHTML).toBe("");
	});

	// 6. Featurebase error => renders nothing (silent degradation)
	it("renders nothing when pre-identify failed", () => {
		const retryFn = vi.fn();
		const fbState: FeaturebaseFeedbackState = { authState: "error", retry: retryFn };
		act(() => {
			root.render(
				<FeedbackCard
					selectedAgentId={"cline"}
					clineProviderSettings={authenticatedClineSettings}
					featurebaseFeedbackState={fbState}
				/>,
			);
		});

		expect(container.innerHTML).toBe("");
	});

	// 7. Featurebase ready => enabled + attribute
	it("enables the button and renders data-featurebase-feedback when pre-identify is ready", () => {
		const fbState: FeaturebaseFeedbackState = { authState: "ready", retry: vi.fn() };
		act(() => {
			root.render(
				<FeedbackCard
					selectedAgentId={"cline"}
					clineProviderSettings={authenticatedClineSettings}
					featurebaseFeedbackState={fbState}
				/>,
			);
		});

		const button = getFeedbackButton();
		expect(button!.disabled).toBe(false);
		expect(button!.hasAttribute("data-featurebase-feedback")).toBe(true);
	});

	// 8. Regression test
	it("renders the data-featurebase-feedback attribute on the Share Feedback button (regression)", () => {
		const fbState: FeaturebaseFeedbackState = { authState: "ready", retry: vi.fn() };
		act(() => {
			root.render(
				<FeedbackCard
					selectedAgentId={"cline"}
					clineProviderSettings={authenticatedClineSettings}
					featurebaseFeedbackState={fbState}
				/>,
			);
		});

		const button = getFeedbackButton();
		expect(button!.hasAttribute("data-featurebase-feedback")).toBe(true);
	});
});
