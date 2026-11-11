import test from "node:test";
import assert from "node:assert/strict";
import { apiTurn } from "../runner/api.ts";
import { defaults, parseConfig, resolveApiConnection, resolveApiKey, type Profile } from "../runner/config.ts";

function profile(overrides: Partial<Profile> = {}): Profile {
  return { id: "test", name: "Test", provider: "openai", transport: "api", enabled: true, model: "test-model", apiKey: "test-only-key", ...overrides };
}
function mockSDK(response: unknown) {
  const calls: { format: string; body: any; options: any }[] = [];
  let options: any, packageName: string | undefined;
  const invoke = (format: string) => async (body: any, options: any) => {
    calls.push({ format, body, options });
    return response;
  };
  class Client {
    constructor(value: any) { options = value; }
    responses = { create: invoke("responses") };
    chat = { completions: { create: invoke("chat-completions") } };
    messages = { create: invoke("messages") };
  }
  return {
    calls,
    get options() { return options; },
    get packageName() { return packageName; },
    load: async (name: string) => { packageName = name; return { default: Client }; },
  };
}

test("provider defaults preserve existing transports and isolate EXAONE/compatible credentials", () => {
  for (const [provider, format, baseURL] of [
    ["openai", "responses", "https://api.openai.com/v1"],
    ["anthropic", "messages", "https://api.anthropic.com"],
    ["grok", "responses", "https://api.x.ai/v1"],
    ["exaone", "chat-completions", "https://api.exaone.ai/v1"],
  ] as const) {
    const connection = resolveApiConnection(profile({ provider }));
    assert.equal(connection.apiFormat, format);
    assert.equal(connection.baseURL, baseURL);
  }
  assert.equal(resolveApiKey(profile({ provider: "exaone", apiKey: "" }), { EXAONE_API_KEY: "exaone-test", OPENAI_API_KEY: "openai-test" }), "exaone-test");
  assert.equal(resolveApiKey(profile({ provider: "openai-compatible", apiKey: "" }), { OPENAI_API_KEY: "openai-test" }), undefined);
  assert.equal(resolveApiConnection(profile({ provider: "openai-compatible", baseURL: "http://127.0.0.1:1234/custom/v1/" })).baseURL, "http://127.0.0.1:1234/custom/v1");
  for (const address of ["http://192.0.2.12/", "http://gateway.example:8080/proxy/v1/", "http://[2001:db8::1]:8080/v1/"]) {
    for (const provider of ["anthropic", "openai-compatible"] as const) {
      const parsed = parseConfig({ profiles: [profile({ provider, baseURL: address })] });
      assert.equal(resolveApiConnection(parsed.profiles[0]).baseURL, address.replace(/\/+$/, ""));
    }
  }
  assert.equal(parseConfig(defaults).profiles.find(p => p.provider === "exaone")?.enabled, false);
});

test("invalid provider/transport/format/address combinations fail without exposing URL credentials", () => {
  const parse = (fields: Record<string, unknown>) => parseConfig({ profiles: [profile(fields)] });
  for (const fields of [
    { provider: "unknown" }, { provider: "exaone", transport: "cli" },
    { provider: "gemini", enabled: true }, { provider: "openai-compatible" },
    { provider: "exaone", apiFormat: "responses" }, { provider: "anthropic", apiFormat: "chat-completions" },
    { apiFormat: "messages" }, { apiFormat: "invalid" },
    { apiFormat: "chat-completions", webSearch: true },
    { baseURL: 42 }, { baseURL: "not-a-url-secret" },
    { baseURL: "ftp://api.example/v1" }, { baseURL: "ws://api.example/v1" }, { baseURL: "file:///tmp/api" },
    { baseURL: "http://name:private-secret@api.example/v1" },
    { baseURL: "https://name:private-secret@api.example/v1" },
    { baseURL: "https://api.example/v1?key=private-secret" },
    { baseURL: "https://api.example/v1#private-secret" },
    { baseURL: "https://api.example/v1/chat/completions" },
    { transport: "cli", baseURL: "https://api.example/v1" },
    { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 },
  ]) assert.throws(() => parse(fields), error => error instanceof Error && !error.message.includes("private-secret") && !error.message.includes("not-a-url-secret"));
});

