// Copy this script into an isolated tarball consumer before running it.
import assert from "node:assert/strict";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { getModel } from "@earendil-works/pi-ai/compat";

let requests = 0;
for (const sessionAffinityFormat of ["openai", "openai-nosession", "openrouter"]) {
	const model = {
		...getModel("openai", "gpt-5.4"),
		provider: "offline-gateway",
		baseUrl: "http://gateway.invalid/v1",
		compat: { sessionAffinityFormat },
	};
	for (const cacheRetention of ["short", "none"]) {
		for (const sessionId of ["fork-a", "fork-b"]) {
			const result = await stream(
				model,
				{ messages: [{ role: "user", content: "same fork history", timestamp: 0 }] },
				{
					apiKey: "offline-test-key",
					sessionId,
					cacheRetention,
					maxRetries: 0,
					fetch: async (_input, init) => {
						const headers = new Headers(init.headers);
						const payload = JSON.parse(init.body);
						const identityHeader = sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-client-request-id";
						assert.equal(headers.get(identityHeader), sessionId);
						assert.equal(headers.get("session_id"), sessionAffinityFormat === "openai" ? sessionId : null);
						assert.equal(payload.prompt_cache_key, cacheRetention === "none" ? undefined : sessionId);
						assert.equal(Object.hasOwn(payload, "session_id"), false);
						requests++;
						return new Response(
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				},
			).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
		}
	}
}
assert.equal(requests, 12);
console.log(`Packed Pi AI session identity smoke passed: ${requests} requests.`);
