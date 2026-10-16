import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Model, OpenAIResponsesCompat } from "../src/types.ts";

describe("Responses client session identity", () => {
	it.each(["openai", "openai-nosession", "openrouter"] as const)(
		"keeps fork IDs independent of cache retention with %s affinity",
		async (sessionAffinityFormat: NonNullable<OpenAIResponsesCompat["sessionAffinityFormat"]>) => {
			const model: Model<"openai-responses"> = {
				...getModel("openai", "gpt-5.4"),
				provider: "claude-gateway",
				baseUrl: "http://gateway.invalid/v1",
				compat: { sessionAffinityFormat },
			};
			const captured: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				captured.push({ headers: new Headers(init?.headers), payload: JSON.parse(String(init?.body)) });
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			};

			for (const cacheRetention of ["short", "none"] as const) {
				for (const sessionId of ["fork-local-a", "fork-local-b"]) {
					const result = await stream(
						model,
						{ messages: [{ role: "user", content: "same fork history", timestamp: 0 }] },
						{ apiKey: "offline-test-key", sessionId, cacheRetention, fetch, maxRetries: 0 },
					).result();
					expect(result.stopReason).toBe("stop");
					const request = captured.at(-1);
					expect(request).toBeDefined();
					const header = sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-client-request-id";
					expect(request?.headers.get(header)).toBe(sessionId);
					expect(request?.headers.get("session_id")).toBe(sessionAffinityFormat === "openai" ? sessionId : null);
					expect(request?.payload).not.toHaveProperty("session_id");
					if (cacheRetention === "none") expect(request?.payload).not.toHaveProperty("prompt_cache_key");
					else expect(request?.payload.prompt_cache_key).toBe(sessionId);
				}
			}
			expect(captured).toHaveLength(4);
		},
	);

	it.each([false, true])(
		"replays encrypted reasoning only for the same source (sameSource=%s)",
		async (sameSource) => {
			const model: Model<"openai-responses"> = {
				...getModel("openai", "gpt-5.4"),
				id: "claude-sonnet-4-6",
				provider: "claude-gateway",
				baseUrl: "http://gateway.invalid/v1",
			};
			const reasoning = ["visible", "redacted", "empty"].map((id) => ({
				type: "reasoning",
				id: `rs_${id}`,
				summary: [],
				encrypted_content: `opaque-ciphertext-${id}`,
			}));
			const assistant: AssistantMessage = {
				role: "assistant",
				api: sameSource ? model.api : "anthropic-messages",
				provider: sameSource ? model.provider : "other-provider",
				model: sameSource ? model.id : "other-model",
				content: [
					{
						type: "thinking",
						thinking: "Visible reasoning summary",
						thinkingSignature: JSON.stringify(reasoning[0]),
					},
					{
						type: "thinking",
						thinking: "Redacted content must not migrate",
						thinkingSignature: JSON.stringify(reasoning[1]),
						redacted: true,
					},
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning[2]) },
					{ type: "text", text: "Visible answer", textSignature: "foreign-message-signature" },
				],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			};
			let payload: { input: Array<Record<string, unknown>> } | undefined;
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				payload = JSON.parse(String(init?.body));
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			const result = await stream(
				model,
				{ messages: [assistant, { role: "user", content: "Continue", timestamp: 1 }] },
				{ apiKey: "offline-test-key", cacheRetention: "none", fetch, maxRetries: 0 },
			).result();
			expect(result.stopReason).toBe("stop");
			expect(payload).toBeDefined();
			const items = payload?.input ?? [];
			if (sameSource) {
				expect(items.filter((item) => item.type === "reasoning")).toEqual(reasoning);
			} else {
				expect(items.filter((item) => item.type === "reasoning")).toEqual([]);
				expect(items.filter((item) => item.role === "assistant").map((item) => item.content)).toEqual([
					[{ type: "output_text", text: "Visible reasoning summary", annotations: [] }],
					[{ type: "output_text", text: "Visible answer", annotations: [] }],
				]);
				const serialized = JSON.stringify(payload);
				expect(serialized).not.toContain("encrypted_content");
				expect(serialized).not.toContain("opaque-ciphertext");
				expect(serialized).not.toContain("Redacted content must not migrate");
				expect(serialized).not.toContain("foreign-message-signature");
			}
		},
	);
});
