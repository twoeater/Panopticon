import test from "node:test";
import assert from "node:assert/strict";
import type { Message, TurnJob, GoalVote } from "../lib/domain.ts";
import { buildContext } from "../runner/context.ts";
import { compactEvidence, goalHistoryForModel, goalMessage } from "../runner/context-evidence.ts";
import { parseConfig } from "../runner/config.ts";
import { LocalFiles } from "../runner/files.ts";
import { executeTurn } from "../runner/engine.ts";
import { Ledger } from "../runner/ledger.ts";
import {goalResultErrors,validGoalResult} from "../lib/goal-protocol.ts";
import {ModelResponseError} from "../runner/api.ts";

const config = parseConfig({}), profile = config.profiles[0];
const files = new LocalFiles("unused");
files.read = async () => ({markdown:"",revision:"fixture"});
const timestamp = 1700000000000;
const response = (value: unknown) => ({text:JSON.stringify(value),usage:{},sources:[]});
function message(id: string, seq: number, overrides: Partial<Message> = {}): Message {
  return {id,seq,channelId:"channel",goalId:"goal",ownerId:"owner",participantId:"ai",author:"AI",kind:"llm",
    text:`발언 ${id}`,replyTo:null,roundId:"round",phase:"goal_discuss",evidence:"[]",mentions:"[]",createdAt:timestamp,...overrides};
}
function turn(history: Message[] = [], positions = history): TurnJob {
  return {
    job:{id:"job",roundId:"round",channelId:"channel",participantId:"ai",phase:"goal_discuss",status:"running",createdAt:timestamp,startedAt:timestamp,error:null},
    round:{id:"round",channelId:"channel",requestorId:"owner",triggerId:null,kind:"goal",phase:"goal_discuss",status:"running",roster:"[]",targetParticipantIds:"[]",createdAt:timestamp,goalId:"goal",contextThrough:20},
    channel:{id:"channel",name:"Room",ownerId:"owner",situation:"공통 상황",situationVersion:1,heartbeatEnabled:0,heartbeatSeconds:60,heartbeatParticipants:0,nextHeartbeatAt:0,paused:0,createdAt:timestamp},
    participant:{id:"ai",channelId:"channel",ownerId:"owner",deviceId:"device",profileId:profile.id,name:"AI",provider:"openai",onlineAt:timestamp,enabled:1},
    trigger:null,history,phaseMessages:[],
    goal:{goal:{id:"goal",channelId:"channel",creatorId:"owner",title:"목표",instructions:"원래 목표 지시",deadline:timestamp+3600000,finalDeadline:timestamp+4200000,
      intervalSeconds:60,status:"active",phase:"goal_discuss",roster:"[]",revision:1,mutationId:"mutation",cycle:1,roundId:"round",proposalId:null,summary:"누적 요약",
      summaryThrough:0,issues:'["남아 있는 반대"]',cutoffSeq:null,afterCompact:"goal_propose",nextRunAt:0,lastError:null,outcome:null,createdAt:timestamp,completedAt:null},
      participants:[{id:"ai",name:"AI",ownerId:"owner",deviceId:"device",provider:"openai"}],proposal:null,opinions:[],votes:[],positions,historyComplete:true},
  };
}

function summaryTurn() {
  const t=turn([message("current",20)],[message("old-position",1)]);
  t.job.phase="goal_compact";t.round.phase="goal_compact";
  return t;
}
const summaryResult=()=>({summary:"입장과 반대 근거를 보존한 요약",throughSeq:20,unresolvedIssues:["검증 필요"],sourceMessageIds:["current"]});

