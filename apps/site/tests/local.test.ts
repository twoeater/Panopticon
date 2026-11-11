import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalFiles } from "../runner/files.ts";
import { Ledger } from "../runner/ledger.ts";
import { defaults, loadConfig, parseConfig, resolveApiKey } from "../runner/config.ts";
import { runCode } from "../runner/sandbox.ts";
import { ExecutionTimeoutError, withExecutionTimeout } from "../runner/execution-timeout.ts";

test("execution timeout defaults and validation keep durations finite and explicit", () => {
  assert.equal(parseConfig({}).turn.timeoutSeconds,180);
  assert.equal(parseConfig({turn:{timeoutSeconds:600}}).turn.timeoutSeconds,600);
  for(const timeoutSeconds of [-1,0,9,3601,1.5,"600",null])
    assert.throws(()=>parseConfig({turn:{timeoutSeconds}}),/turn.timeoutSeconds/);
});

test("execution timeout aborts the operation and preserves timeout versus external cancellation",async()=>{
  let aborted=false;
  await assert.rejects(withExecutionTimeout(25,new AbortController().signal,signal=>new Promise((_,reject)=>{
    signal.addEventListener("abort",()=>{aborted=true;reject(new Error("SDK replaced the abort reason"));},{once:true});
  })),error=>error instanceof ExecutionTimeoutError&&/turn.timeoutSeconds/.test(error.message));
  assert.equal(aborted,true);
  const cancelled=new AbortController(),reason=new Error("user cancelled");cancelled.abort(reason);
  await assert.rejects(withExecutionTimeout(25,cancelled.signal,async()=>{throw new Error("must not run");}),error=>error===reason);
  let completedSignal:AbortSignal|undefined;
  assert.equal(await withExecutionTimeout(20,new AbortController().signal,async signal=>{completedSignal=signal;return "done";}),"done");
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(completedSignal!.aborted,false,"successful operations clear the timer");
});
test('skipped acknowledgements survive restart without charging quota or replacing a completed answer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panopticon-')), file=path.join(dir,'usage.sqlite'); let ledger = new Ledger(file);
  try {
    ledger.skip('skip',{jobId:'skip',skipped:true}); ledger.close(); ledger=new Ledger(file);
    assert.equal(ledger.pending()[0].id,'skip');
    assert.equal(ledger.reserve('paid','round','me','me',true,{...defaults.limits,automaticTurnsPerHour:1}).allowed,true);
    ledger.finish('paid',{text:'answer'}); ledger.skip('paid',{skipped:true});
    assert.equal(JSON.parse(ledger.pending().find(x=>x.id==='paid')!.payload!).text,'answer');
    ledger.acknowledged('skip'); assert.equal(ledger.pending().some(x=>x.id==='skip'),false);
  } finally {ledger.close();await rm(dir,{recursive:true,force:true});}
});
test("per-channel private memory, revision conflict, history restore and path rejection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panopticon-")),
    files = new LocalFiles(dir);
  try {
    await files.initialize("alice");
    const empty = await files.read("alice", "Memory.md", "room1");
    await files.updateMemory("alice", "room1", "private", empty.revision);
    assert.equal(
      (await files.read("alice", "Memory.md", "room2")).markdown,
      "",
    );
    await assert.rejects(
      files.updateMemory("alice", "room1", "oops", empty.revision),
      /변경/,
    );
    await files.restore(
      "alice",
      "room1",
      (await files.history("alice", "room1"))[0],
    );
    assert.equal(
      (await files.read("alice", "Memory.md", "room1")).markdown,
      "",
    );
    await assert.rejects(files.read("../other", "Persona.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("persistent limits count a request once, dedupe jobs, separate senders and bound model calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panopticon-")),
    file = path.join(dir, "usage.sqlite"),
    limits = { ...defaults.limits, self: 1, other: 0, maxTurnsPerRequest: 2 };
  let ledger = new Ledger(file);
  try {
    assert.equal(
      ledger.reserve("j1", "r1", "me", "me", false, limits).allowed,
      true,
    );
    assert.equal(
      ledger.reserve("j2", "r1", "me", "me", false, limits).allowed,
      true,
    );
    assert.equal(
      ledger.reserve("j1", "r1", "me", "me", false, limits).allowed,
      false,
    );
    assert.equal(
      ledger.reserve("j3", "r2", "me", "me", false, limits).allowed,
      false,
    );
    assert.equal(
      ledger.reserve("j4", "r3", "other", "me", false, limits).allowed,
      false,
    );
    assert.equal(ledger.chargeCall("r1", false, limits), true);
    assert.equal(ledger.chargeCall("r1", false, limits), true);
    assert.equal(ledger.chargeCall("r1", false, limits), false);
    ledger.close();
    ledger = new Ledger(file);
    assert.equal(
      ledger.reserve("j3", "r2", "me", "me", false, limits).allowed,
      false,
    );
    assert.equal(ledger.pending().length, 2);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("config count supports zero, excludes fixed prompts, Gemini is disabled", () => {
  assert.equal(
    parseConfig({ turn: { historyMessageCount: 0 } }).turn.historyMessageCount,
    0,
  );
  assert.throws(() => parseConfig({ turn: { fixedMessages: [] } }));
  assert.throws(() =>
    parseConfig({ profiles: [{ ...defaults.profiles[3], enabled: true }] }),
  );
  assert.throws(() => parseConfig({ serverUrl: "http://example.com" }));
});
test("API keys use local config first and retain provider/custom environment fallbacks", () => {
  for (const [provider, envName] of [
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["grok", "XAI_API_KEY"],
  ] as const) {
    const profile = parseConfig({
      profiles: [{ ...defaults.profiles[0], provider, transport: "api", apiKey: "  test-local-key  " }],
    }).profiles[0];
    const env = { [envName]: "test-default-key", CUSTOM_API_KEY: "test-custom-key" };
    assert.equal(resolveApiKey(profile, {}), "test-local-key");
    assert.equal(resolveApiKey({ ...profile, apiKeyEnv: "CUSTOM_API_KEY" }, env), "test-local-key");
    assert.equal(resolveApiKey({ ...profile, apiKey: "" }, env), "test-default-key");
    assert.equal(resolveApiKey({ ...profile, apiKey: undefined }, env), "test-default-key");
    assert.equal(resolveApiKey({ ...profile, apiKey: "  ", apiKeyEnv: "CUSTOM_API_KEY" }, env), "test-custom-key");
    assert.equal(resolveApiKey({ ...profile, apiKey: "" }, {}), undefined);
    assert.equal(resolveApiKey({ ...profile, apiKey: "" }, { [envName]: "  " }), undefined);
  }
  assert.throws(() => parseConfig({ profiles: [{ ...defaults.profiles[0], apiKey: { secret: "test-secret" } }] }), /^Error: 참가자의 apiKey는 문자열이어야 합니다\.$/);
});
test("malformed config errors do not include API keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "panopticon-"));
  try {
    const file = path.join(dir, "config.local.json");
    await writeFile(file, '{"apiKey":"test-private-key" invalid}');
    await assert.rejects(loadConfig(file), (error: Error) => {
      assert.equal(error.message, "설정 파일의 JSON 문법을 확인해 주세요.");
      assert.doesNotMatch(String(error.stack), /test-private-key/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("QuickJS arithmetic, no Node/network bindings, bounded execution and memory", async () => {
  const config = parseConfig({ sandbox: { timeoutMs: 200, memoryMiB: 32 } });
  const value = await runCode(
    config,
    "javascript",
    "console.log(6*7); console.log(typeof process,typeof require,typeof fetch)",
  );
  assert.equal(value.ok, true);
  assert.match(value.stdout, /42\nundefined undefined undefined/);
  const loop = await runCode(config, "javascript", "while(true){}");
  assert.equal(loop.ok, false);
  const memory = await runCode(
    config,
    "javascript",
    "let a=[]; while(true) a.push(new Array(100000).fill(42));",
  );
  assert.equal(memory.ok, false);
});
