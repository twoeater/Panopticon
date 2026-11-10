import test from "node:test";
import assert from "node:assert/strict";
import { RoomService } from "../lib/service.ts";
import { testDatabase } from "./helpers.ts";
import { handleMcp } from "../lib/mcp.ts";
import type { Actor, TurnJob } from "../lib/domain.ts";
const alice: Actor = { id: "alice", name: "Alice", kind: "user" },
  bob: Actor = { id: "bob", name: "Bob", kind: "user" };
async function setup() {
  const { db, sqlite } = testDatabase(),
    room = new RoomService(db),
    channel: any = await room.call(alice, "channel_create", {
      name: "시험실",
      password: "test-password",
    });
  const pair: any = await room.call(alice, "pair_create"),
    auth = await room.pair(pair.code, "test"),
    device = (await room.authenticate(auth.token))!;
  await room.call(device, "register", {
    channelId: channel.id,
    profiles: [
      { id: "a", name: "A", provider: "openai" },
      { id: "b", name: "B", provider: "grok" },
    ],
  });
  return { room, sqlite, channel, device, auth };
}

test("EXAONE and compatible providers register, change provider and receive jobs without storing credentials", async () => {
  const { room, sqlite, channel, device } = await setup();
  try {
    const profiles = [
      { id: "exa", name: "EXAONE", provider: "exaone", apiKey: "private-test-key", baseURL: "https://private-gateway.example/v1" },
      { id: "custom", name: "Custom", provider: "openai-compatible" },
    ];
    const registered: any = await room.call(device, "register", { channelId: channel.id, profiles });
    assert.deepEqual(registered.map((p: any) => p.provider).sort(), ["exaone", "openai-compatible"]);
    assert.doesNotMatch(JSON.stringify(registered), /private-test-key|private-gateway/);
    await room.call(alice, "message_post", { channelId: channel.id, text: "test", clientMessageId: "new-providers" });
    const turn: any = await room.call(device, "poll", { channelId: channel.id, historyMessageCount: 0, claim: true });
    assert.equal(turn.jobs.length, 1);
    assert.ok(["exaone", "openai-compatible"].includes(turn.jobs[0].participant.provider));
    await room.call(device, "register", { channelId: channel.id, profiles: [{ id: "exa", name: "Changed", provider: "openai-compatible" }] });
    const snapshot: any = await room.call(alice, "snapshot", { channelId: channel.id });
    const changed = snapshot.participants.find((p: any) => p.profileId === "exa");
    assert.equal(changed.provider, "openai-compatible");
    for (const provider of ["gemini", "unknown"])
      await assert.rejects(room.call(device, "register", { channelId: channel.id, profiles: [{ id: "bad", name: "Bad", provider }] }), /지원하지/);
  } finally { sqlite.close(); }
});
test("password, memberships, one-use pairing, device revocation and bans", async () => {
  const { room, sqlite, channel, device, auth } = await setup();
  try {
    await assert.rejects(
      room.call(bob, "snapshot", { channelId: channel.id }),
      /접근/,
    );
    await assert.rejects(
      room.call(bob, "channel_join", {
        channelId: channel.id,
        password: "wrong",
      }),
      /확인/,
    );
    await room.call(bob, "channel_join", {
      channelId: channel.id,
      password: "test-password",
    });
    await room.call(bob, "snapshot", { channelId: channel.id });
    await assert.rejects(
      room.call(device, "channel_update", {
        channelId: channel.id,
        paused: true,
      }),
      /직접/,
    );
    await room.call(alice, "member_remove", {
      channelId: channel.id,
      userId: bob.id,
    });
    await assert.rejects(
      room.call(bob, "channel_join", {
        channelId: channel.id,
        password: "test-password",
      }),
      /확인/,
    );
    const pairing: any = await room.call(alice, "pair_create");
    await room.pair(pairing.code, "once");
    await assert.rejects(room.pair(pairing.code, "twice"), /만료/);
    await room.call(alice, "device_revoke", { deviceId: auth.deviceId });
    assert.equal(await room.authenticate(auth.token), null);
  } finally {
    sqlite.close();
  }
});
test("blind answers, message-count context, idempotency, full verification and AI answer re-verification", async () => {
  const { room, sqlite, channel, device } = await setup();
  const channelId = channel.id;
  try {
    await room.call(alice, "channel_update", { channelId, paused: true });
    for (let n = 0; n < 5; n++)
      await room.call(alice, "message_post", {
        channelId,
        text: `old${n}`,
        clientMessageId: String(n),
      });
    await room.call(alice, "channel_update", { channelId, paused: false });
    const args = {
        channelId,
        text: "2+2?",
        clientMessageId: "question",
        verify: true,
      },
      msg: any = await room.call(alice, "message_post", args);
    assert.equal(
      ((await room.call(alice, "message_post", args)) as any).id,
      msg.id,
    );
    let phaseCount: Record<string, number> = {},
      firstJob: TurnJob | null = null;
    for (let n = 0; n < 8; n++) {
      const turn = (
        await room.poll(device, { channelId, historyMessageCount: n ? 0 : 2 })
      ).jobs[0];
      if (!turn) break;
      firstJob ||= turn;
      phaseCount[turn.job.phase] = (phaseCount[turn.job.phase] || 0) + 1;
      assert.equal(turn.history.length, n ? 0 : 2);
      assert.equal(turn.trigger?.id, msg.id);
      if (turn.job.phase === "chat") assert.deepEqual(turn.phaseMessages, []);
      else assert.ok(turn.phaseMessages.length >= 2);
      const result = {
        jobId: turn.job.id,
        ...(turn.job.phase === "review"
          ? { skipped: true }
          : { text: "4", evidence: [{ type: "code", stdout: "4" }] }),
      };
      await room.complete(device, result);
      await room.complete(device, result);
    }
    assert.deepEqual(phaseCount, { chat: 2, review: 2, revise: 2, summary: 1 });
    const snapshot: any = await room.call(alice, "snapshot", { channelId });
    assert.equal(
      snapshot.messages.filter((m: any) => m.kind === "llm").length,
      5,
    );
    assert.equal(snapshot.rounds[0].status, "completed");
    await room.call(alice, "verification_start", {
      channelId,
      messageId: `answer:${firstJob!.job.id}`,
      requestId: "verify-ai",
    });
  } finally {
    sqlite.close();
  }
});
test("heartbeat participation settings default to three, persist and require channel ownership", async () => {
  const {room,sqlite,channel,device}=await setup();
  try {
    assert.equal(channel.heartbeatParticipants,3);
    await room.call(bob,"channel_join",{channelId:channel.id,password:"test-password"});
    for(const actor of [bob,device])
      await assert.rejects(room.call(actor,"channel_update",{channelId:channel.id,heartbeatParticipants:0}));
    for(const count of [1,7,1000,0]) {
      const saved:any=await room.call(alice,"channel_update",{channelId:channel.id,heartbeatParticipants:count});
      assert.equal(saved.heartbeatParticipants,count);
      assert.equal((await room.call(alice,"snapshot",{channelId:channel.id}) as any).channel.heartbeatParticipants,count);
      assert.equal((await room.call(alice,"bootstrap") as any).channels[0].heartbeatParticipants,count);
    }
    await room.call(alice,"channel_update",{channelId:channel.id,situation:"keep the participation setting"});
    for(const value of [-1,1.5,1001,NaN,Infinity,"3","all",null,true])
      await assert.rejects(room.call(alice,"channel_update",{channelId:channel.id,heartbeatParticipants:value}),/참여 인원/);
    assert.equal((await room.member(alice,channel.id)).heartbeatParticipants,0);
  } finally {sqlite.close();}
});