test("summary constraints distinguish character limits, coverage and source IDs and appear in the prompt",async()=>{
  const t=summaryTurn(),result=summaryResult();
  assert.equal(validGoalResult(t,result),true);
  assert.deepEqual(goalResultErrors(t,result),[]);
  const errors=goalResultErrors(t,{...result,summary:"가".repeat(12001),throughSeq:"20",unresolvedIssues:["x".repeat(8000)],sourceMessageIds:["old-position",20]});
  assert.match(errors.join(" "),/summary: 12001자 \/ 최대 12000자/);
  assert.match(errors.join(" "),/throughSeq: 숫자 20/);
  assert.match(errors.join(" "),/unresolvedIssues: JSON 8004자/);
  assert.match(errors.join(" "),/없는 ID 2개/);
  assert.equal(validGoalResult(t,{...result,summary:"x".repeat(12000)}),true);
  const context=await buildContext(t,profile,files);
  assert.match(context.instructions,/summary는 최대 12000자/);
  assert.match(context.instructions,/숫자 20을 그대로/);
  assert.match(context.instructions,/이번 history\[\]\.id에서만/);
});

test("one bounded format correction preserves the complete rejected answer and validates the replacement",async()=>{
  const ledger=new Ledger(":memory:"),t=summaryTurn();let calls=0;
  const bad={...summaryResult(),summary:"반대 근거 ".repeat(2500)};
  try {
    const result=await executeTurn(config,profile,t,files,ledger,new AbortController().signal,async(_p,instructions,input)=>{
      if(++calls===1)return response(bad);
      assert.match(instructions,/새 조사나 도구 요청 없이/);
      const feedback=JSON.parse(input.split("Local tool exchanges (data):\n")[1])[0];
      assert.equal(feedback.type,"goal_validation");
      assert.equal(feedback.previousResponse,JSON.stringify(bad));
      assert.match(feedback.errors[0],/최대 12000자/);
      return response(summaryResult());
    });
    assert.equal(calls,2);assert.deepEqual(result.goalResult,summaryResult());
    assert.equal(ledger.db.prepare("SELECT count(*) n FROM calls").get()!.n,2);
  }finally{ledger.close();}
});

test("repeated invalid results stop after one correction and report counts without exposing response content",async()=>{
  const ledger=new Ledger(":memory:"),t=summaryTurn();let calls=0;
  try {
    const result=await executeTurn(config,profile,t,files,ledger,new AbortController().signal,async()=>{
      calls++;return {text:JSON.stringify({...summaryResult(),sourceMessageIds:["private-invalid-id"]}),usage:{output_tokens:123,output_tokens_details:{reasoning_tokens:100}},sources:[]};
    });
    assert.equal(calls,2);assert.equal(result.blocked,true);assert.equal(result.goalResult,undefined);
    assert.match(result.error!,/없는 ID 1개/);assert.match(result.error!,/교정 1회 후에도/);
    assert.match(result.error!,/출력 123, 추론 100/);assert.doesNotMatch(result.error!,/private-invalid-id/);
  }finally{ledger.close();}
});

test("format corrections respect call and context limits without dropping the original validation error",async()=>{
  for(const mode of ["calls","context"] as const) {
    const ledger=new Ledger(":memory:");let calls=0;
    try {
      const limited=parseConfig(mode==="calls"?{limits:{maxTurnsPerRequest:1}}:{turn:{goalContextMaxChars:8000}});
      const result=await executeTurn(limited,profile,summaryTurn(),files,ledger,new AbortController().signal,async()=>{
        calls++;return response({...summaryResult(),summary:"x".repeat(13000)});
      });
      assert.equal(calls,1);assert.equal(result.blocked,true);assert.match(result.error!,/summary: 13000자/);
      assert.match(result.error!,mode==="calls"?/호출 한도/:/형식 교정.*문맥 상한/);
    }finally{ledger.close();}
  }
});

test("invalid JSON and tool requests during correction cannot become accepted discussion or vote results",async()=>{
  const ledger=new Ledger(":memory:");let calls=0,toolReads=0;
  try {
    const result=await executeTurn(config,profile,turn(),files,ledger,new AbortController().signal,async()=>{
      return ++calls===1?{text:'설명 {"text":"불완전"}',usage:{},sources:[]}:response({tool:{name:"goal_history_read",arguments:{}}});
    },async()=>{toolReads++;return {};});
    assert.equal(calls,2);assert.equal(toolReads,0);assert.equal(result.blocked,true);
    assert.match(result.error!,/최종 목표 JSON/);
  }finally{ledger.close();}
  const t=turn();t.job.phase="goal_vote";t.goal!.proposal={id:"latest"} as any;
  assert.equal(validGoalResult(t,{proposalId:"old",decision:"agree",reason:"사유",conclusion:"결론"}),false);
  assert.match(goalResultErrors(t,{proposalId:"old",decision:"agree",reason:"사유",conclusion:"결론"}).join(),/현재 초안 ID/);
});

