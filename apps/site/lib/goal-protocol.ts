import type { TurnJob } from "./domain.ts";
export const goalMajorityThreshold=(participantCount:number)=>Math.floor(participantCount/2)+1;
export const turnBudgetId=(turn:TurnJob)=>turn.goal?"goal:"+turn.goal.goal.id+":cycle:"+turn.goal.goal.cycle:turn.round.id;
export function validGoalResult(turn: TurnJob,result: Record<string,unknown>): boolean {
  const text=(value:unknown,max:number)=>typeof value==="string"&&Boolean(value.trim())&&value.length<=max;
  if(turn.job.phase==="goal_discuss")return text(result.text,24000);
  if(turn.job.phase==="goal_propose")return text(result.text,16000);
  if(turn.job.phase==="goal_vote")return result.proposalId===turn.goal?.proposal?.id &&
    ["agree","disagree","abstain"].includes(String(result.decision))&&text(result.reason,4000)&&text(result.conclusion,8000);
  if(turn.job.phase==="goal_compact")return text(result.summary,12000)&&result.throughSeq===turn.round.contextThrough &&
    Array.isArray(result.unresolvedIssues)&&result.unresolvedIssues.every(v=>typeof v==="string")&&JSON.stringify(result.unresolvedIssues).length<=8000&&
    Array.isArray(result.sourceMessageIds)&&result.sourceMessageIds.length>0&&result.sourceMessageIds.every(v=>turn.history.some(m=>m.id===v));
  return false;
}