test("heartbeat rosters use the selected cap or all eligible AI across users without changing normal chats", async () => {
  const {room,sqlite,channel,device}=await setup();
  try {
    await room.call(device,"register",{channelId:channel.id,profiles:["a","b","c","d","offline","disabled"].map(id=>({id,name:id,provider:"openai"}))});
    await room.call(bob,"channel_join",{channelId:channel.id,password:"test-password"});
    const pair:any=await room.call(bob,"pair_create");
    const auth=await room.pair(pair.code,"second-user");
    const other=(await room.authenticate(auth.token))!;
    await room.call(other,"register",{channelId:channel.id,profiles:[{id:"other",name:"Other",provider:"grok"}]});
    const revokedPair:any=await room.call(bob,"pair_create");
    const revokedAuth=await room.pair(revokedPair.code,"revoked-device");
    const revoked=(await room.authenticate(revokedAuth.token))!;
    assert.ok(revoked.deviceId);
    await room.call(revoked,"register",{channelId:channel.id,profiles:[{id:"revoked",name:"Revoked",provider:"grok"}]});
    sqlite.prepare("UPDATE participants SET onlineAt=0 WHERE profileId='offline'").run();
    sqlite.prepare("UPDATE participants SET enabled=0 WHERE profileId='disabled'").run();
    sqlite.prepare("UPDATE devices SET revoked=1 WHERE id=?").run(revoked.deviceId);
    const excluded=sqlite.prepare("SELECT id FROM participants WHERE profileId IN ('offline','disabled','revoked')").all().map(p=>p.id);
    const eligible=sqlite.prepare("SELECT id FROM participants WHERE profileId IN ('a','b','c','d','other')").all().map(p=>p.id);
    for(const [count,expected] of [[3,3],[1,1],[2,2],[10,5],[0,5]]) {
      const saved:any=await room.call(alice,"channel_update",{channelId:channel.id,heartbeatParticipants:count});
      const roundId=`heartbeat-${count}`;
      await room.startRound(alice,saved,null,"heartbeat",roundId);
      const round:any=sqlite.prepare("SELECT * FROM rounds WHERE id=?").get(roundId);
      const roster:string[]=JSON.parse(round.roster);
      assert.equal(roster.length,expected);
      assert.equal(new Set(roster).size,expected);
      assert.ok(roster.every(id=>!excluded.includes(id)));
      if(count===0) assert.deepEqual([...roster].sort(),[...eligible].sort());
      const starter:any=sqlite.prepare("SELECT * FROM jobs WHERE roundId=?").get(roundId);
      assert.equal(starter.participantId,roster[0]);
      assert.equal(starter.phase,"heartbeat");
      const starterDevice=sqlite.prepare("SELECT deviceId FROM participants WHERE id=?").get(starter.participantId)?.deviceId;
      const owner=starterDevice===other.deviceId?other:device;
      sqlite.prepare("UPDATE jobs SET status='running',startedAt=? WHERE id=?").run(Date.now(),starter.id);
      // A saved setting must not change the roster of an already running round.
      await room.call(alice,"channel_update",{channelId:channel.id,heartbeatParticipants:count===0?1:0});
      await room.complete(owner,{jobId:starter.id,text:"a topic"});
      const replies=sqlite.prepare("SELECT participantId FROM jobs WHERE roundId=? AND phase='review'").all(roundId).map(j=>j.participantId);
      assert.deepEqual(replies.sort(),roster.slice(1).sort());
    }
    const saved:any=await room.call(alice,"channel_update",{channelId:channel.id,heartbeatParticipants:1});
    await room.startRound(alice,saved,null,"chat","regular-chat");
    const normal:any=sqlite.prepare("SELECT roster FROM rounds WHERE id='regular-chat'").get();
    assert.equal(JSON.parse(normal.roster).length,5);
  } finally {sqlite.close();}
});

