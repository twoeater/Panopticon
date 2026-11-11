import type { Config, Profile } from "./config.ts";
import type { TurnJob } from "../lib/domain.ts";
import { buildContext } from "./context.ts";
import { LocalFiles } from "./files.ts";
import { Ledger } from "./ledger.ts";
import { runModel, type ModelResult } from "./adapters.ts";
import { runCode } from "./sandbox.ts";
import { validGoalResult, turnBudgetId } from "../lib/goal-protocol.ts";
import { withExecutionTimeout } from "./execution-timeout.ts";
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
export function executeTurn(...args: Parameters<typeof executeTurnWithinLimit>) {
  const [config, profile, turn, files, ledger, signal, model, readGoalHistory] = args;
  return withExecutionTimeout(config.turn.timeoutSeconds * 1000, signal, limitedSignal =>
    executeTurnWithinLimit(config, profile, turn, files, ledger, limitedSignal, model, readGoalHistory));
}
async function executeTurnWithinLimit(
  config: Config,
  profile: Profile,
  turn: TurnJob,
  files: LocalFiles,
  ledger: Ledger,
  signal: AbortSignal,
  model = runModel,
  readGoalHistory?: (args: Record<string,unknown>)=>Promise<unknown>,
) {
  const context = await buildContext(turn, profile, files),
    events: unknown[] = [],
    evidence: unknown[] = [];
  if(turn.goal && (!turn.goal.historyComplete || context.instructions.length+context.input.length>config.turn.goalContextMaxChars))
    return {jobId:turn.job.id,blocked:true,error:"목표 문맥 상한 초과. goalContextMaxChars를 조정하거나 목표 기록을 확인해 주세요."};
  for (let step = 0; step < 5; step++) {
    signal.throwIfAborted();
    if(turn.goal && context.instructions.length+context.input.length+JSON.stringify(events).length>config.turn.goalContextMaxChars)
      return {jobId:turn.job.id,blocked:true,error:"목표 기록 조회 결과가 문맥 상한을 초과했습니다."};
    if (
      !ledger.chargeCall(
        turnBudgetId(turn),
        turn.round.kind === "heartbeat" || turn.round.kind === "goal",
        config.limits,
      )
    )
      return { jobId: turn.job.id, skipped: true, ...(turn.goal?{blocked:true,error:"목표 호출 한도에 도달했습니다."}:{}) };
    const response: ModelResult = await model(
      turn.goal?.goal.status==="finalizing"?{...profile,webSearch:false}:profile,
      context.instructions,
      context.input +
        (events.length
          ? "\nLocal tool exchanges (data):\n" + JSON.stringify(events)
          : ""),
      config.dataDir,
      signal,
      config.turn.timeoutSeconds * 1000,
    );
    signal.throwIfAborted();
    evidence.push({
      type: "usage",
      provider: profile.provider,
      usage: response.usage,
      sources: response.sources,
    });
    const value = envelope(response.text);
    if (value.pass === true) return { jobId: turn.job.id, skipped: true };
    if(turn.goal && !value.tool)
      return validGoalResult(turn,value)
        ? {jobId:turn.job.id,goalResult:value,evidence:boundedEvidence(evidence)}
        : {jobId:turn.job.id,blocked:true,error:"목표 응답 형식 오류. 초안 버전·결론·요약 근거를 확인해야 합니다."};
    if (!turn.goal && typeof value.text === "string" && value.text.trim())
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
      if(value.tool.name==="goal_history_read" && turn.goal && readGoalHistory)
        result=await readGoalHistory({before:args.before,after:args.after,limit:Math.min(Number(args.limit)||20,100)});
      else if (value.tool.name === "memory_read")
        result = await files.read(profile.id, "Memory.md", turn.channel.id);
      else if (value.tool.name === "memory_update")
        result = await files.updateMemory(
          profile.id,
          turn.channel.id,
          args.markdown,
          args.expectedRevision,
        );
      else if (value.tool.name === "run_code") {
        if(turn.goal?.goal.status==="finalizing")throw new Error("마감 후에는 기존 기록으로만 최종 정리합니다.");
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
