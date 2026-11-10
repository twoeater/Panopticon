import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveApiKey, resolveApiConnection, type Profile } from "./config.ts";
import { providers } from "../lib/providers.ts";
import { apiTurn } from "./api.ts";
import { RpcProcess, runProcess } from "./process.ts";
import { grokTurn } from "./grok.ts";
export interface ModelResult {
  text: string;
  usage: unknown;
  sources: unknown[];
}
const packageImport = (name: string): Promise<any> => import(name);
export async function probe(
  profile: Profile,
): Promise<{ ready: boolean; detail: string }> {
  if (profile.provider === "gemini") return { ready: false, detail: "준비 중" };
  if (profile.transport === "api") {
    const connection = resolveApiConnection(profile);
    if (!resolveApiKey(profile))
      return {
        ready: false,
        detail: "프로필의 apiKey 또는 API 키 환경변수를 설정해 주세요.",
      };
    if (!profile.model)
      return { ready: false, detail: "API 연결은 model 설정이 필요합니다." };
    try {
      await packageImport(connection.sdk);
      return { ready: true, detail: `API 구성됨 · ${providers[profile.provider].label} · ${connection.apiFormat} (실제 접근은 호출 시 확인)` };
    } catch {
      return {
        ready: false,
        detail: `npm run runner -- install-api ${profile.provider} 실행이 필요합니다.`,
      };
    }
  }
  const cli = providers[profile.provider].cli;
  if (!cli) return { ready: false, detail: "이 provider는 API 연결만 지원합니다." };
  try {
    const result = await runProcess(
      profile.binary || cli,
      ["--version"],
      { timeoutMs: 15000, maxOutput: 10000 },
    );
    return { ready: true, detail: result.stdout.trim().slice(0, 160) };
  } catch {
    return {
      ready: false,
      detail:
        "공식 CLI를 설치·로그인하고 필요하면 binary 경로를 지정해 주세요.",
    };
  }
}
async function codexTurn(
  profile: Profile,
  instructions: string,
  input: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ModelResult> {
  const disabledFeatures = [
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "apps",
    "remote_plugin",
    "plugins",
    "hooks",
    "view_image",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "memories",
    "shell_snapshot",
    "skill_mcp_dependency_install",
  ];
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    ...disabledFeatures.flatMap((name) => ["-c", `features.${name}=false`]),
    "-c",
    "agents.enabled=false",
  ];
  const rpc = new RpcProcess(profile.binary || "codex", args, cwd);
  const abort = () => rpc.close(new Error("실행 취소"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "panopticon", title: "Panopticon", version: "0.1.0" },
      capabilities: {},
    });
    rpc.send({ method: "initialized" });
    const current = await rpc.request("config/read", {
      cwd,
      includeLayers: false,
    });
    const config: Record<string, unknown> = {
      web_search: profile.webSearch ? "live" : "disabled",
      project_doc_max_bytes: 0,
      "agents.enabled": false,
      ...Object.fromEntries(
        disabledFeatures.map((name) => [`features.${name}`, false]),
      ),
    };
    for (const name of Object.keys(current.config?.mcp_servers || {}))
      config[`mcp_servers.${name}.enabled`] = false;
    const thread = await rpc.request("thread/start", {
      ...(profile.model ? { model: profile.model } : {}),
      cwd,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      config,
      baseInstructions: instructions,
    });
    let text = "",
      usage: unknown = null;
    const sources: unknown[] = [];
    return await new Promise<ModelResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        rpc.close();
        reject(new Error("Codex 응답 시간 초과"));
      }, 180000);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("실행 취소"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (error?: Error) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve({ text, usage, sources });
      };
      rpc.child.once("exit", () =>
        done(new Error("Codex가 완료 전에 종료되었습니다.")),
      );
      rpc.onEvent = (message) => {
        const p = message.params || {};
        if (p.threadId && p.threadId !== thread.thread.id) return;
        if (message.method === "item/agentMessage/delta") text += p.delta || "";
        if (message.method === "thread/tokenUsage/updated")
          usage = p.tokenUsage;
        if (message.method === "item/completed" && p.item?.type === "webSearch")
          sources.push(p.item);
        if (message.method === "turn/completed") {
          if (p.turn?.status !== "completed")
            done(
              new Error(p.turn?.error?.message || `Codex ${p.turn?.status}`),
            );
          else {
            const final = p.turn?.items
              ?.filter((x: any) => x.type === "agentMessage")
              .map((x: any) => x.text)
              .join("\n");
            if (final) text = final;
            done();
          }
        }
      };
      rpc
        .request("turn/start", {
          threadId: thread.thread.id,
          input: [{ type: "text", text: input, text_elements: [] }],
        })
        .catch((error) => done(error));
    });
  } finally {
    signal.removeEventListener("abort", abort);
    rpc.close();
  }
}
export async function runModel(
  profile: Profile,
  instructions: string,
  input: string,
  dataDir: string,
  signal: AbortSignal,
): Promise<ModelResult> {
  if (profile.provider === "gemini")
    throw new Error("Gemini는 초기 버전에서 호출하지 않습니다.");
  if (profile.transport === "api")
    return apiTurn(profile, instructions, input, signal);
  if (!providers[profile.provider].cli)
    throw new Error("이 provider는 API 연결만 지원합니다.");
  const cwd = path.join(dataDir, "sessions", profile.id);
  await mkdir(cwd, { recursive: true });
  if (profile.provider === "openai")
    return codexTurn(profile, instructions, input, cwd, signal);
  if (profile.provider === "anthropic") {
    const result = await runProcess(
      profile.binary || "claude",
      [
        "--restricted",
        "--safe-mode",
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        "5",
        "--tools",
        profile.webSearch ? "WebSearch" : "",
        "--disallowedTools",
        "mcp__*",
        "--system-prompt",
        instructions,
        ...(profile.model ? ["--model", profile.model] : []),
      ],
      { cwd, input, signal },
    );
    const response = JSON.parse(result.stdout);
    if (response.is_error)
      throw new Error(String(response.result || "Claude 호출 실패"));
    return {
      text: response.result || "",
      usage: response.usage || null,
      sources: [],
    };
  }
  return grokTurn(profile, instructions, input, cwd, signal);
}
