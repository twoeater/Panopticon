import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export type Profile = {
  id: string;
  name: string;
  provider: "openai" | "anthropic" | "grok" | "gemini";
  transport: "cli" | "api";
  enabled: boolean;
  model?: string;
  binary?: string;
  apiKey?: string;
  apiKeyEnv?: string;
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
      model: "",
      apiKey: "",
      enabled: false,
      webSearch: true,
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
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id) || seen.has(p.id))
      throw new Error("참가자 ID는 중복 없는 소문자 영숫자·하이픈·밑줄입니다.");
    seen.add(p.id);
    if (
      !["openai", "anthropic", "grok", "gemini"].includes(p.provider) ||
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
  }
  return value;
}
export function resolveApiKey(
  profile: Profile,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const directKey = profile.apiKey?.trim();
  if (directKey) return directKey;
  const defaultEnv: Partial<Record<Profile["provider"], string>> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    grok: "XAI_API_KEY",
  };
  const envName = profile.apiKeyEnv || defaultEnv[profile.provider];
  return envName ? env[envName]?.trim() || undefined : undefined;
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
