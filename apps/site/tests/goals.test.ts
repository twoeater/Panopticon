import test from "node:test";
import assert from "node:assert/strict";
import {RoomService} from "../lib/service.ts";
import {testDatabase} from "./helpers.ts";
import type {Actor,Goal,Participant,TurnJob} from "../lib/domain.ts";
import {handleMcp} from "../lib/mcp.ts";
import {mergeMessageWindow} from "../lib/message-window.ts";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {executeTurn} from "../runner/engine.ts";
import {parseConfig,defaults} from "../runner/config.ts";
import {LocalFiles} from "../runner/files.ts";
import {Ledger} from "../runner/ledger.ts";
import {turnBudgetId} from "../lib/goal-protocol.ts";

const owner:Actor={id:"owner",name:"Owner",kind:"user"}, member:Actor={id:"member",name:"Member",kind:"user"};
async function setup(participantCount=2) {
  const {db,sqlite}=testDatabase(),room=new RoomService(db);
  const channel:any=await room.call(owner,"channel_create",{name:"goals",password:"test-password"});
  await room.call(owner,"channel_update",{channelId:channel.id,heartbeatEnabled:false});
  await room.call(member,"channel_join",{channelId:channel.id,password:"test-password"});
  const pair:any=await room.call(owner,"pair_create"),auth=await room.pair(pair.code,"fixture"),device=(await room.authenticate(auth.token))!;
  const profiles=Array.from({length:participantCount},(_,i)=>({id:String.fromCharCode(97+i),name:String.fromCharCode(65+i),provider:i%2?"grok":"openai"}));
  const participants=await room.call(device,"register",{channelId:channel.id,capabilities:["goals-v1"],profiles}) as Participant[];
  const start=(args:Record<string,unknown>={},actor=member)=>room.call(actor,"goal_start",{channelId:channel.id,requestId:crypto.randomUUID(),title:"검증 목표",instructions:"공유 목표 지시",deadline:Date.now()+3600000,...args}) as Promise<Goal>;
  const poll=()=>room.poll(device,{channelId:channel.id,capabilities:["goals-v1"],historyMessageCount:40,goalHistoryMessageCount:1});
  return {room,sqlite,channel,device,participants,start,poll};
}
async function connectMember(f:Awaited<ReturnType<typeof setup>>,supported=true) {
  const pair:any=await f.room.call(member,"pair_create"),auth=await f.room.pair(pair.code,"member runner"),device=(await f.room.authenticate(auth.token))!;
  const profiles=[{id:"other-ai",name:"Other AI",provider:"anthropic"}];
  const register=()=>f.room.call(device,"register",{channelId:f.channel.id,profiles,capabilities:supported?["goals-v1"]:[]}) as Promise<Participant[]>;
  return {device,profiles,participants:await register(),register};
}
function result(turn:TurnJob,decision="agree") {
  switch(turn.job.phase) {
    case "goal_discuss":return {text:"내 입장과 근거"};
    case "goal_compact":return {summary:"모든 이전 입장과 근거를 유지한 요약",unresolvedIssues:["검증 필요"],throughSeq:turn.round.contextThrough,sourceMessageIds:turn.history.map(m=>m.id)};
    case "goal_propose":return {text:"검증 가능한 공동 초안"};
    case "goal_vote":return {proposalId:turn.goal!.proposal!.id,decision,reason:"근거를 검토함",conclusion:"개인 최종 결론"};
  }
}
async function untilVote(f:Awaited<ReturnType<typeof setup>>) {
  for(let i=0;i<20;i++){
    const turn=(await f.poll()).jobs[0];assert.ok(turn);
    if(turn.job.phase==="goal_vote")return turn;
    await f.room.complete(f.device,{jobId:turn.job.id,goalResult:result(turn)});
  }
  throw new Error("vote not reached");
}
test("human members can start channel goals; one live goal and capability-gated participation",async()=>{
  const f=await setup();
  try {
    const g=await f.start({requestId:"same"});
    assert.equal(g.creatorId,member.id);
    assert.equal((await f.start({requestId:"same"})).id,g.id);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs").get()!.n,2);
    await assert.rejects(f.start(),/진행 중/);
    await assert.rejects(f.start({},f.device),/직접 변경/);
    assert.equal((await f.room.poll(f.device,{channelId:f.channel.id})).jobs.length,0);
    const t=(await f.poll()).jobs[0];assert.equal(t.job.phase,"goal_discuss");
    assert.deepEqual(t.goal!.participants.map(p=>p.id),f.participants.map(p=>p.id));
    await assert.rejects(f.room.call({id:"foreign",name:"Foreign",kind:"user"},"goal_read",{channelId:f.channel.id,goalId:g.id}));
    await f.room.call(member,"goal_cancel",{channelId:f.channel.id,goalId:g.id});
    assert.equal((await f.room.goals.get(g.id)).status,"cancelled");
    const next=await f.start();
    await f.room.call(owner,"goal_cancel",{channelId:f.channel.id,goalId:next.id});
  }finally{f.sqlite.close();}
});
test("a two-participant majority requires explicit votes and personal conclusions from both",async()=>{
  const f=await setup();
  try{
    const g=await f.start();let t=await untilVote(f);
    await assert.rejects(f.room.complete(f.device,{jobId:t.job.id,text:"모두 동의합니다."}),/현재 초안/);
    await assert.rejects(f.room.complete(f.device,{jobId:t.job.id,goalResult:{...result(t),proposalId:"foreign"}}),/현재 초안/);
    await assert.rejects(f.room.complete(f.device,{jobId:t.job.id,goalResult:{...result(t),conclusion:""}}),/개인 결론/);
    const payload={jobId:t.job.id,goalResult:result(t)};
    await f.room.complete(f.device,payload);
    assert.equal((await f.room.goals.get(g.id)).status,"active");
    assert.equal((await f.room.complete(f.device,payload)).duplicate,true);
    t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t)});
    const done=await f.room.goals.get(g.id);assert.equal(done.outcome,"unanimous");assert.equal(done.status,"completed");
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM goalVotes").get()!.n,2);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM messages WHERE phase='goal_conclusion'").get()!.n,2);
    assert.ok(f.sqlite.prepare("SELECT count(*) n FROM goalCheckpoints").get()!.n);
    assert.equal((await f.poll()).jobs.length,0);
  }finally{f.sqlite.close();}
});

