import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// One output item may not accumulate this many consecutive trailing whitespace
// characters before the Responses parser aborts the stream.
const THRESHOLD = 32 * 1024;

// vi.mock factories are hoisted, so the event list lives in a hoisted object that
// each test fills in before starting the stream.
const mockState = vi.hoisted(() => ({ events: [] as ResponseStreamEvent[] }));

vi.mock("openai", () => {
	async function* createMockResponsesStream(): AsyncIterable<ResponseStreamEvent> {
		yield* mockState.events;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createMockResponsesStream();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createContext() {
	return normalizeContext({
		systemPrompt: "",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
		tools: [],
	});
}

function splitWhitespace(total: number, chunkSize: number): string[] {
	const deltas: string[] = [];
	let remaining = total;
	while (remaining > 0) {
		const size = Math.min(chunkSize, remaining);
		deltas.push(" ".repeat(size));
		remaining -= size;
	}
	return deltas;
}

function textEvents(deltas: readonly string[]): ResponseStreamEvent[] {
	const events: ResponseStreamEvent[] = [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_ws" },
		} as ResponseStreamEvent,
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
		} as ResponseStreamEvent,
	];
	let sequence = 2;
	for (const delta of deltas) {
		events.push({
			type: "response.output_text.delta",
			sequence_number: sequence++,
			output_index: 0,
			content_index: 0,
			item_id: "msg_ws",
			delta,
			logprobs: [],
		} as unknown as ResponseStreamEvent);
	}
	events.push({
		type: "response.completed",
		sequence_number: sequence,
		response: { id: "resp_ws", status: "completed" },
	} as ResponseStreamEvent);
	return events;
}

function functionCallEvents(deltas: readonly string[]): ResponseStreamEvent[] {
	const events: ResponseStreamEvent[] = [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_ws_tool" },
		} as ResponseStreamEvent,
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "bash", arguments: "" },
		} as ResponseStreamEvent,
	];
	let sequence = 2;
	for (const delta of deltas) {
		events.push({
			type: "response.function_call_arguments.delta",
			sequence_number: sequence++,
			output_index: 0,
			item_id: "fc_ws",
			delta,
		} as ResponseStreamEvent);
	}
	events.push({
		type: "response.completed",
		sequence_number: sequence,
		response: { id: "resp_ws_tool", status: "completed" },
	} as ResponseStreamEvent);
	return events;
}

async function runStream(events: ResponseStreamEvent[]): Promise<{ result: AssistantMessage; eventTypes: string[] }> {
	mockState.events = events;
	const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test" });
	const eventTypes: string[] = [];
	for await (const event of stream) eventTypes.push(event.type);
	return { result: await stream.result(), eventTypes };
}

describe("OpenAI Responses consecutive whitespace guard", () => {
	it("aborts output_text deltas that accumulate the whitespace threshold", async () => {
		const { result } = await runStream(textEvents(splitWhitespace(THRESHOLD + 4096, 4096)));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Provider stream error: output item 0 emitted 32768 consecutive whitespace characters (degenerate output); aborting",
		);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("aborts function_call_arguments deltas and never completes the tool call", async () => {
		const { result, eventTypes } = await runStream(functionCallEvents(splitWhitespace(THRESHOLD + 2048, 2048)));

		expect(result.stopReason).toBe("error");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(eventTypes).not.toContain("toolcall_end");
		const parsedCalls = result.content.filter(
			(block) => block.type === "toolCall" && Object.keys(block.arguments).length > 0,
		);
		expect(parsedCalls).toHaveLength(0);
	});

	it("resets the run when non-whitespace interrupts it", async () => {
		// 20000 spaces on both sides of a letter: 40000 whitespace chars in total,
		// but no single consecutive run reaches the threshold.
		const { result } = await runStream(textEvents([" ".repeat(20000), "x", " ".repeat(20000), "y"]));

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toHaveLength(1);
		const block = result.content[0];
		expect(block?.type).toBe("text");
		if (block?.type === "text") expect(block.text).toHaveLength(40002);
	});

	it("does not abort long normal content", async () => {
		const deltas: string[] = [];
		for (let i = 0; i < 400; i++) deltas.push(`paragraph ${i} of ordinary model output. `);
		const { result } = await runStream(textEvents(deltas));

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		const block = result.content[0];
		expect(block?.type).toBe("text");
		if (block?.type === "text") expect(block.text).toBe(deltas.join(""));
	});
});
