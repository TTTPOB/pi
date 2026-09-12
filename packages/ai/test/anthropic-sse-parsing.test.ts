import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, ToolCall } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => response,
				}),
			},
		},
	} as unknown as Anthropic;
}

type ToolCallObservation = {
	rawDeltas: string[];
	partialArguments: Array<Record<string, unknown>>;
	toolCallEndArguments?: Record<string, unknown>;
	resultArguments?: Record<string, unknown>;
};

function createToolCallResponse(): Response {
	const usage = {
		input_tokens: 1,
		output_tokens: 2,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	return createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({ type: "message_start", message: { id: "msg_tool", usage } }),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_read", name: "read", input: {} },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"path":"a' },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '.txt"}' },
			}),
		},
		{
			event: "content_block_stop",
			data: JSON.stringify({ type: "content_block_stop", index: 0 }),
		},
		{
			event: "message_delta",
			data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage }),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

async function observeAnthropicToolCall(toolCallParsing?: "partial" | "final"): Promise<ToolCallObservation> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const context: Context = {
		messages: [{ role: "user", content: "Use the read tool.", timestamp: Date.now() }],
		tools: [
			{
				name: "read",
				description: "Read a file.",
				parameters: Type.Object({ path: Type.String() }),
			},
		],
	};
	const eventStream = streamAnthropic(model, context, {
		client: createFakeAnthropicClient(createToolCallResponse()),
		toolCallParsing,
	});
	const rawDeltas: string[] = [];
	const partialArguments: Array<Record<string, unknown>> = [];
	let toolCallEndArguments: Record<string, unknown> | undefined;

	for await (const event of eventStream) {
		if (event.type === "toolcall_delta") {
			rawDeltas.push(event.delta);
			const block = event.partial.content[event.contentIndex];
			if (block?.type === "toolCall") {
				partialArguments.push(structuredClone(block.arguments));
			}
		} else if (event.type === "toolcall_end") {
			toolCallEndArguments = structuredClone(event.toolCall.arguments);
		}
	}

	const result = await eventStream.result();
	const resultToolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
	return {
		rawDeltas,
		partialArguments,
		toolCallEndArguments,
		resultArguments: resultToolCall?.arguments,
	};
}

describe("Anthropic raw SSE parsing", () => {
	it("fails safely when Anthropic falls back after output begins", async () => {
		const model = getModel("anthropic", "claude-opus-5");
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_fallback",
						model: "claude-opus-5",
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "partial" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "fallback",
						from: { model: "claude-opus-5" },
						to: { model: "claude-opus-4-8" },
					},
				}),
			},
		]);

		const result = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ client: createFakeAnthropicClient(response) },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unsupported mid-output model fallback");
	});

	it("forces streaming after an onPayload replacement", async () => {
		let streaming: boolean | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: { stream?: boolean }) => {
						streaming = params.stream;
						return { asResponse: async () => createSseResponse(minimalAnthropicEvents) };
					},
				},
			},
		} as unknown as Anthropic;

		await streamAnthropic(
			getModel("anthropic", "claude-fable-5-1"),
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				client,
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), stream: false }),
			},
		).result();

		expect(streaming).toBe(true);
	});

	it("omits the interleaved-thinking beta when thinking is disabled", async () => {
		let betaFeatures: string[] | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: { betas?: string[] }) => {
						betaFeatures = params.betas;
						return { asResponse: async () => createSseResponse(minimalAnthropicEvents) };
					},
				},
			},
		} as unknown as Anthropic;

		await streamAnthropic(
			getModel("openrouter", "anthropic/claude-3-haiku"),
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ client, thinkingEnabled: false },
		).result();

		expect(betaFeatures ?? []).not.toContain("interleaved-thinking-2025-05-14");
	});

	it("passes managed beta features to injected clients", async () => {
		let betaFeatures: string[] | undefined;
		const client = {
			beta: {
				messages: {
					create: (params: { betas?: string[] }) => {
						betaFeatures = params.betas;
						return { asResponse: async () => createSseResponse(minimalAnthropicEvents) };
					},
				},
			},
		} as unknown as Anthropic;

		const result = await streamAnthropic(
			getModel("anthropic", "claude-fable-5-1"),
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ client },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(betaFeatures).toContain("mid-conversation-output-config-2026-07-01");
		expect(betaFeatures).toContain("thinking-binding-controls-2026-08-01");
	});

	it("uses the serving model input transformations from the final stream event", async () => {
		const events = minimalAnthropicEvents.map((event) => ({ ...event }));
		events[0].data = JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_transformations",
				model: "claude-fable-5-1",
				usage: { input_tokens: 12, output_tokens: 0 },
				input_transformations: [
					{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
				],
			},
		});
		const delta = JSON.parse(events[4].data) as Record<string, unknown>;
		delta.input_transformations = [
			{ type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
		];
		events[4].data = JSON.stringify(delta);

		const result = await streamAnthropic(
			getModel("anthropic", "claude-fable-5-1"),
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ client: createFakeAnthropicClient(createSseResponse(events)) },
		).result();

		expect(result.diagnostics).toEqual([
			{
				type: "anthropic_input_transformations",
				timestamp: expect.any(Number),
				details: {
					transformations: [
						{
							type: "thinking_dropped",
							path: "messages.3.content.0",
							reason: "model_binding_mismatch",
						},
					],
				},
			},
		]);
	});
	it("keeps streamed argument chunks ordered and parses them at tool-call end", async () => {
		const observation = await observeAnthropicToolCall("final");

		expect(observation.rawDeltas).toEqual(['{"path":"a', '.txt"}']);
		expect(observation.partialArguments).toEqual([{}, {}]);
		expect(observation.toolCallEndArguments).toEqual({ path: "a.txt" });
		expect(observation.resultArguments).toEqual({ path: "a.txt" });
	});

	it("updates partial tool arguments while the stream is in progress by default", async () => {
		const observation = await observeAnthropicToolCall();

		expect(observation.partialArguments).toEqual([{ path: "a" }, { path: "a.txt" }]);
	});

	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		};

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("preserves content from content_block_start events", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_initial_content",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "Initial text" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: " plus delta" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "thinking",
						thinking: "Initial thinking",
						signature: "initial signature",
					},
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "thinking_delta", thinking: " plus delta" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "signature_delta", signature: " plus delta" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.content).toEqual([
			{ type: "text", text: "Initial text plus delta" },
			{
				type: "thinking",
				thinking: "Initial thinking plus delta",
				thinkingSignature: "initial signature plus delta",
			},
		]);
	});

	it("preserves refusal stop details from message_delta", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const context: Context = {
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		};
		const explanation =
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, provide feedback, or request an exemption based on how you use Claude, visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_01XFUDYJgAACzvnptvVoYEL",
						usage: {
							input_tokens: 412,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: {
						stop_reason: "refusal",
						stop_details: {
							type: "refusal",
							category: "cyber",
							explanation,
						},
					},
					usage: {
						input_tokens: 412,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("refusal");
		expect(result.errorMessage).toBe(explanation);
	});

	it("preserves sensitive stop reasons with a descriptive error message", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_sensitive",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "sensitive" },
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.rawStopReason).toBe("sensitive");
		expect(result.errorMessage).toBe("Provider stopped with: sensitive");
	});

	it("treats message_delta without usage as a no-op for usage accumulation", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse(
			minimalAnthropicEvents.map((event) =>
				event.event === "message_delta"
					? {
							event: "message_delta",
							data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
						}
					: event,
			),
		);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.totalTokens).toBe(12);
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
