import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { WebhookEvent } from "../../../src/core/api-contract.js";
import { createWebhookService } from "../../../src/webhooks/webhook-service.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createEvent(overrides?: Partial<WebhookEvent>): WebhookEvent {
	return {
		id: "evt-1",
		type: "task.created",
		timestamp: 1700000000000,
		workspaceId: "test-workspace",
		task: { id: "aaa", title: "Test task", columnId: "backlog" },
		...overrides,
	};
}

function okResponse(): Response {
	return new Response("OK", { status: 200 });
}

function failResponse(): Response {
	return new Response("Server Error", { status: 500 });
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("WebhookService — registration", () => {
	it("registers a webhook and returns it with an id", () => {
		const svc = createWebhookService();
		const result = svc.register({ url: "http://localhost:9000/hook" });
		expect(result.ok).toBe(true);
		expect(result.registration).not.toBeNull();
		expect(result.registration!.url).toBe("http://localhost:9000/hook");
		expect(result.registration!.events).toBeNull();
		expect(typeof result.registration!.id).toBe("string");
		expect(typeof result.registration!.createdAt).toBe("number");
	});

	it("registers a webhook with event filter", () => {
		const svc = createWebhookService();
		const result = svc.register({ url: "http://localhost:9000/hook", events: ["task.created", "task.completed"] });
		expect(result.ok).toBe(true);
		expect(result.registration!.events).toEqual(["task.created", "task.completed"]);
	});

	it("lists all registered webhooks", () => {
		const svc = createWebhookService();
		svc.register({ url: "http://localhost:9000/a" });
		svc.register({ url: "http://localhost:9000/b" });
		const list = svc.list();
		expect(list.registrations).toHaveLength(2);
		const urls = list.registrations.map((r) => r.url);
		expect(urls).toContain("http://localhost:9000/a");
		expect(urls).toContain("http://localhost:9000/b");
	});

	it("does not expose secrets in list or register responses", () => {
		const svc = createWebhookService();
		const result = svc.register({ url: "http://localhost:9000/hook", secret: "my-secret" });
		expect(result.registration).not.toHaveProperty("secret");
		for (const reg of svc.list().registrations) {
			expect(reg).not.toHaveProperty("secret");
		}
	});

	it("unregisters a webhook by id", () => {
		const svc = createWebhookService();
		const result = svc.register({ url: "http://localhost:9000/hook" });
		const id = result.registration!.id;
		const unregResult = svc.unregister({ id });
		expect(unregResult.ok).toBe(true);
		expect(svc.list().registrations).toHaveLength(0);
	});

	it("returns error when unregistering non-existent id", () => {
		const svc = createWebhookService();
		const result = svc.unregister({ id: "nonexistent" });
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// HTTP delivery tests
// ---------------------------------------------------------------------------

describe("WebhookService — HTTP delivery", () => {
	it("delivers events to registered webhook URLs", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/hook" });

		svc.dispatch([createEvent()]);
		await vi.waitFor(() => expect(deliverPayload).toHaveBeenCalledTimes(1));

		const [url, init] = deliverPayload.mock.calls[0]!;
		expect(url).toBe("http://localhost:9000/hook");
		expect(init.method).toBe("POST");
		expect(init.headers).toHaveProperty("Content-Type", "application/json");
		expect(init.headers).toHaveProperty("X-Kanban-Event", "task.created");
		expect(init.headers).toHaveProperty("X-Kanban-Delivery", "evt-1");
	});

	it("does not deliver events when no registrations match", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/hook", events: ["task.moved"] });

		svc.dispatch([createEvent({ type: "task.created" })]);
		await new Promise((r) => setTimeout(r, 50));
		expect(deliverPayload).not.toHaveBeenCalled();
	});

	it("signs payloads with HMAC-SHA256 when secret is provided", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/hook", secret: "test-secret" });

		svc.dispatch([createEvent()]);
		await vi.waitFor(() => expect(deliverPayload).toHaveBeenCalledTimes(1));

		const [, init] = deliverPayload.mock.calls[0]!;
		const headers = init.headers as Record<string, string>;
		const body = init.body as string;
		const expected = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
		expect(headers["X-Kanban-Signature"]).toBe(expected);
	});

	it("does not include signature header when no secret is configured", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/hook" });

		svc.dispatch([createEvent()]);
		await vi.waitFor(() => expect(deliverPayload).toHaveBeenCalledTimes(1));

		const headers = deliverPayload.mock.calls[0]![1].headers as Record<string, string>;
		expect(headers).not.toHaveProperty("X-Kanban-Signature");
	});

	it("retries once on delivery failure then warns", async () => {
		vi.useFakeTimers();
		const warn = vi.fn();
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(failResponse());
		const svc = createWebhookService({ deliverPayload, warn });
		svc.register({ url: "http://localhost:9000/hook" });

		svc.dispatch([createEvent()]);

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(deliverPayload).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toMatch(/Webhook delivery failed after retry/);

		vi.useRealTimers();
	});

	it("does not retry on successful delivery", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/hook" });

		svc.dispatch([createEvent()]);
		await vi.waitFor(() => expect(deliverPayload).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 50));
		expect(deliverPayload).toHaveBeenCalledTimes(1);
	});

	it("dispatches nothing for an empty events array", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/hook" });

		svc.dispatch([]);
		await new Promise((r) => setTimeout(r, 50));
		expect(deliverPayload).not.toHaveBeenCalled();
	});

	it("delivers to multiple registrations for the same event", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/a" });
		svc.register({ url: "http://localhost:9000/b" });

		svc.dispatch([createEvent()]);
		await vi.waitFor(() => expect(deliverPayload).toHaveBeenCalledTimes(2));

		const urls = deliverPayload.mock.calls.map(([url]) => url);
		expect(urls).toContain("http://localhost:9000/a");
		expect(urls).toContain("http://localhost:9000/b");
	});

	it("filters registrations by event type", async () => {
		const deliverPayload = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(okResponse());
		const svc = createWebhookService({ deliverPayload });
		svc.register({ url: "http://localhost:9000/created-only", events: ["task.created"] });
		svc.register({ url: "http://localhost:9000/moved-only", events: ["task.moved"] });
		svc.register({ url: "http://localhost:9000/all" });

		svc.dispatch([createEvent({ type: "task.created" })]);
		await vi.waitFor(() => expect(deliverPayload).toHaveBeenCalledTimes(2));

		const urls = deliverPayload.mock.calls.map(([url]) => url);
		expect(urls).toContain("http://localhost:9000/created-only");
		expect(urls).toContain("http://localhost:9000/all");
		expect(urls).not.toContain("http://localhost:9000/moved-only");
	});
});