test("pause cancels queued work and stale completion, expired work never requeues, heartbeat is bounded", async () => {
  const { room, sqlite, channel, device } = await setup(),
    channelId = channel.id;
  try {
    await room.call(alice, "message_post", {
      channelId,
      text: "hello",
      clientMessageId: "x",
    });
    const job = (await room.poll(device, { channelId })).jobs[0];
    await room.call(alice, "channel_update", { channelId, paused: true });
    await assert.rejects(
      room.complete(device, { jobId: job.job.id, text: "late" }),
      /종료/,
    );
    assert.equal((await room.poll(device, { channelId })).jobs.length, 0);
    await room.call(alice, "channel_update", { channelId, paused: false });
    sqlite
      .prepare("UPDATE channels SET nextHeartbeatAt=0 WHERE id=?")
      .run(channelId);
    const beat = (await room.poll(device, { channelId })).jobs[0];
    assert.equal(beat.job.phase, "heartbeat");
    await room.complete(device, { jobId: beat.job.id, text: "topic" });
    const reply = (await room.poll(device, { channelId })).jobs[0];
    assert.equal(reply.job.phase, "review");
    await room.complete(device, { jobId: reply.job.id, text: "yes" });
    assert.equal((await room.poll(device, { channelId })).jobs.length, 0);
    await room.call(alice, 'message_post', {channelId, text:'disconnect test', clientMessageId:'lost'});
    const lost = (await room.poll(device, {channelId})).jobs[0];
    sqlite.prepare('UPDATE participants SET onlineAt=? WHERE id=?').run(Date.now()-121000,lost.participant.id);
    await room.poll(device, {channelId,claim:false});
    assert.equal((await room.call(device,'job_state',{jobId:lost.job.id}) as any).status,'uncertain');
    await assert.rejects(room.complete(device,{jobId:lost.job.id,text:'uncertain result'}),/종료/);
  } finally {
    sqlite.close();
  }
});
test("MCP uses the caller identity, device cannot administer, external posts dedupe", async () => {
  const { room, sqlite, channel, device } = await setup();
  try {
    const request = {
      id: 1,
      method: "tools/call",
      params: {
        name: "room_post",
        arguments: {
          channelId: channel.id,
          name: "external",
          text: "hi",
          requestId: "one",
        },
      },
    };
    assert.equal(
      ((await handleMcp(room, bob, request)) as any).result.isError,
      true,
    );
    await handleMcp(room, device, request);
    await handleMcp(room, device, request);
    const snapshot: any = await room.call(alice, "snapshot", {
      channelId: channel.id,
    });
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].ownerId, alice.id);
  } finally {
    sqlite.close();
  }
});
