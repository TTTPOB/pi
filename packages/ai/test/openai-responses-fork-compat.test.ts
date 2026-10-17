import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Message, Model, OpenAIResponsesCompat } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const baseModel: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "test",
	id: "test-model",
	name: "Test Model",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

async function capture(messages: Message[], compat?: OpenAIResponsesCompat, headers?: Record<string, string>) {
	let payload: Record<string, unknown> | undefined;
	let requestHeaders: Headers | undefined;
	const result = await stream({ ...baseModel, compat }, normalizeContext({ messages }), {
		apiKey: "test",
		sessionId: "session-123",
		cacheRetention: "none",
		headers,
		onPayload: (value) => {
			payload = value as Record<string, unknown>;
		},
		fetch: async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		},
	}).result();
	expect(result.stopReason).toBe("stop");
	if (!payload || !requestHeaders) throw new Error("Expected a captured Responses request");
	return { payload, headers: requestHeaders };
}

const user: Message = { role: "user", content: "hello", timestamp: 1 };
const system: Message = { role: "system", content: "Be precise", sections: { rules: "Use tools" }, timestamp: 0 };

describe("Responses fork compatibility", () => {
	it.each([undefined, "input"] as const)("keeps the default input prompt format (%s)", async (format) => {
		const { payload } = await capture([system, user], { systemPromptFormat: format });
		expect(payload.instructions).toBeUndefined();
		expect(payload.input).toEqual([
			{ role: "developer", content: "Be precise\n\nUse tools" },
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
		]);
	});

	it("moves the leading prompt and sections to instructions without duplicating input", async () => {
		const tool = { name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) };
		const { payload } = await capture([{ ...system, toolsAdded: [tool] }, user], {
			systemPromptFormat: "instructions",
		});
		expect(payload.instructions).toBe("Be precise\n\nUse tools");
		expect(payload.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
		expect(payload.tools).toEqual([expect.objectContaining({ type: "function", name: "read" })]);
	});

	it("folds later system updates into instructions when mid-conversation messages are unsupported", async () => {
		const { payload } = await capture(
			[system, user, { role: "system", content: "Be brief", sections: { rules: "No tools" }, timestamp: 2 }],
			{ systemPromptFormat: "instructions" },
		);
		expect(payload.instructions).toBe("Be precise\n\nBe brief\n\nNo tools");
		expect(payload.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
	});

	it("retains later system messages and tool additions at their transcript positions", async () => {
		const tool = { name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) };
		const { payload } = await capture(
			[system, user, { role: "system", content: "Be brief", toolsAdded: [tool], timestamp: 2 }],
			{ systemPromptFormat: "instructions", supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		);
		expect(payload.instructions).toBe("Be precise\n\nUse tools");
		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ type: "additional_tools", role: "developer", tools: [expect.objectContaining({ name: "read" })] },
			{ role: "developer", content: "Be brief" },
		]);
	});

	it("sanitizes invalid surrogates in instructions", async () => {
		const { payload } = await capture([{ role: "system", content: "bad\ud800ok", timestamp: 0 }, user], {
			systemPromptFormat: "instructions",
		});
		expect(payload.instructions).toBe("badok");
	});

	it.each(
		([[], [user], [{ role: "system", content: "", timestamp: 0 }, user]] satisfies Message[][]).map((messages) => ({
			messages,
		})),
	)("omits empty instructions ($messages)", async ({ messages }) => {
		const { payload } = await capture(messages, { systemPromptFormat: "instructions" });
		expect(payload.instructions).toBeUndefined();
	});

	it.each([
		["openai", "session_id", "x-client-request-id"],
		["openai-nosession", null, "x-client-request-id"],
		["openrouter", "x-session-id", null],
	] as const)("preserves %s identity without prompt caching", async (format, sessionHeader, requestHeader) => {
		const { payload, headers } = await capture([user], {
			sessionAffinityFormat: format,
			supportsExplicitPromptCacheMode: true,
		});
		expect(headers.get("session_id")).toBe(sessionHeader === "session_id" ? "session-123" : null);
		expect(headers.get("x-session-id")).toBe(sessionHeader === "x-session-id" ? "session-123" : null);
		expect(headers.get("x-client-request-id")).toBe(requestHeader ? "session-123" : null);
		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_options).toEqual({ mode: "explicit" });
	});

	it("allows explicit identity headers to override automatic headers without caching", async () => {
		const { headers } = await capture([user], undefined, {
			session_id: "override",
			"x-client-request-id": "request",
		});
		expect(headers.get("session_id")).toBe("override");
		expect(headers.get("x-client-request-id")).toBe("request");
	});
});
