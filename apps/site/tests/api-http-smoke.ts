// Requires install-api openai. Uses only a local mock server; no paid API calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { apiTurn } from "../runner/api.ts";
import { parseConfig, type Profile } from "../runner/config.ts";

const requests: { url: string; authorization: string | undefined; body: any }[] = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ url: request.url!, authorization: request.headers.authorization, body });
  response.setHeader("content-type", "application/json");
  if (body.model === "fail") {
    response.writeHead(500).end(JSON.stringify({ error: { message: "mock failure" } }));
  } else if (request.url?.endsWith("/chat/completions")) {
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"text":"chat ok"}', reasoning_content: "do not publish" } }], usage: { total_tokens: 42 } }));
  } else {
    response.end(JSON.stringify({ object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"text":"responses ok"}', annotations: [] }] }], usage: { total_tokens: 5 } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const baseURL = `http://127.0.0.1:${address.port}/gateway/v1/`;
const base: Profile = { id: "http", name: "HTTP test", provider: "openai", transport: "api", enabled: true, model: "mock", apiKey: "test-local-only", baseURL, webSearch: false };
try {
  for (const provider of ["openai", "grok", "exaone", "openai-compatible"] as const) {
    const profile = parseConfig({ profiles: [{ ...base, provider }] }).profiles[0];
    const result = await apiTurn(profile, "instructions", "input", new AbortController().signal);
    const request = requests.at(-1)!;
    assert.equal(request.authorization, "Bearer test-local-only");
    if (provider === "exaone" || provider === "openai-compatible") {
      assert.equal(request.url, "/gateway/v1/chat/completions");
      assert.equal(result.text, '{"text":"chat ok"}');
      assert.equal(request.body.messages[0].content, "instructions");
      assert.equal(request.body.tools, undefined);
      assert.doesNotMatch(JSON.stringify(result), /do not publish/);
    } else {
      assert.equal(request.url, "/gateway/v1/responses");
      assert.equal(result.text, '{"text":"responses ok"}');
      assert.equal(request.body.instructions, "instructions");
    }
  }
  const beforeFailure = requests.length;
  await assert.rejects(apiTurn({ ...base, model: "fail" }, "", "", new AbortController().signal));
  assert.equal(requests.length, beforeFailure + 1, "HTTP failure must not be retried");
  await assert.rejects(apiTurn(base, "", "", AbortSignal.abort()));
  assert.equal(requests.length, beforeFailure + 1, "Aborted request must not reach the server");
  console.log("Actual OpenAI SDK: 4 provider routes, custom path/auth, no retry, cancellation verified against loopback mock.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