test("a failed discussion participant cannot veto the successful participants",async()=>{
  const f=await setup();
  try {
    const g=await f.start(),failed=(await f.poll()).jobs[0];
    await f.room.complete(f.device,{jobId:failed.job.id,error:"API unavailable"});
    const good=(await f.poll()).jobs[0];
    await f.room.complete(f.device,{jobId:good.job.id,goalResult:result(good)});
    assert.notEqual((await f.room.goals.get(g.id)).phase,"held");
    assert.equal((await untilVote(f)).job.phase,"goal_vote");
    assert.equal(f.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(failed.job.id)!.status,"failed");
  }finally{f.sqlite.close();}
});

for(const finalizing of [false,true])test(`five of eight approve with missing and failed participants (${finalizing?"final":"early"})`,async()=>{
  const f=await setup(8);
  try {
    const g=await f.start();
    if(finalizing)f.sqlite.prepare("UPDATE goals SET deadline=?,finalDeadline=? WHERE id=?").run(Date.now()-1,Date.now()+600000,g.id);
    const failed=await untilVote(f);
    await f.room.complete(f.device,{jobId:failed.job.id,blocked:true,error:"자동 대화 한도"});
    // Leave one claimed evaluation unanswered to exercise late completion protection.
    const late=(await f.poll()).jobs[0];
    let payload:any;
    for(let i=1;i<=5;i++) {
      const t=(await f.poll()).jobs[0];assert.equal(t.job.phase,"goal_vote");
      payload={jobId:t.job.id,goalResult:result(t)};
      await f.room.complete(f.device,payload);
      if(i<5)assert.notEqual((await f.room.goals.get(g.id)).status,"completed");
    }
    const done=await f.room.goals.get(g.id);
    assert.equal(done.status,"completed");assert.equal(done.outcome,"majority");
    const detail=await f.room.goals.detail(done);
    assert.equal(detail.votes.length,5);assert.equal(detail.opinions.length,5);assert.equal(detail.participants.length,8);
    assert.equal((await f.room.complete(f.device,payload)).duplicate,true);
    await assert.rejects(f.room.complete(f.device,{jobId:late.job.id,goalResult:result(late)}),/유효하지/);
    assert.equal((await f.poll()).jobs.length,0);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs WHERE roundId=? AND status='cancelled'").get(late.round.id)!.n,2);
  }finally{f.sqlite.close();}
});

