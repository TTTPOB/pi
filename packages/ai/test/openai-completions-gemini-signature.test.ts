import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	id: "gemini-test",
	name: "Gemini Test",
	provider: "google",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(deltas: unknown[], finishReason = "tool_calls") {
	return new Response(
		[
			...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
			{ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("Gemini Chat Completions thought signatures", () => {
	// Mirrors DSH protocol-roundtrip's b235acebb2 regression: only the first parallel call is signed.
	it("receives a signature-only delta and replays it on only its original tool call", async () => {
		const signature = "gemini-signed-first-call";
		const context = normalizeContext({ messages: [{ role: "user", content: "Look up both keys", timestamp: 0 }] });
		const first = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				response([
					{
						tool_calls: [0, 1].map((index) => ({
							index,
							id: `call_${index}`,
							type: "function",
							function: { name: "lookup", arguments: JSON.stringify({ key: index }) },
						})),
					},
					{ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: signature } } }] },
					{ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: "" } } }] },
				]),
		}).result();
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "call_0",
				arguments: { key: 0 },
				thoughtSignature: signature,
			}),
			expect.objectContaining({ type: "toolCall", id: "call_1", arguments: { key: 1 } }),
		]);
		expect(first.content[1]).not.toHaveProperty("thoughtSignature");
		const snapshot = structuredClone(first);
		const onPayload = vi.fn<(payload: unknown) => void>();
		const second = await stream(
			model,
			normalizeContext({
				messages: [
					...context.messages,
					first,
					...[0, 1].map((index) => ({
						role: "toolResult" as const,
						toolCallId: `call_${index}`,
						toolName: "lookup",
						content: [{ type: "text" as const, text: `key ${index}` }],
						isError: false,
						timestamp: 1,
					})),
				],
			}),
			{ apiKey: "test", onPayload, fetch: async () => response([{ content: "done" }], "stop") },
		).result();
		expect(second.stopReason).toBe("stop");
		expect(onPayload).toHaveBeenCalledOnce();
		const payload = onPayload.mock.calls[0][0];
		expect(payload).toHaveProperty(
			"messages",
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					tool_calls: [
						{
							id: "call_0",
							type: "function",
							function: { name: "lookup", arguments: JSON.stringify({ key: 0 }) },
							extra_content: { google: { thought_signature: signature } },
						},
						{
							id: "call_1",
							type: "function",
							function: { name: "lookup", arguments: JSON.stringify({ key: 1 }) },
						},
					],
				}),
			]),
		);
		expect(first).toEqual(snapshot);
	});
});
