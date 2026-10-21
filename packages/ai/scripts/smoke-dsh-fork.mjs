import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const patched = process.argv[2] === "patched";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai")), "utf8"));
assert.equal(version, patched ? "1.1.0-fork2" : "1.1.0");
const require = createRequire(import.meta.url);
const adapterRequire = createRequire(require.resolve("@deepseek-ai/dsh-llm-pi-ai"));
const piEntry = "@earendil-works/pi-ai/api/openai-completions";
const esmResolveOptions = { conditions: new Set(["import", "node", "default"]) };
assert.equal(adapterRequire.resolve(piEntry, esmResolveOptions), require.resolve(piEntry, esmResolveOptions));
const context = normalizeContext({ systemPrompt: "Be precise", messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const model = {
	id: "test", name: "Test", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
	reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
	headers: { "content-type": "text/event-stream" },
});
const deltas = [];
const stream = completions(model, context, {
	apiKey: "test",
	onProviderStreamEvent: async () => { await setImmediate(); },
	fetch: async () => sse([
		{ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] } }] },
		{ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, function: { arguments: '"file.txt"}' } }] } }] },
		{ choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
	]),
});
for await (const event of stream) {
	if (event.type === "toolcall_delta") deltas.push(structuredClone(event.partial.content[event.contentIndex].arguments));
}
const result = await stream.result();
assert.equal(result.stopReason, "toolUse");
assert.deepEqual(result.content[0].arguments, { path: "file.txt" });
assert.deepEqual(deltas, patched ? [{}, {}] : [{}, { path: "file.txt" }]);
let payload;
let headers;
const responseResult = await responses({ ...model, api: "openai-responses", compat: { systemPromptFormat: "instructions" } }, context, {
	apiKey: "test", cacheRetention: "none", sessionId: "session-123",
	onPayload: (value) => { payload = value; },
	fetch: async (_input, init) => {
		headers = new Headers(init.headers);
		return sse([{ type: "response.completed", response: { status: "completed" } }]);
	},
}).result();
assert.equal(responseResult.stopReason, "stop");
assert.equal(payload.prompt_cache_key, undefined);
assert.equal(payload.instructions, patched ? "Be precise" : undefined);
assert.equal(headers.get("session_id"), patched ? "session-123" : null);
assert.equal(headers.get("x-client-request-id"), patched ? "session-123" : null);
assert.equal(payload.input.filter((message) => message.role === "system").length, patched ? 0 : 1);
console.log(JSON.stringify({ version, patched, piResolvedFromAdapter: adapterRequire.resolve(piEntry, esmResolveOptions), deltaArguments: deltas, instructions: payload.instructions ?? null, sessionHeader: headers.get("session_id"), cacheKey: payload.prompt_cache_key ?? null }, null, 2));
