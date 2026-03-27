import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackCard } from "@/components/project-navigation-panel";
import type { RuntimeClineProviderSettings } from "@/runtime/types";

vi.mock("@/hooks/use-featurebase-feedback-widget", () => ({
	openFeaturebaseFeedbackWidget: vi.fn(),
}));

const authenticatedClineSettings: RuntimeClineProviderSettings = {
	providerId: null,
	modelId: null,
	baseUrl: null,
	apiKeyConfigured: false,
	oauthProvider: "cline",
	oauthAccessTokenConfigured: true,
	oauthRefreshTokenConfigured: true,
	oauthAccountId: "acc-1",
	oauthExpiresAt: null,
};

const unauthenticatedClineSettings: RuntimeClineProviderSettings = {
	providerId: null,
	modelId: null,
	baseUrl: null,
	apiKeyConfigured: false,
	oauthProvider: "cline",
	oauthAccessTokenConfigured: false,
	oauthRefreshTokenConfigured: false,
	oauthAccountId: null,
	oauthExpiresAt: null,
};

describe("FeedbackCard", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.clearAllMocks();
	});

	// ── Non-Cline provider: renders nothing ──

	it("renders nothing when selected agent is not Cline (Claude API key)", async () => {
		const claudeSettings: RuntimeClineProviderSettings = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			baseUrl: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		};

		await act(async () => {
			root.render(<FeedbackCard selectedAgentId="claude-code" clineProviderSettings={claudeSettings} />);
		});

		expect(container.querySelector("button")).toBeNull();
		expect(container.textContent).not.toContain("Share Feedback");
		expect(container.textContent).not.toContain("Sign in to Cline to share feedback");
	});

	it("renders nothing when selectedAgentId is null", async () => {
		await act(async () => {
			root.render(<FeedbackCard selectedAgentId={null} clineProviderSettings={authenticatedClineSettings} />);
		});

		expect(container.querySelector("button")).toBeNull();
		expect(container.textContent).not.toContain("Share Feedback");
		expect(container.textContent).not.toContain("Sign in to Cline to share feedback");
	});

	// ── Cline provider, not signed in: disabled + sign-in message ──

	it("shows disabled button and sign-in message when Cline agent is selected but not authenticated", async () => {
		await act(async () => {
			root.render(<FeedbackCard selectedAgentId="cline" clineProviderSettings={unauthenticatedClineSettings} />);
		});

		const button = container.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.disabled).toBe(true);
		expect(container.textContent).toContain("Share Feedback");
		expect(container.textContent).toContain("Sign in to Cline to share feedback");
	});

	it("shows disabled button and sign-in message when Cline agent is selected and clineProviderSettings is null", async () => {
		await act(async () => {
			root.render(<FeedbackCard selectedAgentId="cline" clineProviderSettings={null} />);
		});

		const button = container.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.disabled).toBe(true);
		expect(container.textContent).toContain("Sign in to Cline to share feedback");
	});

	// ── Cline provider, signed in: enabled ──

	it("enables the button and hides sign-in message when Cline agent is selected and authenticated", async () => {
		await act(async () => {
			root.render(<FeedbackCard selectedAgentId="cline" clineProviderSettings={authenticatedClineSettings} />);
		});

		const button = container.querySelector("button");
		expect(button?.disabled).toBe(false);
		expect(container.textContent).toContain("Share Feedback");
		expect(container.textContent).not.toContain("Sign in to Cline to share feedback");
	});

	// ── Regression: data-featurebase-feedback attribute ──

	it("renders the data-featurebase-feedback attribute on the Share Feedback button (regression)", async () => {
		await act(async () => {
			root.render(<FeedbackCard selectedAgentId="cline" clineProviderSettings={authenticatedClineSettings} />);
		});

		const button = container.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.hasAttribute("data-featurebase-feedback")).toBe(true);
	});
});
