import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackCard } from "@/components/project-navigation-panel";
import type { RuntimeClineProviderSettings } from "@/runtime/types";

vi.mock("@/hooks/use-featurebase-feedback-widget", () => ({
	openFeaturebaseFeedbackWidget: vi.fn(),
}));

const authenticatedSettings: RuntimeClineProviderSettings = {
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

	it("disables the button and shows sign-in message when clineProviderSettings is null", async () => {
		await act(async () => {
			root.render(<FeedbackCard clineProviderSettings={null} />);
		});

		const button = container.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.disabled).toBe(true);
		expect(container.textContent).toContain("Sign in to Cline to share feedback");
	});

	it("disables the button and shows sign-in message when no provider is selected", async () => {
		const unauthSettings: RuntimeClineProviderSettings = {
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

		await act(async () => {
			root.render(<FeedbackCard clineProviderSettings={unauthSettings} />);
		});

		const button = container.querySelector("button");
		expect(button?.disabled).toBe(true);
		expect(container.textContent).toContain("Sign in to Cline to share feedback");
	});

	it("enables the button and hides sign-in message when provider is authenticated", async () => {
		await act(async () => {
			root.render(<FeedbackCard clineProviderSettings={authenticatedSettings} />);
		});

		const button = container.querySelector("button");
		expect(button?.disabled).toBe(false);
		expect(container.textContent).not.toContain("Sign in to Cline to share feedback");
	});

	it("renders the data-featurebase-feedback attribute on the Share Feedback button (regression)", async () => {
		await act(async () => {
			root.render(<FeedbackCard clineProviderSettings={authenticatedSettings} />);
		});

		const button = container.querySelector("button");
		expect(button).not.toBeNull();
		expect(button?.hasAttribute("data-featurebase-feedback")).toBe(true);
	});

	it("disables the button when provider is Claude with API key (non-Cline OAuth)", async () => {
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
			root.render(<FeedbackCard clineProviderSettings={claudeSettings} />);
		});

		const button = container.querySelector("button");
		expect(button?.disabled).toBe(true);
		expect(container.textContent).toContain("Sign in to Cline to share feedback");
	});

	it("disables the button when provider is OCA OAuth (non-Cline)", async () => {
		const ocaSettings: RuntimeClineProviderSettings = {
			providerId: null,
			modelId: null,
			baseUrl: null,
			apiKeyConfigured: false,
			oauthProvider: "oca",
			oauthAccessTokenConfigured: true,
			oauthRefreshTokenConfigured: true,
			oauthAccountId: "oca-acc-1",
			oauthExpiresAt: null,
		};

		await act(async () => {
			root.render(<FeedbackCard clineProviderSettings={ocaSettings} />);
		});

		const button = container.querySelector("button");
		expect(button?.disabled).toBe(true);
		expect(container.textContent).toContain("Sign in to Cline to share feedback");
	});
});