test("four of eight is not a majority and abstentions, failures and dissent keep their places",async()=>{
  const f=await setup(8);
  try {
    const g=await f.start();let t=await untilVote(f);
    for(let i=0;i<8;i++) {
      if(i)t=(await f.poll()).jobs[0];
      await f.room.complete(f.device,i===7?{jobId:t.job.id,error:"API unavailable"}:{jobId:t.job.id,goalResult:result(t,i<4?"agree":i===6?"abstain":"disagree")});
    }
    const waiting=await f.room.goals.get(g.id);assert.equal(waiting.status,"active");assert.equal(waiting.phase,"waiting");
    assert.equal(waiting.outcome,null);assert.ok(waiting.nextRunAt>Date.now()+50000);
    const detail=await f.room.goals.detail(waiting);assert.equal(detail.votes.length,7);assert.equal(detail.participants.length,8);
    assert.equal(detail.votes.filter(v=>v.decision==="agree").length,4);
  }finally{f.sqlite.close();}
});

test("a final evaluation with no usable votes ends unresolved without another round",async()=>{
  const f=await setup();
  try {
    const g=await f.start();
    f.sqlite.prepare("UPDATE goals SET deadline=?,finalDeadline=? WHERE id=?").run(Date.now()-1,Date.now()+600000,g.id);
    let t=await untilVote(f);
    await f.room.complete(f.device,{jobId:t.job.id,error:"unavailable"});
    t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,skipped:true});
    const done=await f.room.goals.get(g.id);assert.equal(done.status,"completed");assert.equal(done.outcome,"unresolved");
    assert.equal((await f.poll()).jobs.length,0);
  }finally{f.sqlite.close();}
});

