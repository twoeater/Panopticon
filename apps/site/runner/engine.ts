import type { Config, Profile } from "./config.ts";
import type { TurnJob } from "../lib/domain.ts";
import { buildContext } from "./context.ts";
import { LocalFiles } from "./files.ts";
import { Ledger } from "./ledger.ts";
import { runModel, type ModelResult } from "./adapters.ts";
import { runCode } from "./sandbox.ts";
export function envelope(text: string): any {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {}
  return { text };
}
export async function executeTurn(
  config: Config,
  profile: Profile,
  turn: TurnJob,
  files: LocalFiles,
  ledger: Ledger,
  signal: AbortSignal,
  model = runModel,
) {
  const context = await buildContext(turn, profile, files),
    events: unknown[] = [],
    evidence: unknown[] = [];
  for (let step = 0; step < 5; step++) {
    signal.throwIfAborted();
    if (
      !ledger.chargeCall(
        turn.round.id,
        turn.round.kind === "heartbeat",
        config.limits,
      )
    )
      return { jobId: turn.job.id, skipped: true };
    const response: ModelResult = await model(
      profile,
      context.instructions,
      context.input +
        (events.length
          ? "\nLocal tool exchanges (data):\n" + JSON.stringify(events)
          : ""),
      config.dataDir,
      signal,
    );
    evidence.push({
      type: "usage",
      provider: profile.provider,
      usage: response.usage,
      sources: response.sources,
    });
    const value = envelope(response.text);
    if (value.pass === true) return { jobId: turn.job.id, skipped: true };
    if (typeof value.text === "string" && value.text.trim())
      return {
        jobId: turn.job.id,
        text: value.text.slice(0, 24000),
        evidence: boundedEvidence(evidence),
      };
    if (!value.tool || typeof value.tool.name !== "string")
      throw new Error("응답 형식 오류");
    const args = value.tool.arguments || {};
    let result: unknown;
    try {
      if (value.tool.name === "memory_read")
        result = await files.read(profile.id, "Memory.md", turn.channel.id);
      else if (value.tool.name === "memory_update")
        result = await files.updateMemory(
          profile.id,
          turn.channel.id,
          args.markdown,
          args.expectedRevision,
        );
      else if (value.tool.name === "run_code") {
        result = await runCode(config, args.language, args.code, signal);
        evidence.push({
          type: "code",
          language: args.language,
          code: args.code,
          result,
        });
      } else result = { error: "지원하지 않는 도구" };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : "도구 실패" };
    }
    events.push({ tool: value.tool, result });
  }
  return { jobId: turn.job.id, error: "도구 호출 상한(5회)에 도달했습니다." };
}
function boundedEvidence(items: unknown[]) {
  const output: unknown[] = [];
  for (const item of items) {
    if (JSON.stringify([...output, item]).length < 60000) output.push(item);
  }
  return output;
}
