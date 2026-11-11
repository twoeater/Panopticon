import test from "node:test";
import assert from "node:assert/strict";
import { apiTurn, ModelResponseError } from "../runner/api.ts";
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

test("Responses rejects incomplete, empty and refused results with safe specific errors and no retry",async()=>{
  for(const [reply,expected] of [
    [{status:"incomplete",incomplete_details:{reason:"max_output_tokens"},output_text:'{"summary":"partial"}',usage:{output_tokens:128000,output_tokens_details:{reasoning_tokens:127000}}},/출력 한도\(128000 토큰\).*출력 128000, 추론 127000/],
    [{status:"incomplete",incomplete_details:{reason:"content_filter"},output_text:"partial"},/콘텐츠 필터/],
    [{status:"incomplete",incomplete_details:{reason:"private-secret"},output_text:"partial"},/미완료/],
    [{status:"failed",error:{message:"private-secret"},output_text:"partial"},/응답 완료/],
    [{status:"completed",output_text:"",output:[{type:"message",content:[{type:"refusal",refusal:"private-secret"}]}]},/응답을 거절/],
    [{status:"completed",output_text:"  "},/최종 답변/],
  ] as const) {
    const mock=mockSDK(reply);
    await assert.rejects(()=>apiTurn(profile({maxOutputTokens:128000}),"system","input",new AbortController().signal,mock.load),error=>{
      assert.ok(error instanceof ModelResponseError);assert.match(error.message,expected);assert.doesNotMatch(error.message,/private-secret|partial/);return true;
    });
    assert.equal(mock.calls.length,1);
  }
});

test("Anthropic output exhaustion is detected even when a partial JSON body is present",async()=>{
  const mock=mockSDK({stop_reason:"max_tokens",content:[{type:"text",text:'{"summary":"partial"}'}],usage:{output_tokens:512}});
  await assert.rejects(()=>apiTurn(profile({provider:"anthropic",maxOutputTokens:512}),"system","input",new AbortController().signal,mock.load),/출력 한도\(512 토큰\).*출력 512/);
  assert.equal(mock.calls.length,1);
});

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

test("reasoning effort is optional, validated and never added to default profiles",()=>{
  assert.ok(defaults.profiles.every(p=>!Object.hasOwn(p,"reasoningEffort")));
  for(const effort of ["none","minimal","low","medium","high","xhigh","max"] as const)
    assert.equal(parseConfig({profiles:[profile({reasoningEffort:effort})]}).profiles[0].reasoningEffort,effort);
  assert.equal(Object.hasOwn(parseConfig({profiles:[profile()]}).profiles[0],"reasoningEffort"),false);
  for(const effort of [null,"",0,true,"automatic",{},[]])
    assert.throws(()=>parseConfig({profiles:[{...profile(),reasoningEffort:effort}]}),/reasoningEffort/);
  assert.throws(()=>parseConfig({profiles:[profile({transport:"cli",reasoningEffort:"low"})]}),/transport: api/);
});

test("API formats omit reasoning fields entirely unless the profile explicitly supplies an effort",async()=>{
  for(const provider of ["openai","grok","exaone","anthropic","openai-compatible"] as const) {
    const formats=provider==="anthropic"?["messages"] as const:provider==="exaone"?["chat-completions"] as const:["responses","chat-completions"] as const;
    for(const apiFormat of formats)for(const effort of [undefined,"low","high","max","none"] as const) {
      const p=profile({provider,apiFormat,baseURL:"https://api.example/v1",...(effort!==undefined?{reasoningEffort:effort}:{})});
      const response={output_text:"ok",output:[],content:[{type:"text",text:"ok"}],choices:[{finish_reason:"stop",message:{content:"ok"}}]};
      const mock=mockSDK(response);
      await apiTurn(p,"system","input",new AbortController().signal,mock.load);
      const body=mock.calls[0].body,field=apiFormat==="responses"?"reasoning":apiFormat==="messages"?"output_config":"reasoning_effort";
      for(const key of ["reasoning","reasoning_effort","output_config"])assert.equal(Object.hasOwn(body,key),effort!==undefined&&key===field);
      if(effort!==undefined)assert.deepEqual(body[field],apiFormat==="chat-completions"?effort:{effort});
      assert.equal(Object.hasOwn(body,"thinking"),false);
    }
  }
});