test("a required summary failure still holds without silently dropping unprocessed history",async()=>{
  const f=await setup();
  try {
    const g=await f.start();
    for(let i=0;i<2;i++){const t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t)});}
    const summary=(await f.poll()).jobs[0];assert.equal(summary.job.phase,"goal_compact");
    await f.room.complete(f.device,{jobId:summary.job.id,error:"문맥 상한 초과"});
    const held=await f.room.goals.get(g.id);assert.equal(held.phase,"held");assert.equal(held.summaryThrough,0);
    assert.equal((await f.poll()).jobs.length,0);
  }finally{f.sqlite.close();}
});
test("normal and goal histories stay separated despite a shared timeline",async()=>{
  const f=await setup();
  try{
    const normal:any=await f.room.call(owner,"message_post",{channelId:f.channel.id,text:"일반 대화",clientMessageId:"normal"});
    f.sqlite.exec("UPDATE jobs SET status='cancelled'; UPDATE rounds SET status='cancelled'");
    const g=await f.start();const first=(await f.poll()).jobs[0];
    assert.ok(!first.history.some(m=>m.id===normal.id));assert.equal(first.goal!.goal.instructions,"공유 목표 지시");
    await f.room.complete(f.device,{jobId:first.job.id,goalResult:result(first)});
    const second=(await f.poll()).jobs[0];
    assert.ok(second.history.every(m=>m.goalId===g.id));
    assert.ok(second.history.length>1,"uncompacted records are not silently truncated by goalHistoryMessageCount");
    await f.room.call(member,"goal_cancel",{channelId:f.channel.id,goalId:g.id});
    await f.room.call(owner,"message_post",{channelId:f.channel.id,text:"다시 일반",clientMessageId:"normal2"});
    const ordinary=(await f.poll()).jobs[0];assert.ok(!ordinary.goal);assert.ok(ordinary.history.every(m=>!m.goalId));
    const snapshot:any=await f.room.call(owner,"snapshot",{channelId:f.channel.id});assert.ok(snapshot.messages.some((m:any)=>m.goalId===g.id));
    const next=await f.start();const history:any=await f.room.call(member,"goal_history",{channelId:f.channel.id,goalId:next.id});
    assert.ok(history.messages.every((m:any)=>m.goalId===next.id));
  }finally{f.sqlite.close();}
});
test("new human input invalidates votes and in-flight jobs; plain chat does not",async()=>{
  const f=await setup();
  try{
    const g=await f.start(),t=await untilVote(f);
    await f.room.call(member,"message_post",{channelId:f.channel.id,goalId:g.id,text:"추가 조건",clientMessageId:"note"});
    const current=await f.room.goals.get(g.id);assert.equal(current.proposalId,null);assert.equal(current.phase,"waiting");
    await assert.rejects(f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t)}),/유효하지/);
    const count=f.sqlite.prepare("SELECT count(*) n FROM messages").get()!.n;
    await f.room.call(member,"message_post",{channelId:f.channel.id,goalId:g.id,text:"추가 조건",clientMessageId:"note"});
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM messages").get()!.n,count);
    await f.room.call(owner,"message_post",{channelId:f.channel.id,text:"일반 질문",clientMessageId:"general"});
    assert.equal((await f.room.goals.get(g.id)).revision,current.revision);
  }finally{f.sqlite.close();}
});
test("disagreement and abstention never count as consensus and respect the next-cycle interval",async()=>{
  const f=await setup();
  try{
    const g=await f.start();let t=await untilVote(f);
    await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t,"disagree")});
    t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t,"abstain")});
    const waiting=await f.room.goals.get(g.id);assert.equal(waiting.status,"active");assert.equal(waiting.phase,"waiting");
    assert.ok(waiting.nextRunAt>Date.now()+50000);assert.equal((await f.poll()).jobs.length,0);
    f.sqlite.prepare("UPDATE goals SET nextRunAt=0 WHERE id=?").run(g.id);
    const next=(await f.poll()).jobs[0];assert.ok(next);assert.equal(next.goal!.goal.cycle,2);
  }finally{f.sqlite.close();}
});
test("deadline stops discussion; final proposal and votes close with missing participants recorded",async()=>{
  const f=await setup();
  try{
    const g=await f.start(),old=(await f.poll()).jobs[0];
    f.sqlite.prepare("UPDATE goals SET deadline=?,finalDeadline=? WHERE id=?").run(Date.now()-1,Date.now()+600000,g.id);
    await assert.rejects(f.room.complete(f.device,{jobId:old.job.id,goalResult:result(old)}),/유효하지/);
    await assert.rejects(f.room.call(member,"message_post",{channelId:f.channel.id,goalId:g.id,text:"늦은 토의",clientMessageId:"late"}),/마감/);
    let t=await untilVote(f);assert.equal(t.goal!.goal.status,"finalizing");
    await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t)});
    t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,skipped:true});
    const done=await f.room.goals.get(g.id);assert.equal(done.status,"completed");assert.equal(done.outcome,"unresolved");
    assert.equal((await f.room.goals.detail(done)).votes.length,1);
  }finally{f.sqlite.close();}
});
test("expired goals close without new calls; pause preserves deadline; quota failure holds instead of retrying",async()=>{
  const f=await setup();
  try{
    const g=await f.start();const originalDeadline=g.deadline;
    await f.room.call(owner,"channel_update",{channelId:f.channel.id,paused:true});
    assert.equal((await f.room.goals.get(g.id)).deadline,originalDeadline);
    assert.equal((await f.poll()).jobs.length,0);
    await f.room.call(owner,"channel_update",{channelId:f.channel.id,paused:false});
    const t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,blocked:true,error:"호출 한도"});
    const t2=(await f.poll()).jobs[0];if(t2)await f.room.complete(f.device,{jobId:t2.job.id,skipped:true});
    assert.equal((await f.room.goals.get(g.id)).phase,"held");assert.equal((await f.poll()).jobs.length,0);
    const n=f.sqlite.prepare("SELECT count(*) n FROM jobs").get()!.n;
    f.sqlite.prepare("UPDATE goals SET deadline=1,finalDeadline=2 WHERE id=?").run(g.id);
    await f.poll();assert.equal((await f.room.goals.get(g.id)).status,"completed");
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs").get()!.n,n);
  }finally{f.sqlite.close();}
});