// ---------------------------------------------------------------------------
// Unix socket delivery tests
// ---------------------------------------------------------------------------

describe("WebhookService — unix socket delivery", () => {
	it("delivers events to a unix socket", async () => {
		const socketPath = join(tmpdir(), `kanban-test-${randomBytes(8).toString("hex")}.sock`);
		const receivedBodies: string[] = [];
		const receivedHeaders: Record<string, string | string[] | undefined>[] = [];

		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				receivedBodies.push(body);
				receivedHeaders.push({ ...req.headers });
				res.writeHead(200);
				res.end("OK");
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(socketPath, resolve);
		});

		try {
			const svc = createWebhookService();
			svc.register({ url: `unix:${socketPath}` });
			svc.dispatch([createEvent()]);

			await vi.waitFor(() => expect(receivedBodies).toHaveLength(1), { timeout: 3_000 });

			const parsed = JSON.parse(receivedBodies[0]!) as WebhookEvent;
			expect(parsed.type).toBe("task.created");
			expect(parsed.task.id).toBe("aaa");
			expect(receivedHeaders[0]!["x-kanban-event"]).toBe("task.created");
			expect(receivedHeaders[0]!["x-kanban-delivery"]).toBe("evt-1");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});

	it("delivers events to a unix socket with a custom HTTP path", async () => {
		const socketPath = join(tmpdir(), `kanban-test-${randomBytes(8).toString("hex")}.sock`);
		const receivedPaths: string[] = [];

		const server = createServer((req, res) => {
			receivedPaths.push(req.url ?? "/");
			req.resume();
			req.on("end", () => {
				res.writeHead(200);
				res.end("OK");
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(socketPath, resolve);
		});

		try {
			const svc = createWebhookService();
			svc.register({ url: `unix:${socketPath}:/webhook/events` });
			svc.dispatch([createEvent()]);

			await vi.waitFor(() => expect(receivedPaths).toHaveLength(1), { timeout: 3_000 });
			expect(receivedPaths[0]).toBe("/webhook/events");
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});
