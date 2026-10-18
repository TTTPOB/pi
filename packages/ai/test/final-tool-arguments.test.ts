import type * as BedrockSdk from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPi } from "../src/api/pi-messages.ts";
import type { Api, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
	const original = await importOriginal<typeof BedrockSdk>();
	return {
		...original,
		BedrockRuntimeClient: class {
			middlewareStack = { add: () => undefined };
			async send() {
				return {
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield { messageStart: { role: "assistant" } };
						yield {
							contentBlockStart: {
								contentBlockIndex: 0,
								start: { toolUse: { toolUseId: "call_1", name: "read" } },
							},
						};
						yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":' } } } };
						yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"file.txt"}' } } } };
						yield { contentBlockStop: { contentBlockIndex: 0 } };
						yield { messageStop: { stopReason: "tool_use" } };
					})(),
				};
			}
		},
	};
});

const context = normalizeContext({ messages: [{ role: "user", content: "Read file.txt", timestamp: 0 }] });
const finalArguments = { path: "file.txt" };
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		api,
		id: "test-model",
		name: "Test Model",
		provider: "test",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function response(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function recordDeltaArguments(): unknown[] {
	const snapshots: unknown[] = [];
	const push = AssistantMessageEventStream.prototype.push;
	vi.spyOn(AssistantMessageEventStream.prototype, "push").mockImplementation(function (
		this: AssistantMessageEventStream,
		event: AssistantMessageEvent,
	) {
		if (event.type === "toolcall_delta") {
			const block = event.partial.content[event.contentIndex];
			if (block.type === "toolCall") snapshots.push(structuredClone(block.arguments));
		}
		return push.call(this, event);
	});
	return snapshots;
}

function chatEvents() {
	return [
		{
			choices: [
				{
					index: 0,
					finish_reason: null,
					delta: {
						tool_calls: [
							{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } },
						],
					},
				},
			],
		},
		{
			choices: [
				{
					index: 0,
					finish_reason: null,
					delta: { tool_calls: [{ index: 0, function: { arguments: '"file.txt"}' } }] },
				},
			],
		},
		{ choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
	];
}

afterEach(() => vi.restoreAllMocks());

describe("DSH final JSON tool arguments", () => {
	it.each(["completions", "mistral"] as const)("does not parse %s arguments during deltas", async (api) => {
		const snapshots = recordDeltaArguments();
		const fetch = async () => response(chatEvents());
		const result = await (api === "completions"
			? streamCompletions(model("openai-completions"), context, { apiKey: "test", fetch })
			: streamMistral(model("mistral-conversations"), context, { apiKey: "test", fetch })
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(snapshots).toEqual([{}, {}]);
		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: finalArguments });
	});

	it("does not parse Responses arguments during deltas and retains the final authoritative arguments", async () => {
		const snapshots = recordDeltaArguments();
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" };
		const result = await streamResponses(model("openai-responses"), context, {
			apiKey: "test",
			fetch: async () =>
				response([
					{ type: "response.output_item.added", output_index: 0, item },
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '"file.txt"}' },
					{
						type: "response.function_call_arguments.done",
						output_index: 0,
						arguments: JSON.stringify(finalArguments),
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { ...item, arguments: '{"path":"authoritative.txt"}' },
					},
					{ type: "response.completed", response: { status: "completed" } },
				]),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(snapshots).toEqual([{}, {}]);
		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: { path: "authoritative.txt" } });
		expect(result.content[0]).not.toHaveProperty("partialJson");
	});

	it("uses the pi-messages toolcall_end arguments without parsing deltas", async () => {
		const snapshots = recordDeltaArguments();
		const result = await streamPi(model("pi-messages"), context, {
			apiKey: "test",
			fetch: async () =>
				response([
					{ type: "start" },
					{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" },
					{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' },
					{ type: "toolcall_delta", contentIndex: 0, delta: '"file.txt"}' },
					{
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: finalArguments },
					},
					{ type: "done", reason: "toolUse", usage },
				]),
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(snapshots).toEqual([{}, {}]);
		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: finalArguments });
	});

	it("parses Bedrock arguments only at contentBlockStop", async () => {
		const snapshots = recordDeltaArguments();
		const result = await streamBedrock(model("bedrock-converse-stream"), context, {
			region: "us-east-1",
			cacheRetention: "none",
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(snapshots).toEqual([{}, {}]);
		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: finalArguments });
	});
});