test("concurrent goal starts, polls and duplicate completions create one winning operation",async()=>{
  const f=await setup();
  try {
    const starts=await Promise.allSettled([f.start(),f.start()]);
    assert.equal(starts.filter(r=>r.status==="fulfilled").length,1);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM goals").get()!.n,1);
    const polled=await Promise.all([f.poll(),f.poll()]);
    const claimed=polled.flatMap(p=>p.jobs);assert.ok(claimed.length>=1);
    assert.equal(new Set(claimed.map(t=>t.job.id)).size,claimed.length);
    const t=claimed[0];
    await Promise.all([f.room.complete(f.device,{jobId:t.job.id,goalResult:{text:"first"}}),f.room.complete(f.device,{jobId:t.job.id,goalResult:{text:"second"}})]);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM messages WHERE roundId=? AND participantId=?").get(t.round.id,t.participant.id)!.n,1);
    const saved=f.sqlite.prepare("SELECT text FROM messages WHERE roundId=? AND participantId=?").get(t.round.id,t.participant.id)!.text;
    const restarted=new RoomService(f.room.db);
    await restarted.complete(f.device,{jobId:t.job.id,goalResult:{text:"replay"}});
    assert.equal(f.sqlite.prepare("SELECT text FROM messages WHERE roundId=? AND participantId=?").get(t.round.id,t.participant.id)!.text,saved);
  }finally{f.sqlite.close();}
});

test("compaction covers long history in ordered chunks and keeps evidence IDs and issues beyond the recent window",async()=>{
  const f=await setup();
  try {
    const g=await f.start();
    for(let i=0;i<47;i++)f.sqlite.prepare("INSERT INTO messages (id,channelId,ownerId,author,kind,text,goalId,phase,createdAt) VALUES (?,?,?,'Member','human',?,?,'goal_discuss',?)").run("extra"+i,f.channel.id,member.id,"기록 "+i,g.id,Date.now());
    const vote=await untilVote(f);
    const checkpoints=f.sqlite.prepare("SELECT * FROM goalCheckpoints ORDER BY throughSeq").all();assert.ok(checkpoints.length>=3);
    const latest=await f.room.goals.get(g.id);assert.equal(latest.summaryThrough,checkpoints.at(-1)!.throughSeq);
    assert.equal(latest.issues,'["검증 필요"]');
    assert.equal(vote.history.length,1);assert.ok(vote.goal!.goal.summary);
    assert.ok(vote.goal!.proposal);
    assert.equal(vote.goal!.positions.length,2);assert.ok(vote.goal!.positions.every(m=>m.phase==="goal_discuss"));
    const raw:any=await f.room.call(f.device,"goal_history",{channelId:f.channel.id,goalId:g.id,limit:20});
    assert.equal(raw.messages.length,20);assert.ok(raw.nextBefore);
    const earlier:any=await f.room.call(f.device,"goal_history",{channelId:f.channel.id,goalId:g.id,before:raw.nextBefore,limit:20});
    assert.ok(earlier.messages.at(-1).seq<raw.messages[0].seq);
    assert.ok(checkpoints.every(c=>JSON.parse(String(c.sources)).length>0));
  }finally{f.sqlite.close();}
});

test("a revised draft never inherits votes and a final deadline rejects late evaluation",async()=>{
  const f=await setup();
  try {
    const g=await f.start();let t=await untilVote(f);const oldProposal=t.goal!.proposal!.id;
    await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t)});
    t=(await f.poll()).jobs[0];await f.room.complete(f.device,{jobId:t.job.id,goalResult:result(t,"disagree")});
    f.sqlite.prepare("UPDATE goals SET nextRunAt=0 WHERE id=?").run(g.id);
    t=await untilVote(f);assert.notEqual(t.goal!.proposal!.id,oldProposal);assert.equal(t.goal!.votes.length,0);assert.equal(t.goal!.opinions.length,2);
    const payload={jobId:t.job.id,goalResult:result(t)};
    f.sqlite.prepare("UPDATE goals SET deadline=1,finalDeadline=2 WHERE id=?").run(g.id);
    await assert.rejects(f.room.complete(f.device,payload),/유효하지/);
    const ended=await f.room.goals.get(g.id);assert.equal(ended.outcome,"unresolved");
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM goalVotes WHERE proposalId=?").get(t.goal!.proposal!.id)!.n,0);
  }finally{f.sqlite.close();}
});