test("Responses sends the selected endpoint/key, preserves instructions and disables retries", async () => {
  const mock = mockSDK({ output_text: '{"text":"ok"}', usage: { total_tokens: 5 }, output: [] });
  const signal = new AbortController().signal;
  const result = await apiTurn(profile({ baseURL: "https://gateway.example/prefix/v1/", maxOutputTokens: 512, webSearch: true }), "system", "question", signal, mock.load, 600000);
  assert.equal(mock.options.timeout,600000);
  assert.equal(mock.options.baseURL, "https://gateway.example/prefix/v1");
  assert.equal(mock.options.apiKey, "test-only-key");
  assert.equal(mock.options.maxRetries, 0);
  assert.equal(mock.calls[0].options.signal, signal);
  assert.deepEqual(mock.calls[0].body, { model: "test-model", instructions: "system", input: "question", store: false, max_output_tokens: 512, tools: [{ type: "web_search" }] });
  assert.equal(result.text, '{"text":"ok"}');
});

test("EXAONE and compatible Chat Completions publish final content only, retaining usage", async () => {
  for (const provider of ["exaone", "openai-compatible", "openai"] as const) {
    const mock = mockSDK({ choices: [{ finish_reason: "stop", message: { content: '\n\n{"text":"answer"}', reasoning_content: "private reasoning", annotations: [] } }], usage: { total_tokens: 75, reasoning_tokens: 60 } });
    const result = await apiTurn(profile({ provider, baseURL: "https://chat.example/v1", apiFormat: "chat-completions", maxOutputTokens: 8192 }), "persona", "history", new AbortController().signal, mock.load);
    assert.equal(mock.packageName, "openai");
    assert.equal(mock.options.timeout,180000);
    assert.equal(mock.calls[0].format, "chat-completions");
    assert.deepEqual(mock.calls[0].body.messages, [{ role: "system", content: "persona" }, { role: "user", content: "history" }]);
    assert.equal(mock.calls[0].body[provider === "openai" ? "max_completion_tokens" : "max_tokens"], 8192);
    assert.equal(mock.calls[0].body.tools, undefined);
    assert.equal(mock.calls[0].body.stream, false);
    assert.equal(result.text, '{"text":"answer"}');
    assert.deepEqual(result.usage, { total_tokens: 75, reasoning_tokens: 60 });
    assert.doesNotMatch(JSON.stringify(result), /private reasoning/);
  }
});

test("Chat Completions rejects truncated or reasoning-only responses without retrying", async () => {
  for (const response of [
    { choices: [{ finish_reason: "length", message: { content: '{"text":' } }] },
    { choices: [{ message: { reasoning_content: "private reasoning", content: "" } }] },
    { choices: [] },
  ]) {
    const mock = mockSDK(response);
    await assert.rejects(apiTurn(profile({ provider: "exaone" }), "", "", new AbortController().signal, mock.load));
    assert.equal(mock.calls.length, 1);
  }
});

test("Anthropic Messages uses the overridden HTTP endpoint and existing search tools", async () => {
  const mock = mockSDK({ content: [{ type: "text", text: "answer" }, { type: "web_search_tool_result", content: [] }], usage: { input_tokens: 2 } });
  const result = await apiTurn(profile({ provider: "anthropic", baseURL: "http://anthropic-gateway.example", webSearch: true, maxOutputTokens: 777 }), "persona", "question", new AbortController().signal, mock.load,600000);
  assert.equal(mock.options.timeout,600000);
  assert.equal(mock.packageName, "@anthropic-ai/sdk");
  assert.equal(mock.options.baseURL, "http://anthropic-gateway.example");
  assert.equal(mock.options.maxRetries, 0);
  assert.equal(mock.calls[0].format, "messages");
  assert.equal(mock.calls[0].body.max_tokens, 777);
  assert.equal(mock.calls[0].body.system, "persona");
  assert.equal(mock.calls[0].body.tools[0].name, "web_search");
  assert.equal(result.text, "answer");
  assert.equal(result.sources.length, 1);
});
