import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {resolveMentions,mentionQuery,readMentions,updateMentionSelections} from "../lib/mentions.ts";
import {RoomService} from "../lib/service.ts";
import {testDatabase} from "./helpers.ts";
import {handleMcp} from "../lib/mcp.ts";
import {buildContext} from "../runner/context.ts";
import {LocalFiles} from "../runner/files.ts";
import type {Actor,Participant,Message,TurnJob} from "../lib/domain.ts";

test("mentions resolve multiple names, spaces, punctuation and case without matching email, URLs or code",()=>{
  const candidates=[{id:"q",name:"Qwen"},{id:"g",name:"GPT"},{id:"api",name:"GPT API"},{id:"ko",name:"검증자"}];
  const result=resolveMentions("@qwen, @GPT API 검토하고 (@검증자)도 확인해줘. @Qwen",candidates);
  assert.equal(result.error,undefined);
  assert.deepEqual(result.mentions.map(m=>m.id),["q","api","ko"]);
  for(const text of ["observer@example.test", "https://example.test/@Qwen", "`@Qwen`", "```js\n@Qwen\n```", "~~~\n@GPT\n~~~", "\\@Qwen"])
    assert.deepEqual(resolveMentions(text,candidates).mentions,[],text);
  assert.ok(resolveMentions("@Unknown 확인",candidates).error);
  assert.ok(resolveMentions("@Qwen-other 확인",candidates).error);
  assert.ok(resolveMentions("@",candidates).error);
  assert.deepEqual(mentionQuery("질문 @GPT A",9),{start:3,end:9,query:"gpt a"});
  assert.equal(mentionQuery("`@Qwen`",7),null);
});

test("duplicate display names require an explicit participant selection",()=>{
  const candidates=[{id:"one",name:"Qwen"},{id:"two",name:"Qwen"}];
  assert.match(resolveMentions("@Qwen 안녕",candidates).error!,/같은 이름/);
  assert.deepEqual(resolveMentions("@Qwen 안녕",candidates,["two"]).mentions,[candidates[1]]);
  assert.deepEqual(resolveMentions("@Qwen @Qwen 안녕",candidates,["one","two"]).mentions,candidates);
});

test("editing or removing a chosen mention cannot retain its old recipient",()=>{
  const selected=[{id:"one",start:0,end:5},{id:"two",start:6,end:11}];
  assert.deepEqual(updateMentionSelections("@Qwen @Qwen ","@Qwen ",selected),[selected[0]]);
  assert.deepEqual(updateMentionSelections("@Qwen @Qwen ","@Qwen @Grok ",selected),[selected[0]]);
  assert.deepEqual(updateMentionSelections("@Qwen ","",[selected[0]]),[]);
  assert.deepEqual(updateMentionSelections("@Qwen ","질문 @Qwen ",[selected[0]]),[{id:"one",start:3,end:8}]);
});

const alice:Actor={id:"alice",name:"Alice",kind:"user"};
const bob:Actor={id:"bob",name:"Bob",kind:"user"};
async function setup() {
  const {db,sqlite}=testDatabase(), room=new RoomService(db);
  const channel:any=await room.call(alice,"channel_create",{name:"mentions",password:"test-password"});
  await room.call(alice,"channel_update",{channelId:channel.id,heartbeatEnabled:false});
  async function connect(actor:Actor,profiles:{id:string;name:string;provider:string}[]) {
    if(actor.id!==alice.id) await room.call(actor,"channel_join",{channelId:channel.id,password:"test-password"});
    const pair:any=await room.call(actor,"pair_create");
    const auth=await room.pair(pair.code,"fixture");
    const device=(await room.authenticate(auth.token))!;
    const participants=await room.call(device,"register",{channelId:channel.id,profiles}) as Participant[];
    return {device,participants};
  }
  const local=await connect(alice,[{id:"a",name:"A",provider:"openai"},{id:"b",name:"B",provider:"grok"}]);
  const remote=await connect(bob,[{id:"c",name:"C",provider:"openai-compatible"}]);
  return {room,sqlite,channel,local,remote,connect};
}