test("MCP can read and supplement a goal but cannot create goals or impersonate votes",async()=>{
  const f=await setup();
  try {
    const g=await f.start();
    const call=async(name:string,args:Record<string,unknown>={})=>(await handleMcp(f.room,member,{id:1,method:"tools/call",params:{name,arguments:{channelId:f.channel.id,goalId:g.id,...args}}}))!.result as any;
    assert.equal((await call("goal_read")).isError,undefined);
    assert.equal((await call("goal_list")).isError,undefined);
    assert.equal((await call("room_post",{name:"External",text:"이 조건도 확인하세요",requestId:"external"})).isError,undefined);
    const raw=JSON.parse((await call("goal_history")).content[0].text);
    assert.equal(raw.messages.at(-1).kind,"llm");assert.equal(raw.messages.at(-1).goalId,g.id);
    assert.equal((await call("goal_start")).isError,true);assert.equal((await call("job_complete")).isError,true);
    const other:Actor={id:"other",name:"Other",kind:"user"};
    await f.room.call(other,"channel_join",{channelId:f.channel.id,password:"test-password"});
    await assert.rejects(f.room.call(other,"goal_cancel",{channelId:f.channel.id,goalId:g.id}),/생성자와 방장/);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM goalVotes").get()!.n,0);
  }finally{f.sqlite.close();}
});

test("invalid poll settings never claim a job; beginning a goal cancels queued heartbeat work",async()=>{
  const f=await setup();
  try {
    await f.room.call(owner,"channel_update",{channelId:f.channel.id,heartbeatEnabled:true});
    f.sqlite.prepare("UPDATE channels SET nextHeartbeatAt=0 WHERE id=?").run(f.channel.id);
    const heartbeat=(await f.poll()).jobs[0];assert.equal(heartbeat.round.kind,"heartbeat");
    await f.start();
    assert.equal(f.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(heartbeat.job.id)!.status,"cancelled");
    await assert.rejects(f.room.poll(f.device,{channelId:f.channel.id,capabilities:["goals-v1"],goalHistoryMessageCount:-1}),/목표 기록/);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs WHERE status='running'").get()!.n,0);
  }finally{f.sqlite.close();}
});

test("chat windows deduplicate and retain at most 300 records while preserving unchanged row objects",()=>{
  const messages=Array.from({length:400},(_,i)=>({id:"m"+i,seq:i,text:"message"})) as any;
  const initial=messages.slice(0,300),updated=mergeMessageWindow(initial,messages.slice(250));
  assert.equal(updated.length,300);assert.equal(updated[0].seq,100);assert.equal(updated.at(-1)!.seq,399);
  assert.equal(updated[150],initial[250]);
  const gap=mergeMessageWindow(messages.slice(0,30),messages.slice(300));assert.equal(gap.length,100);assert.equal(gap[0].seq,300);
});

