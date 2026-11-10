import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveApiKey, type Profile } from "./config.ts";
import { RpcProcess, runProcess } from "./process.ts";
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
    if (!resolveApiKey(profile))
      return {
        ready: false,
        detail: "프로필의 apiKey 또는 API 키 환경변수를 설정해 주세요.",
      };
    if (!profile.model)
      return { ready: false, detail: "API 연결은 model 설정이 필요합니다." };
    try {
      await packageImport(
        profile.provider === "anthropic" ? "@anthropic-ai/sdk" : "openai",
      );
      return { ready: true, detail: "API 구성됨 (실제 접근은 호출 시 확인)" };
    } catch {
      return {
        ready: false,
        detail: `npm run runner -- install-api ${profile.provider} 실행이 필요합니다.`,
      };
    }
  }
  try {
    const result = await runProcess(
      profile.binary ||
        ({ openai: "codex", anthropic: "claude", grok: "grok" } as const)[
          profile.provider
        ],
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
async function apiTurn(
  profile: Profile,
  instructions: string,
  input: string,
  signal: AbortSignal,
): Promise<ModelResult> {
  if (profile.provider === "gemini") throw new Error("Gemini는 비활성입니다.");
  const apiKey = resolveApiKey(profile);
  if (!apiKey || !profile.model)
    throw new Error("프로필의 apiKey(또는 API 키 환경변수)와 model을 설정해 주세요.");
  if (profile.provider === "anthropic") {
    const { default: Anthropic } = await packageImport("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 180000 });
    const response = await client.messages.create(
      {
        model: profile.model,
        max_tokens: 4096,
        system: instructions,
        messages: [{ role: "user", content: input }],
        ...(profile.webSearch
          ? {
              tools: [
                {
                  type: "web_search_20250305",
                  name: "web_search",
                  max_uses: 3,
                },
              ],
            }
          : {}),
      },
      { signal },
    );
    return {
      text: response.content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join("\n"),
      usage: response.usage,
      sources: response.content.filter(
        (x: any) => x.type === "web_search_tool_result",
      ),
    };
  }
  const { default: OpenAI } = await packageImport("openai");
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 180000,
    ...(profile.provider === "grok" ? { baseURL: "https://api.x.ai/v1" } : {}),
  });
  const response = await client.responses.create(
    {
      model: profile.model,
      instructions,
      input,
      store: false,
      max_output_tokens: 4096,
      ...(profile.webSearch ? { tools: [{ type: "web_search" }] } : {}),
    },
    { signal },
  );
  return {
    text: response.output_text || "",
    usage: response.usage || null,
    sources:
      response.output
        ?.filter(
          (x: any) =>
            x.type === "web_search_call" ||
            (x.type === "message" &&
              x.content?.some((c: any) => c.annotations?.length)),
        )
        .map((x: any) =>
          x.type === "message"
            ? x.content.flatMap((c: any) => c.annotations || [])
            : x,
        ) || [],
  };
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
  const result = await runProcess(
    profile.binary || "grok",
    [
      "--cwd",
      cwd,
      "-p",
      `${instructions}\n\n${input}`,
      "--output-format",
      "json",
      "--tools",
      profile.webSearch ? "web_search" : "",
      "--deny",
      "mcp__*",
      "--no-subagents",
      "--max-turns",
      "5",
      "--permission-mode",
      "dontAsk",
      "--sandbox",
      "strict",
      ...(profile.model ? ["--model", profile.model] : []),
    ],
    { cwd, signal },
  );
  const response = JSON.parse(result.stdout);
  if (response.is_error || response.error) throw new Error("Grok 호출 실패");
  return {
    text: response.result || response.text || response.content || "",
    usage: response.usage || null,
    sources: [],
  };
}
