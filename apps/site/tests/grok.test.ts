import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { grokTurn } from "../runner/grok.ts";
import { runProcess } from "../runner/process.ts";
import type { Profile } from "../runner/config.ts";

const profile: Profile = { id: "grok", name: "Grok", provider: "grok", transport: "cli", enabled: true, webSearch: true, model: "test-model" };

test("Grok passes a long Unicode prompt intact through a file and removes it after completion", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "panopticon grok 한글-"));
  try {
    const fixture = path.join(cwd, "cli.mjs");
    await writeFile(fixture, `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const text = readFileSync(process.argv[process.argv.indexOf('--prompt-file') + 1], 'utf8');
console.log(JSON.stringify({text:createHash('sha256').update(text).digest('hex'),usage:{input_tokens:1}}));`);
    const instructions = '한국어 지침: "따옴표", 개행\n그대로 유지';
    const input = '대화와 근거: "\\"\n'.repeat(18000);
    let promptFile = "";
    const result = await grokTurn(profile, instructions, input, cwd, new AbortController().signal, async (binary, args, options) => {
      assert.equal(binary, "grok");
      assert.ok(args.join(" ").length < 2000);
      assert.ok(!args.includes("-p"));
      promptFile = args[args.indexOf("--prompt-file") + 1];
      assert.equal(await readFile(promptFile, "utf8"), `${instructions}\n\n${input}`);
      assert.equal(args[args.indexOf("--tools") + 1], "web_search");
      assert.equal(args[args.indexOf("--sandbox") + 1], "strict");
      assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
      assert.ok(args.includes("--no-subagents"));
      assert.equal(args[args.indexOf("--deny") + 1], "mcp__*");
      assert.equal(args[args.indexOf("--model") + 1], "test-model");
      return runProcess(process.execPath, [fixture, ...args], options);
    });
    assert.equal(result.text, createHash("sha256").update(`${instructions}\n\n${input}`).digest("hex"));
    assert.deepEqual(result.usage, {input_tokens:1});
    await assert.rejects(access(promptFile));
    assert.deepEqual(await readdir(cwd), ["cli.mjs"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Grok removes private prompt files after CLI errors, cancellation and invalid output", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "panopticon-grok-errors-"));
  try {
    for (const mode of ["process", "cancel", "json", "response"]) {
      const controller = new AbortController();
      await assert.rejects(grokTurn(profile, "private instructions", "private memory", cwd, controller.signal, async (_binary, args) => {
        assert.ok((await readFile(args[args.indexOf("--prompt-file") + 1], "utf8")).includes("private memory"));
        if (mode === "process") throw new Error("CLI failed");
        if (mode === "cancel") { controller.abort(); controller.signal.throwIfAborted(); }
        return {stdout: mode === "json" ? "invalid JSON" : '{"error":"provider failure"}', stderr:""};
      }));
      assert.deepEqual(await readdir(cwd), []);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("concurrent Grok turns use distinct files without mixing their prompts", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "panopticon-grok-concurrent-"));
  try {
    const paths: string[] = [];
    let release!: () => void;
    const bothReady = new Promise<void>(resolve => { release = resolve; });
    const run: typeof runProcess = async (_binary, args) => {
      const file = args[args.indexOf("--prompt-file") + 1];
      paths.push(file);
      if (paths.length === 2) release();
      await bothReady;
      return {stdout: JSON.stringify({text: await readFile(file, "utf8")}), stderr:""};
    };
    const results = await Promise.all(["one", "two"].map(text => grokTurn(profile, "instructions", text, cwd, new AbortController().signal, run)));
    assert.notEqual(paths[0], paths[1]);
    assert.deepEqual(results.map(r => r.text), ["instructions\n\none", "instructions\n\ntwo"]);
    assert.deepEqual(await readdir(cwd), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
