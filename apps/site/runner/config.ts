import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProvider, providers, type Provider, type ApiFormat } from "../lib/providers.ts";
export type Profile = {
  id: string;
  name: string;
  provider: Provider;
  transport: "cli" | "api";
  enabled: boolean;
  model?: string;
  binary?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  apiFormat?: ApiFormat;
  maxOutputTokens?: number;
  webSearch?: boolean;
};
export interface Config {
  serverUrl: string;
  dataDir: string;
  channels: string[];
  turn: { historyMessageCount: number };
  profiles: Profile[];
  limits: {
    windowMinutes: number;
    self: number;
    other: number;
    total: number;
    perUser: Record<string, number>;
    automaticTurnsPerHour: number;
    maxTurnsPerRequest: number;
    concurrency: number;
  };
  sandbox: {
    backend: "wasm" | "docker";
    timeoutMs: number;
    memoryMiB: number;
    outputKiB: number;
  };
}
export const defaults: Config = {
  serverUrl: "https://panopticon.example",
  dataDir: ".panopticon",
  channels: [],
  turn: { historyMessageCount: 40 },
  profiles: [
    {
      id: "gpt",
      name: "ChatGPT",
      provider: "openai",
      transport: "cli",
      enabled: true,
      webSearch: true,
    },
    {
      id: "claude",
      name: "Claude",
      provider: "anthropic",
      transport: "cli",
      enabled: true,
      webSearch: true,
    },
    {
      id: "grok",
      name: "Grok",
      provider: "grok",
      transport: "cli",
      enabled: true,
      webSearch: true,
    },
    {
      id: "gemini",
      name: "Gemini",
      provider: "gemini",
      transport: "cli",
      enabled: false,
    },
    {
      id: "gpt-api",
      name: "GPT API",
      provider: "openai",
      transport: "api",
      baseURL: "https://api.openai.com/v1",
      apiFormat: "responses",
      model: "",
      apiKey: "",
      enabled: false,
      webSearch: true,
    },
    {
      id: "exaone",
      name: "EXAONE",
      provider: "exaone",
      transport: "api",
      baseURL: "https://api.exaone.ai/v1",
      apiFormat: "chat-completions",
      model: "k-exaone_v2.5",
      apiKey: "",
      enabled: false,
      webSearch: false,
      maxOutputTokens: 16384,
    },
  ],
  limits: {
    windowMinutes: 60,
    self: 60,
    other: 10,
    total: 120,
    perUser: {},
    automaticTurnsPerHour: 30,
    maxTurnsPerRequest: 12,
    concurrency: 2,
  },
  sandbox: { backend: "wasm", timeoutMs: 10000, memoryMiB: 256, outputKiB: 64 },
};
export function parseConfig(raw: any, base = process.cwd()): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("설정은 JSON 객체여야 합니다.");
  const value: Config = {
    ...defaults,
    ...raw,
    turn: { ...defaults.turn, ...raw.turn },
    limits: { ...defaults.limits, ...raw.limits },
    sandbox: { ...defaults.sandbox, ...raw.sandbox },
  };
  const int = (x: unknown, min: number, max: number, name: string) => {
    if (!Number.isInteger(x) || Number(x) < min || Number(x) > max)
      throw new Error(`${name}: ${min}~${max} 정수가 필요합니다.`);
  };
  const url = new URL(value.serverUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("서버 주소는 HTTPS 또는 로컬 loopback 주소여야 합니다.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "서버 주소에 인증 정보·쿼리·프래그먼트를 포함할 수 없습니다.",
    );
  value.serverUrl = url.origin;
  value.dataDir = path.resolve(base, value.dataDir);
  int(value.turn.historyMessageCount, 0, 1000, "turn.historyMessageCount");
  if (Object.keys(value.turn).some((k) => k !== "historyMessageCount"))
    throw new Error("turn 설정은 historyMessageCount만 지원합니다.");
  if (
    !Array.isArray(value.channels) ||
    value.channels.some((c) => typeof c !== "string" || c.length > 100)
  )
    throw new Error("channels는 채널 ID 배열입니다.");
  for (const key of [
    "self",
    "other",
    "total",
    "automaticTurnsPerHour",
  ] as const)
    int(value.limits[key], -1, 1000000, `limits.${key}`);
  int(value.limits.windowMinutes, 1, 1440, "limits.windowMinutes");
  int(value.limits.maxTurnsPerRequest, 1, 100, "limits.maxTurnsPerRequest");
  int(value.limits.concurrency, 1, 8, "limits.concurrency");
  if (
    !value.limits.perUser ||
    typeof value.limits.perUser !== "object" ||
    Array.isArray(value.limits.perUser)
  )
    throw new Error("limits.perUser는 사용자 ID별 한도 객체입니다.");
  for (const [key, limit] of Object.entries(value.limits.perUser))
    int(limit, -1, 1000000, `limits.perUser.${key}`);
  int(value.sandbox.timeoutMs, 100, 60000, "sandbox.timeoutMs");
  int(value.sandbox.memoryMiB, 32, 1024, "sandbox.memoryMiB");
  int(value.sandbox.outputKiB, 1, 1024, "sandbox.outputKiB");
  if (!["wasm", "docker"].includes(value.sandbox.backend))
    throw new Error("sandbox.backend는 wasm 또는 docker입니다.");
  if (!Array.isArray(value.profiles) || value.profiles.length > 12)
    throw new Error("profiles는 최대 12개의 참가자 배열입니다.");
  const seen = new Set<string>();
  for (const p of value.profiles) {
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw new Error("참가자 설정은 JSON 객체여야 합니다.");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id) || seen.has(p.id))
      throw new Error("참가자 ID는 중복 없는 소문자 영숫자·하이픈·밑줄입니다.");
    seen.add(p.id);
    if (
      !isProvider(p.provider) ||
      !["cli", "api"].includes(p.transport) ||
      typeof p.enabled !== "boolean" ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 60
    )
      throw new Error(`잘못된 참가자 설정: ${p.id}`);
    if (p.provider === "gemini" && p.enabled)
      throw new Error("Gemini는 초기 버전에서 활성화할 수 없습니다.");
    for (const field of ["apiKey", "apiKeyEnv"] as const)
      if (p[field] !== undefined && typeof p[field] !== "string")
        throw new Error(`참가자의 ${field}는 문자열이어야 합니다.`);
    if (p.webSearch !== undefined && typeof p.webSearch !== "boolean")
      throw new Error("webSearch는 true 또는 false여야 합니다.");
    if (p.maxOutputTokens !== undefined)
      int(p.maxOutputTokens, 1, 524288, "maxOutputTokens");
    if (p.transport === "api" && p.provider !== "gemini")
      resolveApiConnection(p);
    if (p.transport === "cli") {
      if (p.provider !== "gemini" && !providers[p.provider].cli)
        throw new Error("이 provider는 transport: api만 지원합니다.");
      if (p.baseURL !== undefined || p.apiFormat !== undefined || p.maxOutputTokens !== undefined)
        throw new Error("baseURL·apiFormat·maxOutputTokens는 transport: api에서만 사용합니다.");
    }
  }
  return value;
}
export function resolveApiKey(
  profile: Profile,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const directKey = profile.apiKey?.trim();
  if (directKey) return directKey;
  const envName = profile.apiKeyEnv || providers[profile.provider].api?.keyEnv;
  return envName ? env[envName]?.trim() || undefined : undefined;
}
export function resolveApiConnection(profile: Profile) {
  const preset = providers[profile.provider].api;
  if (!preset) throw new Error("이 provider는 아직 API를 지원하지 않습니다.");
  const apiFormat = profile.apiFormat ?? preset.format;
  if (!["responses", "chat-completions", "messages"].includes(apiFormat))
    throw new Error("apiFormat은 responses, chat-completions, messages 중 하나입니다.");
  if ((profile.provider === "anthropic") !== (apiFormat === "messages"))
    throw new Error("Anthropic provider는 messages 형식만 지원합니다.");
  if (profile.provider === "exaone" && apiFormat !== "chat-completions")
    throw new Error("EXAONE은 chat-completions 형식을 사용합니다.");
  if (apiFormat === "chat-completions" && profile.webSearch)
    throw new Error("Chat Completions 연결은 webSearch: false로 설정해 주세요.");
  if (profile.baseURL !== undefined && typeof profile.baseURL !== "string")
    throw new Error("baseURL은 URL 문자열이어야 합니다.");
  const address = profile.baseURL?.trim() || preset.baseURL;
  if (!address) throw new Error("openai-compatible provider는 baseURL을 지정해야 합니다.");
  let url: URL;
  try { url = new URL(address); }
  catch { throw new Error("baseURL에 올바른 API 기본 주소를 입력해 주세요."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("baseURL은 HTTPS 또는 로컬 loopback HTTP 주소여야 합니다.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("baseURL에 인증 정보·쿼리·프래그먼트를 포함할 수 없습니다.");
  if (/\/(?:responses|chat\/completions|messages)\/*$/.test(url.pathname))
    throw new Error("baseURL에는 /responses·/chat/completions·/messages를 제외한 기본 주소를 입력하세요.");
  return {
    baseURL: url.href.replace(/\/+$/, ""),
    apiFormat,
    maxOutputTokens: profile.maxOutputTokens ?? (profile.provider === "exaone" ? 16384 : 4096),
    sdk: apiFormat === "messages" ? "@anthropic-ai/sdk" : "openai",
  };
}
export async function loadConfig(file = "config.local.json") {
  const fullPath = path.resolve(file);
  let raw = {};
  try {
    raw = JSON.parse(await readFile(fullPath, "utf8"));
  } catch (error: any) {
    // JSON.parse errors may include the source text, including an API key.
    if (error instanceof SyntaxError)
      throw new Error("설정 파일의 JSON 문법을 확인해 주세요.");
    if (error.code !== "ENOENT") throw error;
  }
  return parseConfig(raw, path.dirname(fullPath));
}
export async function createExample(file: string) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(defaults, null, 2) + "\n", {
    flag: "wx",
  });
}