test("known API completion failures reach the goal error without retrying or becoming JSON errors",async()=>{
  const ledger=new Ledger(":memory:");let calls=0;
  try {
    const result=await executeTurn(config,profile,summaryTurn(),files,ledger,new AbortController().signal,async()=>{
      calls++;throw new ModelResponseError("출력 한도(128000 토큰)에 도달했습니다.");
    });
    assert.equal(calls,1);assert.equal(result.blocked,true);
    assert.equal(result.error,"출력 한도(128000 토큰)에 도달했습니다.");
  }finally{ledger.close();}
});

test("goal evidence projects nested provider sources with explicit limits, retaining cited sources first",()=>{
  const hits = Array.from({length:29},(_,i)=>({url:`https://example.com/${i}`,title:`Title ${i}`,ref_id:`source-${i}`,snippet:"검색 근거 ".repeat(150)}));
  const evidence = JSON.stringify([{type:"usage",provider:"openai",usage:{total:123},sources:[
    {type:"webSearch",action:{queries:["query"]},results:hits},
    [{type:"url_citation",url:"https://example.com/citation",title:"Citation"}],
    {type:"web_search_tool_result",content:[{type:"web_search_result",url:"https://example.com/anthropic",title:"Anthropic",encrypted_content:"OPAQUE_DATA"}]},
  ]}]);
  const m = message("a",1,{text:"근거 https://example.com/28",evidence});
  const result = compactEvidence(m)!;
  assert.equal(result.sources[0].url,hits[28].url);
  assert.equal(result.sourceCount,31);
  assert.ok(result.sources.length<=8 && JSON.stringify(result).length<=4000);
  assert.equal(result.truncated,true);
  assert.doesNotMatch(JSON.stringify(result),/OPAQUE_DATA|queries|"usage"|encrypted_content/);
  assert.deepEqual(result.raw,{messageId:m.id,seq:m.seq});
  assert.equal(goalMessage(m).text,m.text);
  assert.equal(m.evidence,evidence);
  assert.deepEqual(goalMessage(m,true).evidence,JSON.parse(evidence));
});

test("evidence keeps distinct excerpts, code outcomes and flags unknown or malformed data",()=>{
  const source={url:"https://example.com/one",title:"One",snippet:"first evidence"};
  const m=message("a",1,{evidence:JSON.stringify([
    {type:"usage",sources:[source,source,{...source,snippet:"contradictory evidence"}]},
    {type:"code",language:"python",code:"print(1)",result:{ok:false,stdout:"1",stderr:"failure ".repeat(300),exitCode:2}},
    {type:"unsupported",opaque:"hidden"},
  ])});
  const result=compactEvidence(m)!;
  assert.equal(result.sourceCount,2);
  assert.equal(result.sources[1].excerpt,"contradictory evidence");
  assert.deepEqual(result.executions[0],{language:"python",code:"print(1)",ok:false,stdout:"1",stderr:"failure ".repeat(300).slice(0,1000),error:undefined,exitCode:2});
  assert.equal(result.truncated,true);assert.equal(result.unrecognizedData,true);
  const malformed=message("bad",2,{evidence:'{"broken"'});
  assert.equal(compactEvidence(malformed)!.unrecognizedData,true);
  assert.equal(goalMessage(malformed,true).evidence,malformed.evidence);
  assert.equal(compactEvidence(message("empty",3)),undefined);
});