test("goal runner validates structured responses, retrieves pinned history and holds oversized context without a model call",async()=>{
  const f=await setup(),dir=await mkdtemp(path.join(os.tmpdir(),"panopticon-goals-")),ledger=new Ledger(":memory:"),files=new LocalFiles(dir);
  try {
    await f.start();const t=await untilVote(f),config=parseConfig({dataDir:dir}),profile=config.profiles[0],signal=new AbortController().signal;
    let calls=0;
    const model=async()=>{calls++;return {text:JSON.stringify({text:"그냥 동의합니다"}),usage:{},sources:[]};};
    const invalid=await executeTurn(config,profile,t,files,ledger,signal,model);
    assert.equal(invalid.blocked,true);assert.match(invalid.error!,/형식/);
    t.goal!.historyComplete=false;
    const before=calls,overflow=await executeTurn(config,profile,t,files,ledger,signal,model);assert.equal(overflow.blocked,true);assert.equal(calls,before);
    t.goal!.historyComplete=true;t.goal!.goal.instructions="x".repeat(config.turn.goalContextMaxChars);
    assert.equal((await executeTurn(config,profile,t,files,ledger,signal,model)).blocked,true);assert.equal(calls,before);
    t.goal!.goal.instructions="오래된 목표 지시";t.goal!.goal.status="finalizing";
    let step=0,historyRead=0;
    const good=await executeTurn(config,{...profile,webSearch:true},t,files,ledger,signal,async(p,instructions,input)=>{
      assert.equal(p.webSearch,false);assert.match(instructions,/마감 전에/);
      assert.match(input,/오래된 목표 지시/);assert.match(input,/검증 필요/);
      if(step++===0)return {text:JSON.stringify({tool:{name:"goal_history_read",arguments:{goalId:"foreign",limit:3}}}),usage:{},sources:[]};
      assert.match(input,/이전 원문/);return {text:JSON.stringify(result(t)),usage:{},sources:[]};
    },async args=>{historyRead++;assert.equal(args.goalId,undefined);assert.equal(args.limit,3);return {messages:[{text:"이전 원문"}]};});
    assert.equal(historyRead,1);assert.equal(good.goalResult?.decision,"agree");
    const oversized=await executeTurn(config,profile,t,files,ledger,signal,async()=>({text:JSON.stringify({tool:{name:"goal_history_read",arguments:{limit:100}}}),usage:{},sources:[]}),async()=>({text:"x".repeat(config.turn.goalContextMaxChars)}));
    assert.equal(oversized.blocked,true);assert.match(oversized.error!,/조회 결과/);
  }finally{f.sqlite.close();ledger.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});

test("goal request quotas persist once per goal while internal call limits reset per cycle",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"panopticon-goals-")),file=path.join(dir,"usage.sqlite");let ledger=new Ledger(file);
  try {
    const limits={...defaults.limits,self:1,other:0,total:1,maxTurnsPerRequest:2,automaticTurnsPerHour:5};
    const mock={round:{id:"phase-1"},goal:{goal:{id:"goal",cycle:1}}} as TurnJob;
    const first=turnBudgetId(mock);mock.round.id="phase-2";assert.equal(turnBudgetId(mock),first);
    assert.equal(ledger.reserve("discussion",first,"me","me",true,limits,Date.now(),"goal").allowed,true);
    assert.equal(ledger.chargeCall(first,true,limits),true);
    assert.equal(ledger.reserve("compact",first,"me","me",true,limits,Date.now(),"goal").allowed,true);
    assert.equal(ledger.chargeCall(first,true,limits),true);assert.equal(ledger.chargeCall(first,true,limits),false);
    assert.equal(ledger.reserve("draft",first,"me","me",true,limits,Date.now(),"goal").allowed,false);
    ledger.close();ledger=new Ledger(file);
    mock.goal!.goal.cycle=2;const second=turnBudgetId(mock);assert.notEqual(first,second);
    assert.equal(ledger.reserve("next-cycle",second,"me","me",true,limits,Date.now(),"goal").allowed,true);
    assert.equal(ledger.reserve("other-goal","other-cycle","me","me",true,limits,Date.now(),"other-goal").allowed,false);
    assert.equal(ledger.db.prepare("SELECT count(*) n FROM requests").get()!.n,1);
    assert.equal(ledger.chargeCall(second,true,limits),true);
  }finally{ledger.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});

test("channel tasks automatically include other owners and ignore legacy recipient selection",async()=>{
  const f=await setup();
  try {
    const other=await connectMember(f),legacy=await connectMember(f,false);
    const g=await f.start({participantIds:[f.participants[0].id]});
    const members=JSON.parse(g.roster);assert.equal(members.length,3);
    assert.ok(members.some((p:any)=>p.id===other.participants[0].id));
    assert.ok(!members.some((p:any)=>p.id===legacy.participants[0].id));
    const t=(await f.room.poll(other.device,{channelId:f.channel.id,capabilities:["goals-v1"]})).jobs[0];
    assert.equal(t.goal!.goal.id,g.id);assert.equal(t.job.phase,"goal_discuss");
    assert.equal(t.goal!.goal.instructions,"공유 목표 지시");
    assert.equal((await f.room.poll(legacy.device,{channelId:f.channel.id})).jobs.length,0);
  }finally{f.sqlite.close();}
});

