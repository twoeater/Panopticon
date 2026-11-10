import { runModel } from "../runner/adapters.ts";
import path from "node:path";
const profiles = [
  {
    id: "smoke-codex",
    name: "Codex",
    provider: "openai",
    transport: "cli",
    enabled: true,
    binary: process.env.PANOPTICON_CODEX_BINARY || "codex",
    webSearch: false,
  },
  {
    id: "smoke-grok",
    name: "Grok",
    provider: "grok",
    transport: "cli",
    enabled: true,
    binary: process.env.PANOPTICON_GROK_BINARY || "grok",
    webSearch: false,
  },
] as const;
for (const profile of profiles) {
  try {
    const result = await runModel(
      profile,
      'Reply with exactly {"text":"42"}. Do not use tools.',
      "6*7",
      path.resolve("../../.panopticon"),
      AbortSignal.timeout(120000),
    );
    console.log(
      profile.name,
      JSON.stringify({ text: result.text, hasUsage: !!result.usage }),
    );
  } catch (e) {
    console.error(profile.name, "인증 또는 CLI 호출 실패 (원문 로그 생략)");
    process.exitCode = 1;
  }
}
