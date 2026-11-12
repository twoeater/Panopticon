import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import {RoomService} from "../lib/service.ts";
import {reconcileMessageWindow} from "../lib/message-window.ts";
import {testDatabase} from "./helpers.ts";
import type {Actor,Channel,Message} from "../lib/domain.ts";

const owner:Actor={id:"owner",name:"Owner",kind:"user"};
async function fixture(){
  const {db,sqlite}=testDatabase(),room=new RoomService(db);
  const channel=await room.call(owner,"channel_create",{name:"retention",password:"test-password"}) as Channel;
  const insert=(n:number,goalId:string|null=null,channelId=channel.id)=>{
    const q=sqlite.prepare("INSERT INTO messages (id,channelId,ownerId,author,kind,text,phase,goalId,createdAt) VALUES (?,?,?,'Author','llm','text','chat',?,?)");
    for(let i=0;i<n;i++)q.run(crypto.randomUUID(),channelId,owner.id,goalId,Date.now());
  };
  const count=(goalId:string|null=null)=>Number(sqlite.prepare("SELECT count(*) n FROM messages WHERE channelId=? AND goalId IS ?").get(channel.id,goalId)!.n);
  return {db,sqlite,room,channel,insert,count};
}
test("general retention defaults to 1000, preserves every goal and other channels, and paginates remaining history",async()=>{
  const f=await fixture();try{
    f.insert(650);f.insert(20,"goal-one");f.insert(650);f.insert(30,"goal-two");f.insert(7,null,"another-channel");
    const expected=f.sqlite.prepare("SELECT id FROM messages WHERE channelId=? AND goalId IS NULL ORDER BY seq DESC LIMIT 1000").all(f.channel.id).map(x=>x.id);
    const snapshot:any=await f.room.call(owner,"snapshot",{channelId:f.channel.id});
    assert.equal(snapshot.channel.generalMessageLimit,1000);assert.equal(f.count(),1000);
    assert.equal(f.count("goal-one"),20);assert.equal(f.count("goal-two"),30);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM messages WHERE channelId='another-channel'").get()!.n,7);
    assert.deepEqual(f.sqlite.prepare("SELECT id FROM messages WHERE channelId=? AND goalId IS NULL ORDER BY seq DESC").all(f.channel.id).map(x=>x.id),expected);
    let page=snapshot,total=page.messages.length;
    while(page.messages.length){page=await f.room.call(owner,"snapshot",{channelId:f.channel.id,before:page.messages[0].seq});total+=page.messages.length;}
    assert.equal(total,1050);
    assert.ok(snapshot.channel.generalPrunedThrough>0);
  }finally{f.sqlite.close();}
});
test("owner settings prune immediately, zero disables retention, increasing cannot restore deleted messages",async()=>{
  const f=await fixture();try{
    f.insert(10);f.insert(4,"saved-goal");
    const update=(limit:unknown,actor=owner)=>f.room.call(actor,"channel_update",{channelId:f.channel.id,generalMessageLimit:limit});
    const outsider={id:"member",name:"Member",kind:"user"} as Actor;
    await f.room.call(outsider,"channel_join",{channelId:f.channel.id,password:"test-password"});
    await assert.rejects(update(5,outsider),/방장/);
    for(const bad of [-1,1.5,100001,"5",null])await assert.rejects(update(bad),/보관 개수/);
    await update(5);assert.equal(f.count(),5);assert.equal(f.count("saved-goal"),4);
    await update(0);f.insert(20);await f.room.pruneGeneralMessages(f.channel.id);assert.equal(f.count(),25);
    await update(100);assert.equal(f.count(),25);
    await update(1);assert.equal(f.count(),1);assert.equal(f.count("saved-goal"),4);
  }finally{f.sqlite.close();}
});
test("human posts, MCP posts and runner completions enforce retention without a browser polling",async()=>{
  const f=await fixture();try{
    await f.room.call(owner,"channel_update",{channelId:f.channel.id,generalMessageLimit:2,heartbeatEnabled:false});
    f.insert(2);
    await f.room.call(owner,"message_post",{channelId:f.channel.id,clientMessageId:"human",text:"question"});assert.equal(f.count(),2);
    await f.room.call(owner,"agent_post",{channelId:f.channel.id,requestId:"mcp",name:"MCP",text:"reply"});assert.equal(f.count(),2);
    const pair:any=await f.room.call(owner,"pair_create"),auth=await f.room.pair(pair.code,"runner"),device=(await f.room.authenticate(auth.token))!;
    await f.room.call(device,"register",{channelId:f.channel.id,profiles:[{id:"ai",name:"AI",provider:"openai"}]});
    await f.room.call(owner,"message_post",{channelId:f.channel.id,clientMessageId:"runner-question",text:"new question"});
    const turn=(await f.room.poll(device,{channelId:f.channel.id,claim:true})).jobs[0];assert.ok(turn);
    await f.room.complete(device,{jobId:turn.job.id,text:"runner reply"});assert.equal(f.count(),2);
    await Promise.all([f.room.pruneGeneralMessages(f.channel.id),f.room.pruneGeneralMessages(f.channel.id)]);assert.equal(f.count(),2);
  }finally{f.sqlite.close();}
});
test("migration adds defaults without deleting old records",()=>{
  const sqlite=new DatabaseSync(":memory:");try{
    const dir=new URL("../drizzle/",import.meta.url);
    const files=readdirSync(dir).filter(x=>x.endsWith(".sql")).sort();
    for(const name of files.slice(0,-1))sqlite.exec(readFileSync(new URL(name,dir),"utf8"));
    sqlite.exec("INSERT INTO channels (id,name,ownerId,passwordHash,nextHeartbeatAt,createdAt) VALUES ('old','Old','owner','hash',0,0)");
    sqlite.exec("INSERT INTO messages (id,channelId,ownerId,author,kind,text,phase,createdAt) VALUES ('old-message','old','owner','Owner','human','original','chat',0)");
    sqlite.exec(readFileSync(new URL(files.at(-1)!,dir),"utf8"));
    assert.equal(sqlite.prepare("SELECT generalMessageLimit FROM channels").get()!.generalMessageLimit,1000);
    assert.equal(sqlite.prepare("SELECT text FROM messages").get()!.text,"original");
  }finally{sqlite.close();}
});
test("open chat and history pages remove pruned general messages while preserving goal messages; goal deletion invalidates cached windows",()=>{
  const old={historyRevision:0,generalPrunedThrough:0} as Channel;
  const channel={historyRevision:0,generalPrunedThrough:3} as Channel;
  const messages=[{id:"1",seq:1},{id:"2",seq:2,goalId:"goal"},{id:"3",seq:3},{id:"4",seq:4}] as Message[];
  assert.deepEqual(reconcileMessageWindow(messages,[],old,channel).map(m=>m.id),["2","4"]);
  assert.deepEqual(reconcileMessageWindow(messages,[],old,channel,true).map(m=>m.id),["2","4"]);
  const deleted={...channel,historyRevision:1};
  assert.deepEqual(reconcileMessageWindow(messages,[messages[3]],channel,deleted,true).map(m=>m.id),["4"]);
  assert.deepEqual(reconcileMessageWindow([messages[3]],messages,deleted,channel).map(m=>m.id),["4"]);
});
