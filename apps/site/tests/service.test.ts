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
