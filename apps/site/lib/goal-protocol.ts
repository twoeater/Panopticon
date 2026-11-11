import type { TurnJob } from "./domain.ts";
export const goalMajorityThreshold=(participantCount:number)=>Math.floor(participantCount/2)+1;
export const turnBudgetId=(turn:TurnJob)=>turn.goal?"goal:"+turn.goal.goal.id+":cycle:"+turn.goal.goal.cycle:turn.round.id;
export const goalResultLimits={discussion:24000,proposal:16000,summary:12000,issues:8000,reason:4000,conclusion:8000} as const;
export function goalResultErrors(turn: TurnJob,result: Record<string,unknown>): string[] {
  const errors:string[]=[];
  const text=(key:string,max:number)=>{
    const value=result[key];
    if(typeof value!=="string"||!value.trim())errors.push(`${key}: 비어 있지 않은 문자열이 필요합니다.`);
    else if(value.length>max)errors.push(`${key}: ${value.length}자 / 최대 ${max}자.`);
  };
  if(turn.job.phase==="goal_discuss")text("text",goalResultLimits.discussion);
  else if(turn.job.phase==="goal_propose")text("text",goalResultLimits.proposal);
  else if(turn.job.phase==="goal_vote") {
    if(result.proposalId!==turn.goal?.proposal?.id)errors.push("proposalId: 현재 초안 ID와 일치해야 합니다.");
    if(!["agree","disagree","abstain"].includes(String(result.decision)))errors.push("decision: agree, disagree, abstain 중 하나여야 합니다.");
    text("reason",goalResultLimits.reason);text("conclusion",goalResultLimits.conclusion);
  } else if(turn.job.phase==="goal_compact") {
    text("summary",goalResultLimits.summary);
    if(result.throughSeq!==turn.round.contextThrough)errors.push(`throughSeq: 숫자 ${turn.round.contextThrough}이어야 합니다.`);
    if(!Array.isArray(result.unresolvedIssues)||!result.unresolvedIssues.every(v=>typeof v==="string"))errors.push("unresolvedIssues: 문자열 배열이 필요합니다.");
    else if(JSON.stringify(result.unresolvedIssues).length>goalResultLimits.issues)errors.push(`unresolvedIssues: JSON ${JSON.stringify(result.unresolvedIssues).length}자 / 최대 ${goalResultLimits.issues}자.`);
    if(!Array.isArray(result.sourceMessageIds)||!result.sourceMessageIds.length)errors.push("sourceMessageIds: 이번 history의 메시지 ID가 하나 이상 필요합니다.");
    else {
      const unknown=result.sourceMessageIds.filter(v=>!turn.history.some(m=>m.id===v)).length;
      if(unknown)errors.push(`sourceMessageIds: 이번 history에 없는 ID ${unknown}개. seq나 과거 요약의 ID 대신 이번 history[].id만 사용하세요.`);
    }
  } else errors.push("지원하지 않는 목표 단계입니다.");
  return errors;
}
export function validGoalResult(turn: TurnJob,result: Record<string,unknown>): boolean {
  return goalResultErrors(turn,result).length===0;
}
