import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Context, ToolCall } from "../src/types.ts";

type ToolCallObservation = {
	rawDeltas: string[];
	partialArguments: Array<{ contentIndex: number; arguments: Record<string, unknown> }>;
	toolCallEndArguments: Array<{ contentIndex: number; arguments: Record<string, unknown> }>;
	resultArguments: Array<Record<string, unknown>>;
};

function createResponsesSseResponse(events: readonly Record<string, unknown>[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createToolCallEvents(): Record<string, unknown>[] {
	return [
		{
			type: "response.output_item.added",
			sequence_number: 0,
			output_index: 0,
			item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: "" },
		},
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 1,
			item: { type: "function_call", id: "fc_write", call_id: "call_write", name: "write", arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			sequence_number: 2,
			output_index: 0,
			item_id: "fc_read",
			delta: '{"path":"in',
		},
		{
			type: "response.function_call_arguments.delta",
			sequence_number: 3,
			output_index: 1,
			item_id: "fc_write",
			delta: '{"path":"out',
		},
		{
			type: "response.function_call_arguments.delta",
			sequence_number: 4,
			output_index: 0,
			item_id: "fc_read",
			delta: '.txt"}',
		},
		{
			type: "response.function_call_arguments.delta",
			sequence_number: 5,
			output_index: 1,
			item_id: "fc_write",
			delta: '.txt"}',
		},
		{
			type: "response.function_call_arguments.done",
			sequence_number: 6,
			output_index: 0,
			item_id: "fc_read",
			arguments: '{"path":"in.txt"}',
		},
		{
			type: "response.function_call_arguments.done",
			sequence_number: 7,
			output_index: 1,
			item_id: "fc_write",
			arguments: '{"path":"out.txt"}',
		},
		{
			type: "response.output_item.done",
			sequence_number: 8,
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_read",
				call_id: "call_read",
				name: "read",
				arguments: '{"path":"in.txt"}',
			},
		},
		{
			type: "response.output_item.done",
			sequence_number: 9,
			output_index: 1,
			item: {
				type: "function_call",
				id: "fc_write",
				call_id: "call_write",
				name: "write",
				arguments: '{"path":"out.txt"}',
			},
		},
		{
			type: "response.completed",
			sequence_number: 10,
			response: { id: "resp_tools", status: "completed", output: [] },
		},
	];
}

async function observeResponsesToolCall(): Promise<ToolCallObservation & { stopReason: string }> {
	const model = getModel("openai", "gpt-5.4");
	const context: Context = {
		messages: [{ role: "user", content: "Read in.txt and write out.txt.", timestamp: Date.now() }],
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String() }),
			},
		],
	};
	vi.spyOn(globalThis, "fetch").mockResolvedValue(createResponsesSseResponse(createToolCallEvents()));

	const eventStream = streamOpenAIResponses(model, context, { apiKey: "test", toolCallParsing: "final" });
	const rawDeltas: string[] = [];
	const partialArguments: Array<{ contentIndex: number; arguments: Record<string, unknown> }> = [];
	const toolCallEndArguments: Array<{ contentIndex: number; arguments: Record<string, unknown> }> = [];

	for await (const event of eventStream) {
		if (event.type === "toolcall_delta") {
			rawDeltas.push(event.delta);
			const block = event.partial.content[event.contentIndex];
			if (block?.type === "toolCall") {
				partialArguments.push({ contentIndex: event.contentIndex, arguments: structuredClone(block.arguments) });
			}
		} else if (event.type === "toolcall_end") {
			toolCallEndArguments.push({
				contentIndex: event.contentIndex,
				arguments: structuredClone(event.toolCall.arguments),
			});
		}
	}

	const result = await eventStream.result();
	return {
		rawDeltas,
		partialArguments,
		toolCallEndArguments,
		resultArguments: result.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map((block) => block.arguments),
		stopReason: result.stopReason,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenAI Responses tool argument parsing", () => {
	it("keeps interleaved argument deltas ordered and parses each call at output-item end", async () => {
		const observation = await observeResponsesToolCall();

		expect(observation.rawDeltas).toEqual(['{"path":"in', '{"path":"out', '.txt"}', '.txt"}']);
		expect(observation.partialArguments).toEqual([
			{ contentIndex: 0, arguments: {} },
			{ contentIndex: 1, arguments: {} },
			{ contentIndex: 0, arguments: {} },
			{ contentIndex: 1, arguments: {} },
		]);
		expect(observation.toolCallEndArguments).toEqual([
			{ contentIndex: 0, arguments: { path: "in.txt" } },
			{ contentIndex: 1, arguments: { path: "out.txt" } },
		]);
		expect(observation.resultArguments).toEqual([{ path: "in.txt" }, { path: "out.txt" }]);
		expect(observation.stopReason).toBe("toolUse");
	});
});