test("goal prompts keep each message once while retaining out-of-window positions and required context",async()=>{
  const a=message("a",2),old=message("old",1,{participantId:"other",text:"범위 밖의 반대 의견"});
  const t=turn([a,a],[a,old]);
  const {input,instructions}=await buildContext(t,profile,files),data=JSON.parse(input);
  assert.deepEqual(data.history.map((m:Message)=>m.id),["a"]);
  assert.deepEqual(data.goal.positionMessages.map((m:Message)=>m.id),["old"]);
  const catalog=new Map([...data.history,...data.goal.positionMessages].map((m:Message)=>[m.id,m]));
  for(const ref of data.goal.latestPositions)assert.ok(catalog.has(ref.messageId));
  assert.equal(input.split(old.text).length-1,1);
  assert.equal(data.goal.instructions,t.goal!.goal.instructions);
  assert.equal(data.goal.summary,t.goal!.goal.summary);
  assert.deepEqual(data.goal.unresolvedIssues,["남아 있는 반대"]);
  assert.match(instructions,/includeRawEvidence/);
  const emptyHistory=JSON.parse((await buildContext(turn([],[old]),profile,files)).input);
  assert.equal(emptyHistory.goal.positionMessages[0].text,old.text);
});

test("proposal, votes, opinions and identical evidence use resolvable references without losing decisions",async()=>{
  const evidence=JSON.stringify([{type:"usage",sources:[{url:"https://example.com/one",title:"Shared source"}]}]);
  const proposal={id:"draft",goalId:"goal",version:1,text:"공동 결과 초안",sourceSeq:1,createdAt:timestamp};
  const vote:GoalVote={id:"vote",goalId:"goal",proposalId:"draft",participantId:"ai",decision:"disagree",reason:"검증 실패",conclusion:"현재 초안에 반대",createdAt:timestamp};
  const draft=message("answer:draft",2,{phase:"goal_propose",text:proposal.text});
  const reason=message("answer:vote",3,{phase:"goal_vote",text:"반대 · 초안 1\n"+vote.reason,evidence});
  const conclusion=message("answer:vote:conclusion",4,{phase:"goal_conclusion",text:vote.conclusion,evidence});
  const t=turn([draft,reason,conclusion],[conclusion]);
  t.goal!.proposal=proposal;t.goal!.votes=[vote];t.goal!.opinions=[vote];
  const data=JSON.parse((await buildContext(t,profile,files)).input);
  assert.equal(data.goal.proposal.messageId,draft.id);assert.equal(data.goal.proposal.text,undefined);
  assert.equal(data.goal.votes[0].decision,"disagree");
  assert.equal(data.goal.votes[0].reasonMessageId,reason.id);assert.equal(data.goal.votes[0].reason,undefined);
  assert.equal(data.goal.votes[0].conclusionMessageId,conclusion.id);assert.equal(data.goal.votes[0].conclusion,undefined);
  assert.equal(data.goal.opinions[0].voteId,vote.id);
  assert.equal(data.history[2].evidenceMessageId,reason.id);assert.equal(data.history[2].evidence,undefined);
  assert.equal(data.history[1].evidence.sources[0].title,"Shared source");
  // Missing bodies must remain inline; a reference may never point outside the prompt.
  t.history=[];t.goal!.positions=[];
  const fallback=JSON.parse((await buildContext(t,profile,files)).input);
  assert.equal(fallback.goal.proposal.text,proposal.text);
  assert.equal(fallback.goal.votes[0].reason,vote.reason);assert.equal(fallback.goal.votes[0].conclusion,vote.conclusion);
});

test("ordinary chat preserves its existing evidence representation",async()=>{
  const m=message("a",1,{evidence:'[{"type":"custom","data":"original"}]'}),t=turn([m]);
  delete t.goal;t.job.phase="chat";
  const data=JSON.parse((await buildContext(t,profile,files)).input);
  assert.equal(data.history[0].evidence,m.evidence);assert.equal(data.goal,undefined);
});

test("goal history avoids repeated bodies and explicitly retrieves complete raw evidence",()=>{
  const a=message("a",2),old=message("old",1,{evidence:'[{"type":"custom","original":"all data"}]'});
  const included=new Set([a.id]),page={messages:[a,old],nextBefore:1};
  const compact=goalHistoryForModel(page,false,included) as any;
  assert.deepEqual(compact.messages[0],{messageId:a.id,seq:2,alreadyIncluded:true});
  assert.equal(compact.messages[1].text,old.text);assert.equal(compact.nextBefore,1);
  assert.equal(compact.messages[1].evidence.unrecognizedData,true);
  const again=goalHistoryForModel(page,false,included) as any;
  assert.equal(again.messages[1].alreadyIncluded,true);
  const raw=goalHistoryForModel(page,true,included) as any;
  assert.deepEqual(raw.messages[1].evidence,JSON.parse(old.evidence));
  assert.equal(raw.messages[1].text,old.text);assert.equal(page.messages[1].evidence,old.evidence);
});