test("new AI joins invalidate in-flight evaluations once and join the next discussion",async()=>{
  const f=await setup();
  try {
    const g=await f.start(),first=await untilVote(f),oldProposal=first.goal!.proposal!.id;
    await f.room.complete(f.device,{jobId:first.job.id,goalResult:result(first)});
    const outstanding=(await f.poll()).jobs[0],other=await connectMember(f);
    const joined=await f.room.goals.get(g.id);
    assert.equal(joined.phase,"waiting");assert.equal(joined.proposalId,null);assert.equal(JSON.parse(joined.roster).length,3);
    assert.equal(joined.deadline,g.deadline);assert.ok(joined.nextRunAt>Date.now()+50000);
    await assert.rejects(f.room.complete(f.device,{jobId:outstanding.job.id,goalResult:result(outstanding)}),/유효하지/);
    assert.equal((await f.room.goals.overview(joined)).agreeCount,0);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM goalVotes WHERE proposalId=?").get(oldProposal)!.n,1);
    await other.register();assert.equal((await f.room.goals.get(g.id)).revision,joined.revision);
    f.sqlite.prepare("UPDATE goals SET nextRunAt=0 WHERE id=?").run(g.id);
    // Complete any sequential summary work until the new discussion is ready.
    let discussion:TurnJob|undefined;
    for(let i=0;i<10&&!discussion;i++)for(const device of [f.device,other.device]) {
      const t=(await f.room.poll(device,{channelId:f.channel.id,capabilities:["goals-v1"]})).jobs[0];
      if(!t)continue;
      if(t.job.phase==="goal_discuss"){discussion=t;break;}
      await f.room.complete(device,{jobId:t.job.id,goalResult:result(t)});
    }
    assert.ok(discussion);assert.equal(discussion.goal!.participants.length,3);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs WHERE roundId=?").get(discussion.round.id)!.n,3);
    assert.equal(discussion.goal!.votes.length,0);
    // Losing a connection cannot remove that AI from the consensus denominator.
    await f.room.call(other.device,"register",{channelId:f.channel.id,profiles:[],capabilities:["goals-v1"]});
    await f.poll();assert.equal(JSON.parse((await f.room.goals.get(g.id)).roster).length,3);
  }finally{f.sqlite.close();}
});

test("an empty channel task waits for a capable runner instead of producing empty consensus",async()=>{
  const f=await setup();
  try {
    f.sqlite.exec("UPDATE participants SET goalsSupported=0");
    const g=await f.start();assert.deepEqual(JSON.parse(g.roster),[]);assert.equal(g.status,"active");
    assert.equal((await f.poll()).jobs.length,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs").get()!.n,0);
    const legacy=await connectMember(f,false);assert.equal(JSON.parse((await f.room.goals.get(g.id)).roster).length,0);
    await f.room.call(legacy.device,"register",{channelId:f.channel.id,profiles:legacy.profiles,capabilities:["goals-v1"]});
    const ready=await f.room.goals.get(g.id);assert.equal(ready.phase,"goal_discuss");assert.equal(JSON.parse(ready.roster).length,1);
    const t=(await f.room.poll(legacy.device,{channelId:f.channel.id,capabilities:["goals-v1"]})).jobs[0];assert.equal(t.goal!.goal.id,g.id);
  }finally{f.sqlite.close();}
});

test("late connections cannot expand a finalizing or completed task",async()=>{
  const f=await setup();
  try {
    const g=await f.start();
    f.sqlite.prepare("UPDATE goals SET deadline=?,finalDeadline=? WHERE id=?").run(Date.now()-1,Date.now()+600000,g.id);
    const other=await connectMember(f);let current=await f.room.goals.get(g.id);
    assert.equal(current.status,"finalizing");assert.equal(JSON.parse(current.roster).length,2);
    assert.equal((await f.room.poll(other.device,{channelId:f.channel.id,capabilities:["goals-v1"]})).jobs.length,0);
    f.sqlite.prepare("UPDATE goals SET finalDeadline=1 WHERE id=?").run(g.id);
    await f.poll();current=await f.room.goals.get(g.id);assert.equal(current.status,"completed");
    await connectMember(f);assert.equal((await f.room.goals.get(g.id)).roster,current.roster);
  }finally{f.sqlite.close();}
});

test("automatic joins respect channel pause and never retry a held task",async()=>{
  const f=await setup();
  try {
    const g=await f.start();await f.room.call(owner,"channel_update",{channelId:f.channel.id,paused:true});
    await connectMember(f);let current=await f.room.goals.get(g.id);
    assert.equal(JSON.parse(current.roster).length,3);assert.equal(current.roundId,null);assert.equal(current.deadline,g.deadline);
    f.sqlite.prepare("UPDATE goals SET phase='held',lastError='목표 보류: 호출 한도' WHERE id=?").run(g.id);
    await connectMember(f);current=await f.room.goals.get(g.id);
    assert.equal(current.phase,"held");assert.equal(current.lastError,"목표 보류: 호출 한도");assert.equal(JSON.parse(current.roster).length,4);
    await f.room.call(owner,"channel_update",{channelId:f.channel.id,paused:false});assert.equal((await f.poll()).jobs.length,0);
  }finally{f.sqlite.close();}
});
