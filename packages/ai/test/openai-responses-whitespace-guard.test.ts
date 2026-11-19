import { readFileSync } from "node:fs";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Model, OpenAIResponsesCompat } from "../src/types.ts";
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

async function runStream(
	events: ResponseStreamEvent[],
	compat?: OpenAIResponsesCompat,
): Promise<{ result: AssistantMessage; eventTypes: string[] }> {
	mockState.events = events;
	const stream = streamOpenAIResponses({ ...createModel(), compat }, createContext(), { apiKey: "test" });
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
		const { result } = await runStream(textEvents([" ".repeat(20000), "x", " ".repeat(20000), "y"]), {
			maxRepeatedPatternChars: 0,
		});

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

function chunkText(text: string, chunkSize: number): string[] {
	const deltas: string[] = [];
	for (let i = 0; i < text.length; i += chunkSize) {
		deltas.push(text.slice(i, i + chunkSize));
	}
	return deltas;
}

function repeatPattern(pattern: string, length: number): string {
	let text = "";
	while (text.length < length) text += pattern;
	return text.slice(0, length);
}

describe("OpenAI Responses repeated-pattern guard", () => {
	it("aborts output_text deltas that repeat a short pattern", async () => {
		const text = repeatPattern("abc\n", THRESHOLD + 5000);
		const { result } = await runStream(textEvents(chunkText(text, 2048)));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Provider stream error: output item 0 had only 4 distinct 8-character sequences in its last 32768 characters (degenerate output); aborting",
		);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("aborts function_call_arguments that repeat a 90-character pattern and never completes the tool call", async () => {
		const pattern = Array.from({ length: 90 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
		const text = repeatPattern(pattern, THRESHOLD + 5000);
		const { result, eventTypes } = await runStream(functionCallEvents(chunkText(text, 2048)));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("had only 90 distinct 8-character sequences");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(eventTypes).not.toContain("toolcall_end");
		const parsedCalls = result.content.filter(
			(block) => block.type === "toolCall" && Object.keys(block.arguments).length > 0,
		);
		expect(parsedCalls).toHaveLength(0);
	});

	it("aborts a period-1 non-whitespace flood", async () => {
		const { result } = await runStream(textEvents(chunkText("}".repeat(THRESHOLD + 5000), 4096)));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("had only 1 distinct 8-character sequences");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("aborts repetition whose spacing drifts between repetitions", async () => {
		// Recorded function-call arguments: quote-and-newline filler with one to six
		// spaces per repetition, so no period ever holds for long.
		const filler = readFileSync(new URL("./data/responses-drifting-filler.txt", import.meta.url), "utf8");
		const { result, eventTypes } = await runStream(functionCallEvents(chunkText(filler, 512)), {
			maxRepeatedPatternChars: 2000,
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("8-character sequences in its last 2000 characters");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(eventTypes).not.toContain("toolcall_end");
	});

	it("aborts repetition that follows varied text", async () => {
		let varied = "";
		for (let i = 0; varied.length < 6000; i++) varied += `value_${i * 7919} = compute(${i * 104729});\n`;
		const text = `${varied}${"ab".repeat(2500)}`;
		const { result } = await runStream(textEvents(chunkText(text, 512)), { maxRepeatedPatternChars: 5000 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("8-character sequences in its last 5000 characters");
	});

	it("does not abort repetition shorter than the window that gives way to varied text", async () => {
		// 4000 repeated characters never fill the 5000-character window alone, and
		// the varied text that completes it carries more than 250 distinct sequences.
		let varied = "";
		for (let i = 0; varied.length < 6000; i++) varied += `value_${i * 7919} = compute(${i * 104729});\n`;
		const text = `${"ab".repeat(2000)}${varied}`;
		const { result } = await runStream(textEvents(chunkText(text, 512)), { maxRepeatedPatternChars: 5000 });

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("does not abort long varied content", async () => {
		let text = "";
		for (let i = 0; text.length < 200_000; i++) {
			text += `line ${i}: const value_${i * 7919} = compute(${i * 104729}, ${i % 97});\n`;
		}
		const { result } = await runStream(textEvents(chunkText(text, 4096)));

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		const block = result.content[0];
		expect(block?.type).toBe("text");
		if (block?.type === "text") expect(block.text).toBe(text);
	});

	it("does not abort repetition with more distinct sequences than the window allows", async () => {
		// A 32768-character window allows 1638 distinct sequences; this pattern has 1700.
		const pattern = Array.from({ length: 1700 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("");
		const text = repeatPattern(pattern, THRESHOLD + 5000);
		const { result } = await runStream(textEvents(chunkText(text, 2048)));

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		const block = result.content[0];
		expect(block?.type).toBe("text");
		if (block?.type === "text") expect(block.text).toBe(text);
	});
});
describe("OpenAI Responses configurable degenerate-output limits", () => {
	it.each([THRESHOLD, 5000])("aborts whitespace exactly at %i characters", async (limit) => {
		const compat = limit === THRESHOLD ? undefined : { maxConsecutiveWhitespaceChars: limit };
		const below = await runStream(textEvents([" ".repeat(limit - 1)]), compat);
		expect(below.result.stopReason).toBe("stop");
		const at = await runStream(textEvents([" ".repeat(limit - 1), " "]), compat);
		expect(at.result.stopReason).toBe("error");
		expect(at.result.errorMessage).toContain(`${limit} consecutive whitespace characters`);
	});

	it.each([THRESHOLD, 5000])("aborts repetition exactly at %i characters", async (limit) => {
		const compat = limit === THRESHOLD ? undefined : { maxRepeatedPatternChars: limit };
		const text = repeatPattern("abc", limit);
		const below = await runStream(textEvents([text.slice(0, -1)]), compat);
		expect(below.result.stopReason).toBe("stop");
		const at = await runStream(textEvents([text.slice(0, -1), text.slice(-1)]), compat);
		expect(at.result.stopReason).toBe("error");
		expect(at.result.errorMessage).toContain(
			`had only 3 distinct 8-character sequences in its last ${limit} characters`,
		);
	});

	it("distinguishes varied and periodic text with a window shorter than one fragment", async () => {
		const compat = { maxRepeatedPatternChars: 6 };
		const varied = await runStream(textEvents(["abcdefg"]), compat);
		expect(varied.result.stopReason).toBe("stop");
		const periodic = await runStream(textEvents(["aba", "bab"]), compat);
		expect(periodic.result.errorMessage).toContain("pattern for 6 characters");
	});

	it("accumulates whitespace across deltas and resets at non-whitespace within a delta", async () => {
		const compat = { maxConsecutiveWhitespaceChars: 5, maxRepeatedPatternChars: 0 };
		const below = await runStream(textEvents(["  ", "  x  ", "  "]), compat);
		expect(below.result.stopReason).toBe("stop");
		const at = await runStream(textEvents(["  ", "  x  ", "  ", " "]), compat);
		expect(at.result.errorMessage).toContain("5 consecutive whitespace characters");
	});

	it("disables only whitespace detection when its limit is zero", async () => {
		const { result } = await runStream(textEvents([" ".repeat(THRESHOLD)]), {
			maxConsecutiveWhitespaceChars: 0,
		});
		expect(result.errorMessage).toContain("had only 1 distinct 8-character sequences in its last 32768 characters");
	});

	it("disables only repeated-pattern detection when its limit is zero", async () => {
		const compat = { maxRepeatedPatternChars: 0 };
		const repeated = await runStream(textEvents(["x".repeat(THRESHOLD + 1)]), compat);
		expect(repeated.result.stopReason).toBe("stop");
		const whitespace = await runStream(textEvents([" ".repeat(THRESHOLD)]), compat);
		expect(whitespace.result.errorMessage).toContain("32768 consecutive whitespace characters");
	});

	it("allows both floods when both limits are zero", async () => {
		const { result } = await runStream(textEvents([" ".repeat(THRESHOLD + 1), "x".repeat(THRESHOLD + 1)]), {
			maxConsecutiveWhitespaceChars: 0,
			maxRepeatedPatternChars: 0,
		});
		expect(result.stopReason).toBe("stop");
	});
});
