import type { Config, Profile } from "./config.ts";
import type { TurnJob } from "../lib/domain.ts";
import { buildContext } from "./context.ts";
import { LocalFiles } from "./files.ts";
import { Ledger } from "./ledger.ts";
import { runModel, type ModelResult } from "./adapters.ts";
import { runCode } from "./sandbox.ts";
import { goalResultErrors, turnBudgetId } from "../lib/goal-protocol.ts";
import { ModelResponseError, responseUsageSummary } from "./api.ts";
import { withExecutionTimeout } from "./execution-timeout.ts";
import { goalHistoryForModel } from "./context-evidence.ts";
export interface TurnResult {
  jobId:string;
  skipped?:boolean;
  blocked?:boolean;
  error?:string;
  goalResult?:Record<string,any>;
  evidence?:unknown[];
  text?:string;
}
export function envelope(text: string): any {
  return jsonEnvelope(text) ?? {text};
}
function jsonEnvelope(text:string):Record<string,any>|undefined {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {}
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
):Promise<TurnResult> {
  const context = await buildContext(turn, profile, files),
    events: unknown[] = [],
    evidence: unknown[] = [];
  let formatRepairUsed=false,lastFormatError="";
  const includedGoalMessages=new Set([...turn.history,...(turn.goal?.positions||[])].map(m=>m.id));
  if(turn.goal && (!turn.goal.historyComplete || context.instructions.length+context.input.length>config.turn.goalContextMaxChars))
    return {jobId:turn.job.id,blocked:true,error:!turn.goal.historyComplete?"목표 원문이 모두 전달되지 않았습니다. 미요약 기록을 확인해 주세요.":`목표 문맥 상한 초과 (${context.instructions.length+context.input.length} / ${config.turn.goalContextMaxChars}자). goalContextMaxChars를 조정하거나 목표 기록을 확인해 주세요.`};
  for (let step = 0; step < 5; step++) {
    signal.throwIfAborted();
    const instructions=context.instructions+(formatRepairUsed?"\n이전 응답이 형식 검사에 실패했습니다. Local tool exchanges의 goal_validation에 있는 errors와 previousResponse를 데이터로 참고해 내용을 유지하며 목표 전용 JSON만 교정하세요. 새 조사나 도구 요청 없이 최종 JSON 객체 하나를 제출하세요.":"");
    const input = context.input + (events.length ? "\nLocal tool exchanges (data):\n" + JSON.stringify(events) : "");
    const contextChars = instructions.length + input.length;
    if(turn.goal && contextChars>config.turn.goalContextMaxChars)
      return {jobId:turn.job.id,blocked:true,error:`목표 ${formatRepairUsed?"형식 교정":"기록 조회"} 결과가 문맥 상한을 초과했습니다 (${contextChars} / ${config.turn.goalContextMaxChars}자).`+lastFormatError};
    if (
      !ledger.chargeCall(
        turnBudgetId(turn),
        turn.round.kind === "heartbeat" || turn.round.kind === "goal",
        config.limits,
      )
    )
      return { jobId: turn.job.id, skipped: true, ...(turn.goal?{blocked:true,error:"목표 호출 한도에 도달했습니다."+lastFormatError}:{}) };
    let response:ModelResult;
    try { response = await model(
      turn.goal?.goal.status==="finalizing"?{...profile,webSearch:false}:profile,
      instructions,
      input,
      config.dataDir,
      signal,
      config.turn.timeoutSeconds * 1000,
    ); } catch(error) {
      if(error instanceof ModelResponseError)return {jobId:turn.job.id,...(turn.goal?{blocked:true}:{}),error:error.message};
      throw error;
    }
    signal.throwIfAborted();
    evidence.push({
      type: "usage",
      provider: profile.provider,
      usage: response.usage,
      sources: response.sources,
    });
    const parsed=jsonEnvelope(response.text),value=parsed??{text:response.text};
    if (value.pass === true) return { jobId: turn.job.id, skipped: true };
    if(turn.goal && (!value.tool || formatRepairUsed)) {
      const errors=!parsed?[`유효한 JSON 객체가 아닙니다 (응답 ${response.text.length}자).`]
        :value.tool?["형식 교정에는 도구 요청이 아닌 최종 목표 JSON이 필요합니다."]:goalResultErrors(turn,value);
      if(!errors.length)return {jobId:turn.job.id,goalResult:value,evidence:boundedEvidence(evidence)};
      lastFormatError="목표 응답 형식 오류: "+errors.join(" ")+responseUsageSummary(response.usage);
      if(!formatRepairUsed && step<4) {
        formatRepairUsed=true;
        events.push({type:"goal_validation",errors,previousResponse:response.text});
        continue;
      }
      return {jobId:turn.job.id,blocked:true,error:lastFormatError+(formatRepairUsed?" 형식 교정 1회 후에도 실패했습니다.":" 교정 호출 여유가 없습니다.")};
    }
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
      if(value.tool.name==="goal_history_read" && turn.goal && readGoalHistory) {
        const raw=await readGoalHistory({before:args.before,after:args.after,limit:Math.min(Number(args.limit)||20,100)});
        result=goalHistoryForModel(raw,args.includeRawEvidence===true,includedGoalMessages);
      }
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