test("only mentioned AI receive any phase, while all participants retain the directed exchange in later context",async()=>{
  const {room,sqlite,channel,local,remote}=await setup();
  const directory=await mkdtemp(path.join(os.tmpdir(),"panopticon-mention-"));
  try {
    const targetIds=[local.participants.find(p=>p.name==="A")!.id,remote.participants[0].id];
    const message=await room.call(alice,"message_post",{channelId:channel.id,text:"@A @C 같이 검증해줘",verify:true,clientMessageId:"directed"}) as Message;
    assert.deepEqual(readMentions(message.mentions).map(m=>m.id),targetIds);
    const phases:string[]=[];
    for(let i=0;i<10;i++) {
      let received=false;
      for(const {device} of [local,remote]) {
        const turn=(await room.poll(device,{channelId:channel.id,historyMessageCount:10})).jobs[0];
        if(!turn) continue;
        received=true;
        assert.ok(targetIds.includes(turn.participant.id));
        assert.deepEqual(JSON.parse(turn.round.targetParticipantIds),targetIds);
        phases.push(turn.job.phase);
        await room.complete(device,{jobId:turn.job.id,text:`${turn.participant.name} ${turn.job.phase}`});
      }
      if(!received) break;
    }
    assert.deepEqual(phases.sort(),["chat","chat","review","review","revise","revise","summary"].sort());
    const jobs=sqlite.prepare("SELECT participantId FROM jobs").all();
    assert.ok(jobs.every(j=>targetIds.includes(String(j.participantId))));
    // Retrying the same send cannot widen its recipients or duplicate messages.
    const duplicate:any=await room.call(alice,"message_post",{channelId:channel.id,text:"@B changed retry",clientMessageId:"directed"});
    assert.equal(duplicate.id,message.id);
    assert.deepEqual(readMentions(duplicate.mentions).map(m=>m.id),targetIds);
    const answer:any=sqlite.prepare("SELECT id FROM messages WHERE roundId=? AND kind='llm' ORDER BY seq LIMIT 1").get(`question:${message.id}`);
    const verification:any=await room.call(alice,"verification_start",{channelId:channel.id,messageId:answer.id,requestId:"reverify"});
    assert.deepEqual(JSON.parse(verification.targetParticipantIds),targetIds);
    assert.ok(JSON.parse(verification.roster).every((id:string)=>targetIds.includes(id)));
    // Finish the test's re-verification so the next round is the only pending work.
    sqlite.prepare("UPDATE jobs SET status='cancelled' WHERE roundId=?").run(verification.id);
    sqlite.prepare("UPDATE rounds SET status='cancelled' WHERE id=?").run(verification.id);
    await room.call(alice,"message_post",{channelId:channel.id,text:"이번에는 모두 확인",clientMessageId:"broadcast"});
    let outsider:TurnJob|undefined;
    for(let i=0;i<3;i++) {
      const turn=(await room.poll(local.device,{channelId:channel.id,historyMessageCount:20})).jobs[0];
      assert.ok(turn);
      if(turn.participant.name==="B") {outsider=turn;break;}
      await room.complete(local.device,{jobId:turn.job.id,text:"normal answer"});
    }
    assert.ok(outsider);
    assert.ok(outsider.history.some(m=>m.id===message.id));
    assert.ok(outsider.history.some(m=>m.id===answer.id));
    const files=new LocalFiles(directory); await files.initialize("b");
    const context=await buildContext(outsider,{id:"b",name:"B",provider:"grok",transport:"cli",enabled:true},files);
    const history=JSON.parse(context.input).history;
    assert.deepEqual(history.find((m:any)=>m.id===message.id).mentions.map((m:any)=>m.id),targetIds);
  } finally {sqlite.close();await rm(directory,{recursive:true,force:true});}
});

test("unknown, foreign and ambiguous mentions never broadcast; offline mentions remain recorded without jobs",async()=>{
  const {room,sqlite,channel,local,remote}=await setup();
  try {
    await room.call(remote.device,"register",{channelId:channel.id,profiles:[{id:"c",name:"A",provider:"grok"}]});
    for(const [text,ids] of [["@Missing hello",undefined],["@A hello",undefined],["@A hello",["foreign-participant"]],["plain text",[local.participants[0].id]]] as const)
      await assert.rejects(room.call(alice,"message_post",{channelId:channel.id,text,targetParticipantIds:ids,clientMessageId:crypto.randomUUID()}));
    assert.equal(sqlite.prepare("SELECT count(*) n FROM messages").get()!.n,0);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM jobs").get()!.n,0);
    const selected=remote.participants[0].id;
    const chosen:any=await room.call(alice,"message_post",{channelId:channel.id,text:"@A hello",targetParticipantIds:[selected],clientMessageId:"choose-duplicate"});
    assert.deepEqual(readMentions(chosen.mentions).map(m=>m.id),[selected]);
    assert.equal((await room.poll(local.device,{channelId:channel.id})).jobs.length,0);
    const turn=(await room.poll(remote.device,{channelId:channel.id})).jobs[0];
    assert.equal(turn.participant.id,selected);
    await room.complete(remote.device,{jobId:turn.job.id,skipped:true});
    const b=local.participants.find(p=>p.name==="B")!;
    sqlite.prepare("UPDATE participants SET onlineAt=0 WHERE id=?").run(b.id);
    const offline:any=await room.call(alice,"message_post",{channelId:channel.id,text:"@B 나중에 참고해",clientMessageId:"offline"});
    const round:any=sqlite.prepare("SELECT * FROM rounds WHERE triggerId=?").get(offline.id);
    assert.equal(round.status,"no_participants");
    assert.deepEqual(JSON.parse(round.targetParticipantIds),[b.id]);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM jobs WHERE roundId=?").get(round.id)!.n,0);
    await room.call(alice,"channel_update",{channelId:channel.id,paused:true});
    const saved:any=await room.call(alice,"message_post",{channelId:channel.id,text:"@B 일시정지 중 기록",clientMessageId:"paused-valid"});
    assert.deepEqual(readMentions(saved.mentions).map(m=>m.id),[b.id]);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM rounds WHERE triggerId=?").get(saved.id)!.n,0);
    const paused:any=await room.call(alice,"message_post",{channelId:channel.id,text:"@C missing after rename",clientMessageId:"paused-invalid"}).catch(()=>null);
    assert.equal(paused,null);
  } finally {sqlite.close();}
});

test("MCP external mentions use the same routing and preserve their targets during verification",async()=>{
  const {room,sqlite,channel,local,remote}=await setup();
  try {
    const result:any=await handleMcp(room,alice,{id:1,method:"tools/call",params:{name:"room_post",arguments:{channelId:channel.id,name:"Visitor",text:"@C 검토 부탁해",requestId:"external-directed"}}});
    assert.ok(!result.result.isError);
    assert.equal((await room.poll(local.device,{channelId:channel.id})).jobs.length,0);
    const turn=(await room.poll(remote.device,{channelId:channel.id})).jobs[0];
    assert.equal(turn.participant.name,"C");
    assert.deepEqual(JSON.parse(turn.round.targetParticipantIds),[remote.participants[0].id]);
  } finally {sqlite.close();}
});