test("duplicated provider payloads no longer hold a short discussion before the model call",async()=>{
  const evidence=JSON.stringify([{type:"usage",usage:{total:1},sources:[{type:"webSearch",results:Array.from({length:29},(_,i)=>({url:`https://example.com/${i}`,title:"Evidence",snippet:"relevant ".repeat(90)}))}]}]);
  const messages=Array.from({length:3},(_,i)=>message(`a${i}`,i+1,{participantId:`ai${i}`,text:"discussion ".repeat(100),evidence}));
  const t=turn(messages),legacy=JSON.stringify({history:messages,latestPositions:messages});
  assert.ok(legacy.length>64000);
  const context=await buildContext(t,profile,files);
  assert.ok(context.input.length+context.instructions.length<64000);
  for(const m of messages)assert.equal(JSON.parse(context.input).history.find((item:Message)=>item.id===m.id).text,m.text);
  const ledger=new Ledger(":memory:");let calls=0;
  try {
    const result=await executeTurn(config,profile,t,files,ledger,new AbortController().signal,async()=>{calls++;return response({text:"검토 완료"});});
    assert.equal(calls,1);assert.equal(result.goalResult?.text,"검토 완료");
  }finally{ledger.close();}
});

test("runner exposes full requested evidence even for included messages and still enforces the exact input cap",async()=>{
  const m=message("a",1,{evidence:'[{"type":"custom","original":"RAW_PROOF"}]'}),t=turn([m]);
  const ledger=new Ledger(":memory:");
  try {
    let calls=0;
    const result=await executeTurn(config,profile,t,files,ledger,new AbortController().signal,async(_p,_instructions,input)=>{
      if(calls++===0){assert.doesNotMatch(input,/RAW_PROOF/);return response({tool:{name:"goal_history_read",arguments:{after:0,before:2,limit:1,includeRawEvidence:true,goalId:"foreign"}}});}
      const events=JSON.parse(input.split("\nLocal tool exchanges (data):\n")[1]);
      assert.deepEqual(events[0].result.messages[0].evidence,JSON.parse(m.evidence));
      return response({text:"검토 완료"});
    },async args=>{assert.deepEqual(args,{after:0,before:2,limit:1});return {messages:[m],nextBefore:null};});
    assert.equal(result.goalResult?.text,"검토 완료");assert.equal(calls,2);
    const context=await buildContext(t,profile,files),exact=context.instructions.length+context.input.length;
    const boundaryConfig={...config,turn:{...config.turn,goalContextMaxChars:exact}};
    calls=0;
    const atLimit=await executeTurn(boundaryConfig,profile,t,files,ledger,new AbortController().signal,async()=>{calls++;return response({text:"exact limit"});});
    assert.equal(atLimit.goalResult?.text,"exact limit");assert.equal(calls,1);
    boundaryConfig.turn.goalContextMaxChars=exact-1;
    const overflow=await executeTurn(boundaryConfig,profile,t,files,ledger,new AbortController().signal,async()=>{calls++;return response({text:"never"});});
    assert.equal(overflow.blocked,true);assert.equal(calls,1);assert.match(overflow.error!,new RegExp(`${exact} / ${exact-1}`));
    calls=0;
    const rawOverflow=await executeTurn(config,profile,t,files,ledger,new AbortController().signal,async()=>{calls++;return response({tool:{name:"goal_history_read",arguments:{includeRawEvidence:true}}});},async()=>({messages:[{...m,evidence:JSON.stringify({payload:"x".repeat(64000)})}]}));
    assert.equal(rawOverflow.blocked,true);assert.equal(calls,1);assert.match(rawOverflow.error!,/조회 결과/);
  }finally{ledger.close();}
});
