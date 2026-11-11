import {
  AppError,
  requiredString,
  id,
  now,
  type Actor,
  type Database,
  type Channel,
  type Participant,
  type Message,
  type Job,
  type Round,
  type TurnJob,
  type Phase,
} from "./domain.ts";
import {
  digest,
  secret,
  passwordHash,
  verifyPassword,
  rateLimit,
} from "./security.ts";
import { isActiveProvider } from "./providers.ts";
import { resolveMentions, readMentions } from "./mentions.ts";
import { Goals } from "./goals.ts";

const channelColumns =
  "id,name,ownerId,situation,situationVersion,heartbeatEnabled,heartbeatSeconds,heartbeatParticipants,nextHeartbeatAt,paused,createdAt";
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export class RoomService {
  db: Database;
  goals: Goals;
  constructor(db: Database) {
    this.db = db;
    this.goals = new Goals(this);
  }
  async all<T>(sql: string, ...args: unknown[]) {
    return (
      await this.db
        .prepare(sql)
        .bind(...args)
        .all<T>()
    ).results;
  }
  async one<T>(sql: string, ...args: unknown[]) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .first<T>();
  }
  async run(sql: string, ...args: unknown[]) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .run();
  }
  async authenticate(token: string): Promise<Actor | null> {
    const device = await this.one<{
      id: string;
      ownerId: string;
      ownerName: string;
    }>(
      "SELECT * FROM devices WHERE tokenHash=? AND revoked=0",
      await digest(token),
    );
    return device
      ? {
          id: device.ownerId,
          name: device.ownerName,
          kind: "device",
          deviceId: device.id,
        }
      : null;
  }
  user(actor: Actor) {
    if (actor.kind !== "user")
      throw new AppError(
        403,
        "user_required",
        "로그인한 사용자가 직접 변경해야 합니다.",
      );
  }
  async member(actor: Actor, channelId: string): Promise<Channel> {
    const membership = await this.one<{ banned: number }>(
      "SELECT banned FROM members WHERE channelId=? AND userId=?",
      channelId,
      actor.id,
    );
    if (!membership || membership.banned)
      throw new AppError(
        403,
        "channel_forbidden",
        "이 채널에 접근할 수 없습니다.",
      );
    const channel = await this.one<Channel>(
      `SELECT ${channelColumns} FROM channels WHERE id=?`,
      channelId,
    );
    if (!channel)
      throw new AppError(404, "not_found", "채널을 찾을 수 없습니다.");
    return channel;
  }
  async owner(actor: Actor, channelId: string) {
    this.user(actor);
    const channel = await this.member(actor, channelId);
    if (channel.ownerId !== actor.id)
      throw new AppError(403, "owner_required", "방장만 변경할 수 있습니다.");
    return channel;
  }
  async call(
    actor: Actor,
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    switch (action) {
      case "goal_start": return this.goals.start(actor,args);
      case "goal_cancel": return this.goals.cancel(actor,args);
      case "goal_retry": return this.goals.retry(actor,args);
      case "goal_list": return this.goals.list(actor,args);
      case "goal_read": return this.goals.read(actor,args);
      case "goal_history": return this.goals.history(actor,args);
      case "bootstrap":
        return {
          user: { id: actor.id, name: actor.name },
          channels: await this.all<Channel>(
            `SELECT ${channelColumns
              .split(",")
              .map((x) => `c.${x}`)
              .join(
                ",",
              )} FROM channels c JOIN members m ON c.id=m.channelId WHERE m.userId=? AND m.banned=0 ORDER BY c.createdAt`,
            actor.id,
          ),
          devices:
            actor.kind === "user"
              ? await this.all(
                  "SELECT id,name,createdAt,revoked FROM devices WHERE ownerId=?",
                  actor.id,
                )
              : [],
        };
      case "channel_create": {
        this.user(actor);
        await rateLimit(this.db, `create:${actor.id}`, 10, 3600000);
        const name = requiredString(args.name, "채널 이름", 60),
          password = requiredString(args.password, "비밀번호", 256);
        if (password.length < 8)
          throw new AppError(
            400,
            "password_short",
            "비밀번호는 8자 이상이어야 합니다.",
          );
        const channelId = id(),
          time = now();
        await this.db.batch([
          this.db
            .prepare(
              "INSERT INTO channels (id,name,ownerId,passwordHash,situation,nextHeartbeatAt,createdAt) VALUES (?,?,?,?,?,?,?)",
            )
            .bind(
              channelId,
              name,
              actor.id,
              await passwordHash(password),
              "",
              time + 180000,
              time,
            ),
          this.db
            .prepare(
              "INSERT INTO members (channelId,userId,name) VALUES (?,?,?)",
            )
            .bind(channelId, actor.id, actor.name),
        ]);
        return this.member(actor, channelId);
      }
      case "channel_join": {
        const channelId = requiredString(args.channelId, "채널 ID", 100);
        await rateLimit(this.db, `join:${actor.id}`, 10, 600000);
        const banned = await this.one<{ banned: number }>(
          "SELECT banned FROM members WHERE channelId=? AND userId=?",
          channelId,
          actor.id,
        );
        const channel = await this.one<Channel & { passwordHash: string }>(
          "SELECT * FROM channels WHERE id=?",
          channelId,
        );
        if (
          banned?.banned ||
          !channel ||
          !(await verifyPassword(
            requiredString(args.password, "비밀번호", 256),
            channel.passwordHash,
          ))
        )
          throw new AppError(
            403,
            "join_failed",
            "채널 ID 또는 비밀번호를 확인해 주세요.",
          );
        await this.run(
          "INSERT INTO members (channelId,userId,name) VALUES (?,?,?) ON CONFLICT(channelId,userId) DO UPDATE SET name=excluded.name",
          channelId,
          actor.id,
          actor.name,
        );
        return this.member(actor, channelId);
      }
      case "channel_leave": {
        const channelId = requiredString(args.channelId, "채널 ID", 100);
        const channel = await this.member(actor, channelId);
        if (channel.ownerId === actor.id)
          throw new AppError(
            400,
            "owner_cannot_leave",
            "방장은 채널을 유지해야 합니다.",
          );
        await this.removeMember(channelId, actor.id, false);
        return { ok: true };
      }
      case "member_remove": {
        const channelId = requiredString(args.channelId, "채널 ID", 100),
          userId = requiredString(args.userId, "사용자 ID", 200);
        await this.owner(actor, channelId);
        if (userId === actor.id)
          throw new AppError(
            400,
            "cannot_remove_self",
            "방장 자신은 추방할 수 없습니다.",
          );
        await this.removeMember(channelId, userId, true);
        return { ok: true };
      }
      case "channel_update": {
        const channelId = requiredString(args.channelId, "채널 ID", 100);
        const channel = await this.owner(actor, channelId);
        const situation =
          typeof args.situation === "string"
            ? args.situation
            : channel.situation;
        if (situation.length > 16000)
          throw new AppError(
            400,
            "too_long",
            "상황 설정은 16,000자 이내여야 합니다.",
          );
        const seconds =
          args.heartbeatSeconds === undefined
            ? channel.heartbeatSeconds
            : Number(args.heartbeatSeconds);
        if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400)
          throw new AppError(
            400,
            "invalid_interval",
            "자동 대화 간격은 30~86400초입니다.",
          );
        const heartbeatParticipants = args.heartbeatParticipants === undefined
          ? channel.heartbeatParticipants
          : args.heartbeatParticipants;
        if (typeof heartbeatParticipants !== "number" || !Number.isInteger(heartbeatParticipants) || heartbeatParticipants < 0 || heartbeatParticipants > 1000)
          throw new AppError(
            400,
            "invalid_participants",
            "자동 대화 참여 인원은 1~1000명 또는 전체 참여(0)여야 합니다.",
          );
        const paused =
          args.paused === undefined
            ? channel.paused
            : Number(Boolean(args.paused));
        if (
          typeof args.password === "string" &&
          args.password.length &&
          (args.password.length < 8 || args.password.length > 256)
        )
          throw new AppError(
            400,
            "invalid_password",
            "비밀번호는 8~256자입니다.",
          );
        await this.run(
          "UPDATE channels SET situation=?,situationVersion=situationVersion+1,heartbeatSeconds=?,heartbeatParticipants=?,heartbeatEnabled=?,paused=?,nextHeartbeatAt=? WHERE id=?",
          situation,
          seconds,
          heartbeatParticipants,
          args.heartbeatEnabled === undefined
            ? channel.heartbeatEnabled
            : Number(Boolean(args.heartbeatEnabled)),
          paused,
          now() + seconds * 1000,
          channelId,
        );
        if (typeof args.password === "string" && args.password.length) {
          if (args.password.length < 8 || args.password.length > 256)
            throw new AppError(
              400,
              "invalid_password",
              "비밀번호는 8~256자입니다.",
            );
          await this.run(
            "UPDATE channels SET passwordHash=? WHERE id=?",
            await passwordHash(args.password),
            channelId,
          );
        }
        if (paused)
          await this.db.batch([
            this.db
              .prepare(
                "UPDATE jobs SET status='cancelled' WHERE channelId=? AND status IN ('pending','running')",
              )
              .bind(channelId),
            this.db
              .prepare(
                "UPDATE rounds SET status='cancelled' WHERE channelId=? AND status='active'",
              )
              .bind(channelId),
          ]);
        await this.goals.tick(await this.member(actor,channelId));
        return this.member(actor, channelId);
      }
      case "snapshot": {
        const channelId = requiredString(args.channelId, "채널 ID", 100);
        const channel = await this.member(actor, channelId);
        await this.goals.tick(channel);
        const activeGoal=await this.goals.active(channelId);
        const before = Number(args.before || 0),
          since = Number(args.since || 0);
        if (
          !Number.isSafeInteger(before) ||
          !Number.isSafeInteger(since) ||
          before < 0 ||
          since < 0
        )
          throw new AppError(400, "invalid_cursor", "잘못된 커서입니다.");
        const messages = before
          ? (
              await this.all<Message>(
                "SELECT m.*,g.title goalTitle FROM messages m LEFT JOIN goals g ON g.id=m.goalId WHERE m.channelId=? AND m.seq<? ORDER BY m.seq DESC LIMIT 100",
                channelId,
                before,
              )
            ).reverse()
          : since
            ? await this.all<Message>(
                "SELECT m.*,g.title goalTitle FROM messages m LEFT JOIN goals g ON g.id=m.goalId WHERE m.channelId=? AND m.seq>? ORDER BY m.seq LIMIT 100",
                channelId,
                since,
              )
            : (
                await this.all<Message>(
                  "SELECT m.*,g.title goalTitle FROM messages m LEFT JOIN goals g ON g.id=m.goalId WHERE m.channelId=? ORDER BY m.seq DESC LIMIT 100",
                  channelId,
                )
              ).reverse();
        return {
          channel,
          activeGoal:activeGoal?await this.goals.overview(activeGoal):null,
          messages,
          participants: await this.all<Participant>(
            "SELECT * FROM participants WHERE channelId=? AND enabled=1",
            channelId,
          ),
          members: await this.all(
            "SELECT userId,name FROM members WHERE channelId=? AND banned=0",
            channelId,
          ),
          rounds: await this.all<Round>(
            "SELECT * FROM rounds WHERE channelId=? ORDER BY createdAt DESC LIMIT 20",
            channelId,
          ),
          jobs: await this.all<Job>(
            "SELECT * FROM jobs WHERE channelId=? ORDER BY createdAt DESC LIMIT 100",
            channelId,
          ),
          serverTime: now(),
        };
      }
      case "message_post": {
        this.user(actor);
        const channelId = requiredString(args.channelId, "채널 ID", 100),
          channel = await this.member(actor, channelId);
        const nonce = requiredString(args.clientMessageId, "메시지 ID", 100),
          messageId = await digest(`${actor.id}:${channelId}:${nonce}`);
        const previous = await this.one<Message>(
          "SELECT * FROM messages WHERE id=?",
          messageId,
        );
        if (previous) return previous;
        await rateLimit(this.db, `post:${actor.id}`, 30, 60000);
        const text = requiredString(args.text, "메시지", 16000);
        if(args.goalId) return this.goals.post(actor,args,messageId,actor.name,"human");
        const mentions = await this.messageMentions(channelId, text, args.targetParticipantIds);
        const replyTo = typeof args.replyTo === "string" ? args.replyTo : null;
        if (
          replyTo &&
          !(await this.one(
            "SELECT id FROM messages WHERE id=? AND channelId=?",
            replyTo,
            channelId,
          ))
        )
          throw new AppError(
            400,
            "invalid_reply",
            "답장 대상이 같은 채널에 없습니다.",
          );
        await this.run(
          "INSERT OR IGNORE INTO messages (id,channelId,ownerId,author,kind,text,replyTo,phase,mentions,createdAt) VALUES (?,?,?,?,'human',?,?,'chat',?,?)",
          messageId,
          channelId,
          actor.id,
          actor.name,
          text,
          replyTo,
          JSON.stringify(mentions),
          now(),
        );
        await this.run(
          "UPDATE channels SET nextHeartbeatAt=? WHERE id=?",
          now() + channel.heartbeatSeconds * 1000,
          channelId,
        );
        if (!channel.paused)
          await this.startRound(
            actor,
            channel,
            messageId,
            args.verify === true ? "verify" : "chat",
            `question:${messageId}`,
            mentions.map(m=>m.id),
          );
        return this.one<Message>(
          "SELECT * FROM messages WHERE id=?",
          messageId,
        );
      }
      case "verification_start": {
        const channel = await this.member(
          actor,
          requiredString(args.channelId, "채널 ID", 100),
        );
        if (channel.paused)
          throw new AppError(409, "paused", "채널이 일시정지 상태입니다.");
        const triggerId = requiredString(args.messageId, "대상 메시지", 250);
        const trigger = await this.one<Message>("SELECT * FROM messages WHERE id=? AND channelId=?", triggerId, channel.id);
        if (!trigger)
          throw new AppError(404, "not_found", "메시지를 찾을 수 없습니다.");
        if(trigger.goalId) throw new AppError(409,"goal_message","목표 메시지는 목표 토의에서 검토해 주세요.");
        let targets = readMentions(trigger.mentions).map(m=>m.id);
        if (!targets.length && trigger.roundId) {
          const parent = await this.one<Round>("SELECT * FROM rounds WHERE id=? AND channelId=?",trigger.roundId,channel.id);
          targets = JSON.parse(parent?.targetParticipantIds || "[]");
        }
        return this.startRound(
          actor,
          channel,
          triggerId,
          "verify",
          await digest(
            `verify:${actor.id}:${channel.id}:${requiredString(args.requestId, "요청 ID", 100)}`,
          ),
          targets,
        );
      }
      case "pair_create": {
        this.user(actor);
        await rateLimit(this.db, `pair-create:${actor.id}`, 10, 600000);
        await this.run('DELETE FROM pairings WHERE expiresAt<?', now());
        const code = secret();
        await this.run(
          "INSERT INTO pairings (hash,ownerId,ownerName,expiresAt) VALUES (?,?,?,?)",
          await digest(code),
          actor.id,
          actor.name,
          now() + 600000,
        );
        return { code, expiresInSeconds: 600 };
      }
      case "device_revoke": {
        this.user(actor);
        const deviceId = requiredString(args.deviceId, "장치 ID", 100);
        await this.run(
          "UPDATE devices SET revoked=1 WHERE id=? AND ownerId=?",
          deviceId,
          actor.id,
        );
        await this.run(
          "UPDATE participants SET enabled=0 WHERE deviceId=? AND ownerId=?",
          deviceId,
          actor.id,
        );
        await this.run(
          "UPDATE jobs SET status='cancelled' WHERE participantId IN (SELECT id FROM participants WHERE deviceId=? AND ownerId=?) AND status IN ('pending','running')",
          deviceId,
          actor.id,
        );
        return { ok: true };
      }
      case "register":
        return this.register(actor, args);
      case "poll":
        return this.poll(actor, args);
      case "job_state": {
        const job = await this.ownedJob(
          actor,
          requiredString(args.jobId, "작업 ID", 200),
        );
        await this.goals.tick(await this.member(actor,job.channelId));
        return { status: (await this.one<Job>("SELECT * FROM jobs WHERE id=?",job.id))!.status };
      }
      case "job_complete":
        return this.complete(actor, args);
      case "agent_post": {
        const channel = await this.member(
          actor,
          requiredString(args.channelId, "채널 ID", 100),
        );
        const name = requiredString(args.name, "참가자 이름", 60);
        await rateLimit(this.db, `mcp:${actor.id}`, 30, 60000);
        const participantId = `mcp:${await digest(`${actor.id}:${channel.id}:${name}`)}`;
        const messageId = await digest(
          `mcp-msg:${actor.id}:${channel.id}:${requiredString(args.requestId, "요청 ID", 100)}`,
        );
        if (await this.one("SELECT id FROM messages WHERE id=?",messageId)) return {id:messageId};
        if(args.goalId) return this.goals.post(actor,args,messageId,actor.name+" / "+name,"llm");
        const text = requiredString(args.text, "메시지", 16000);
        const mentions = await this.messageMentions(channel.id,text,args.targetParticipantIds);
        await this.run(
          "INSERT INTO participants (id,channelId,ownerId,deviceId,profileId,name,provider,onlineAt,enabled) VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET onlineAt=excluded.onlineAt,enabled=1",
          participantId,
          channel.id,
          actor.id,
          "mcp",
          name,
          name,
          "external",
          now(),
        );
        await this.run(
          "INSERT OR IGNORE INTO messages (id,channelId,ownerId,participantId,author,kind,text,phase,mentions,createdAt) VALUES (?,?,?,?,?,'llm',?,'external',?,?)",
          messageId,
          channel.id,
          actor.id,
          participantId,
          `${actor.name} / ${name}`,
          text,
          JSON.stringify(mentions),
          now(),
        );
        if (!channel.paused)
          await this.startRound(
            actor,
            channel,
            messageId,
            "chat",
            `external:${messageId}`,
            mentions.map(m=>m.id),
          );
        return { id: messageId };
      }
      default:
        throw new AppError(404, "unknown_action", "지원하지 않는 동작입니다.");
    }
  }
  async pair(code: string, name: string) {
    const pairing = await this.one<{ ownerId: string; ownerName: string }>(
      "DELETE FROM pairings WHERE hash=? AND expiresAt>? RETURNING ownerId,ownerName",
      await digest(requiredString(code, "연결 코드", 100)),
      now(),
    );
    if (!pairing)
      throw new AppError(
        403,
        "invalid_pairing",
        "연결 코드가 만료되었거나 이미 사용되었습니다.",
      );
    const deviceId = id(),
      token = secret();
    await this.run(
      "INSERT INTO devices (id,ownerId,ownerName,name,tokenHash,createdAt) VALUES (?,?,?,?,?,?)",
      deviceId,
      pairing.ownerId,
      pairing.ownerName,
      requiredString(name, "장치 이름", 60),
      await digest(token),
      now(),
    );
    return {
      deviceId,
      token,
      ownerId: pairing.ownerId,
      ownerName: pairing.ownerName,
    };
  }
  async removeMember(channelId: string, userId: string, ban: boolean) {
    await this.db.batch([
      ban
        ? this.db
            .prepare(
              "UPDATE members SET banned=1 WHERE channelId=? AND userId=?",
            )
            .bind(channelId, userId)
        : this.db
            .prepare("DELETE FROM members WHERE channelId=? AND userId=?")
            .bind(channelId, userId),
      this.db
        .prepare(
          "UPDATE participants SET enabled=0 WHERE channelId=? AND ownerId=?",
        )
        .bind(channelId, userId),
      this.db
        .prepare(
          "UPDATE jobs SET status='cancelled' WHERE channelId=? AND participantId IN (SELECT id FROM participants WHERE ownerId=?) AND status IN ('pending','running')",
        )
        .bind(channelId, userId),
    ]);
  }
  async register(actor: Actor, args: Record<string, unknown>) {
    if (!actor.deviceId)
      throw new AppError(403, "device_required", "실행기 연결이 필요합니다.");
    const channelId = requiredString(args.channelId, "채널 ID", 100);
    const channel=await this.member(actor, channelId);
    if (!Array.isArray(args.profiles) || args.profiles.length > 12)
      throw new AppError(
        400,
        "invalid_profiles",
        "참가자는 장치당 최대 12명입니다.",
      );
    const validated = args.profiles.map((raw) => {
      const p = raw as Record<string, unknown>;
      if (
        !profilePattern.test(String(p.id)) ||
        !isActiveProvider(p.provider)
      )
        throw new AppError(
          400,
          "invalid_profile",
          "지원하지 않는 참가자입니다.",
        );
      return {
        id: String(p.id),
        name: requiredString(p.name, "참가자 이름", 60),
        provider: String(p.provider),
      };
    });
    const statements = [
      this.db
        .prepare(
          "UPDATE participants SET enabled=0 WHERE channelId=? AND deviceId=?",
        )
        .bind(channelId, actor.deviceId),
    ];
    for (const p of validated) {
      const participantId = await digest(
        `${channelId}:${actor.deviceId}:${p.id}`,
      );
      statements.push(
        this.db
          .prepare(
            "INSERT INTO participants (id,channelId,ownerId,deviceId,profileId,name,provider,onlineAt,enabled,goalsSupported) VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,onlineAt=excluded.onlineAt,enabled=1,goalsSupported=excluded.goalsSupported",
          )
          .bind(
            participantId,
            channelId,
            actor.id,
            actor.deviceId,
            p.id,
            p.name,
            p.provider,
            now(),
            Number(Array.isArray(args.capabilities)&&args.capabilities.includes("goals-v1")),
          ),
      );
    }
    await this.db.batch(statements);
    await this.goals.tick(channel);
    return this.all<Participant>(
      "SELECT * FROM participants WHERE channelId=? AND deviceId=? AND enabled=1",
      channelId,
      actor.deviceId,
    );
  }
  async messageMentions(channelId: string, text: string, preferred: unknown) {
    const candidates = await this.all<Participant>(
      "SELECT p.* FROM participants p JOIN devices d ON d.id=p.deviceId WHERE p.channelId=? AND p.enabled=1 AND d.revoked=0",
      channelId,
    );
    if (preferred !== undefined && (!Array.isArray(preferred) || preferred.length > 1000 || preferred.some(id=>typeof id!=="string" || !candidates.some(p=>p.id===id))))
      throw new AppError(400,"invalid_mentions","호출 대상은 같은 채널에 등록된 AI여야 합니다.");
    const resolved = resolveMentions(text,candidates,(preferred || []) as string[]);
    if (resolved.error) throw new AppError(400,"invalid_mentions",resolved.error);
    if (Array.isArray(preferred) && preferred.some(id=>!resolved.mentions.some(m=>m.id===id)))
      throw new AppError(400,"invalid_mentions","호출 대상과 메시지의 @이름이 일치하지 않습니다.");
    return resolved.mentions;
  }
  async startRound(
    actor: Actor,
    channel: Channel,
    triggerId: string | null,
    kind: Round["kind"],
    roundId: string,
    targetParticipantIds: string[] = [],
  ) {
    const existing = await this.one<Round>(
      "SELECT * FROM rounds WHERE id=?",
      roundId,
    );
    if (existing) return existing;
    await rateLimit(this.db, `round:${actor.id}`, 30, 60000);
    let roster = await this.all<Participant>(
      "SELECT p.* FROM participants p JOIN devices d ON d.id=p.deviceId WHERE p.channelId=? AND p.enabled=1 AND p.onlineAt>? AND d.revoked=0 ORDER BY p.onlineAt,p.id",
      channel.id,
      now() - 30000,
    );
    if (targetParticipantIds.length) roster = roster.filter(p=>targetParticipantIds.includes(p.id));
    if (kind === "heartbeat") {
      const offset =
        Math.floor(now() / (channel.heartbeatSeconds * 1000)) %
        Math.max(roster.length, 1);
      roster = [...roster.slice(offset), ...roster.slice(0, offset)].slice(
        0,
        channel.heartbeatParticipants === 0 ? roster.length : channel.heartbeatParticipants,
      );
    }
    const phase: Phase = kind === "heartbeat" ? "heartbeat" : "chat";
    const time = now();
    const statements = [
      this.db
        .prepare(
          "INSERT OR IGNORE INTO rounds (id,channelId,requestorId,triggerId,kind,phase,status,roster,targetParticipantIds,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          roundId,
          channel.id,
          actor.id,
          triggerId,
          kind,
          phase,
          roster.length ? "active" : "no_participants",
          JSON.stringify(roster.map((p) => p.id)),
          JSON.stringify(targetParticipantIds),
          time,
        ),
    ];
    for (const participant of kind === "heartbeat"
      ? roster.slice(0, 1)
      : roster)
      statements.push(
        this.makeJob(roundId, channel.id, participant.id, phase, time),
      );
    await this.db.batch(statements);
    return this.one<Round>("SELECT * FROM rounds WHERE id=?", roundId);
  }
  makeJob(
    roundId: string,
    channelId: string,
    participantId: string,
    phase: Phase,
    time = now(),
  ) {
    return this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs (id,roundId,channelId,participantId,phase,status,createdAt) SELECT ?,?,?,?,?,'pending',? WHERE EXISTS (SELECT 1 FROM rounds WHERE id=? AND status='active' AND phase=?)",
      )
      .bind(
        `${roundId}:${participantId}:${phase}`,
        roundId,
        channelId,
        participantId,
        phase,
        time,
        roundId,
        phase,
      );
  }
  async advance(roundId: string) {
    const round = await this.one<Round>(
      "SELECT * FROM rounds WHERE id=? AND status='active'",
      roundId,
    );
    if (!round) return;
    if(round.kind==="goal") return;
    const unfinished = await this.one(
      "SELECT id FROM jobs WHERE roundId=? AND phase=? AND status IN ('pending','running') LIMIT 1",
      round.id,
      round.phase,
    );
    if (unfinished) return;
    const roster: string[] = JSON.parse(round.roster);
    const hasMessage = await this.one(
      "SELECT id FROM messages WHERE roundId=? AND phase=? LIMIT 1",
      round.id,
      round.phase,
    );
    let next: Phase | null = null;
    let nextRoster = roster;
    if (hasMessage) {
      if (round.phase === "heartbeat") {
        next = "review";
        nextRoster = roster.slice(1);
      } else if (round.phase === "chat") next = "review";
    }
    if (round.phase === "review" && round.kind === "verify") next = "revise";
    if (round.phase === "revise" && round.kind === "verify") {
      next = "summary";
      nextRoster = roster.slice(0, 1);
    }
    if (!next || !nextRoster.length) {
      await this.run(
        "UPDATE rounds SET status='completed' WHERE id=? AND phase=? AND status='active'",
        round.id,
        round.phase,
      );
      return;
    }
    const statements = [
      this.db
        .prepare(
          "UPDATE rounds SET phase=? WHERE id=? AND phase=? AND status='active'",
        )
        .bind(next, round.id, round.phase),
    ];
    for (const participantId of nextRoster)
      statements.push(
        this.makeJob(round.id, round.channelId, participantId, next),
      );
    await this.db.batch(statements);
  }
  async poll(
    actor: Actor,
    args: Record<string, unknown>,
  ): Promise<{ jobs: TurnJob[] }> {
    if (!actor.deviceId)
      throw new AppError(403, "device_required", "실행기 연결이 필요합니다.");
    const channelId = requiredString(args.channelId, "채널 ID", 100);
    const channel = await this.member(actor, channelId);
    const count =
      args.historyMessageCount === undefined
        ? 40
        : Number(args.historyMessageCount);
    if (!Number.isInteger(count) || count < 0 || count > 1000)
      throw new AppError(
        400,
        "invalid_history_count",
        "기록 개수는 0~1000입니다.",
      );
    const goalCount=args.goalHistoryMessageCount===undefined?40:Number(args.goalHistoryMessageCount);
    if(!Number.isInteger(goalCount)||goalCount<0||goalCount>1000)throw new AppError(400,"invalid_history_count","목표 기록 개수는 0~1000입니다.");
    // Uncertain calls are never re-queued automatically.
    await this.run(
      "UPDATE jobs SET status='uncertain',error='실행기 연결이 끊겨 완료 여부를 확인할 수 없습니다.' WHERE channelId=? AND status='running' AND participantId IN (SELECT id FROM participants WHERE onlineAt<?)",
      channelId,
      now() - 120000,
    );
    await this.run(
      "UPDATE participants SET onlineAt=? WHERE channelId=? AND deviceId=? AND enabled=1",
      now(), channelId, actor.deviceId,
    );
    await this.run(
      "UPDATE jobs SET status='skipped',error='참가자가 오프라인입니다.' WHERE channelId=? AND status='pending' AND (createdAt<? OR participantId IN (SELECT id FROM participants WHERE enabled=0))",
      channelId,
      now() - 300000,
    );
    const rounds = await this.all<Round>(
      "SELECT * FROM rounds WHERE channelId=? AND status='active'",
      channelId,
    );
    for (const round of rounds) await this.advance(round.id);
    await this.goals.tick(channel);
    const activeGoal=await this.goals.active(channelId);
    if (
      !channel.paused &&
      channel.heartbeatEnabled &&
      !activeGoal &&
      channel.nextHeartbeatAt <= now() &&
      !(await this.one(
        "SELECT id FROM rounds WHERE channelId=? AND status='active' LIMIT 1",
        channelId,
      ))
    ) {
      const claimed = await this.one<Channel>(
        "UPDATE channels SET nextHeartbeatAt=? WHERE id=? AND nextHeartbeatAt=? RETURNING *",
        now() + channel.heartbeatSeconds * 1000,
        channelId,
        channel.nextHeartbeatAt,
      );
      if (claimed)
        await this.startRound(
          actor,
          channel,
          null,
          "heartbeat",
          `heartbeat:${channelId}:${channel.nextHeartbeatAt}`,
        );
    }
    if (channel.paused || args.claim === false) return { jobs: [] };
    const candidate = await this.one<Job>(
      "SELECT j.* FROM jobs j JOIN participants p ON p.id=j.participantId JOIN rounds r ON r.id=j.roundId WHERE j.channelId=? AND j.status='pending' AND p.deviceId=? AND p.enabled=1 AND (r.goalId IS NULL OR (?=1 AND p.goalsSupported=1)) AND NOT EXISTS (SELECT 1 FROM jobs x WHERE x.participantId=p.id AND x.status='running') ORDER BY CASE WHEN j.phase='heartbeat' THEN 1 ELSE 0 END,j.createdAt,j.id LIMIT 1",
      channelId,
      actor.deviceId,
      Number(Array.isArray(args.capabilities)&&args.capabilities.includes("goals-v1")),
    );
    if (!candidate) return { jobs: [] };
    const job = await this.one<Job>(
      "UPDATE jobs SET status='running',startedAt=? WHERE id=? AND status='pending' RETURNING *",
      now(),
      candidate.id,
    );
    if (!job) return { jobs: [] };
    const round = (await this.one<Round>(
      "SELECT * FROM rounds WHERE id=?",
      job.roundId,
    ))!;
    const participant = (await this.one<Participant>(
      "SELECT * FROM participants WHERE id=?",
      job.participantId,
    ))!;
    const trigger = round.triggerId
      ? await this.one<Message>(
          "SELECT * FROM messages WHERE id=? AND channelId=?",
          round.triggerId,
          channelId,
        )
      : null;
    if(round.goalId) {
      const context=await this.goals.context(round,goalCount);
      return {jobs:[{job,round,channel,participant,trigger:null,phaseMessages:[],...context}]};
    }
    const history = (
      await this.all<Message>(
        "SELECT * FROM messages WHERE channelId=? AND goalId IS NULL AND seq<? ORDER BY seq DESC LIMIT ?",
        channelId,
        trigger?.seq ?? Number.MAX_SAFE_INTEGER,
        count,
      )
    ).reverse();
    const phaseMessages =
      job.phase === "chat"
        ? []
        : await this.all<Message>(
            "SELECT * FROM messages WHERE roundId=? AND phase<>? ORDER BY seq",
            round.id,
            job.phase,
          );
    return {
      jobs: [
        { job, round, channel, participant, trigger, history, phaseMessages },
      ],
    };
  }
  async ownedJob(actor: Actor, jobId: string) {
    const job = await this.one<Job>(
      "SELECT j.* FROM jobs j JOIN participants p ON p.id=j.participantId WHERE j.id=? AND p.deviceId=? AND p.ownerId=?",
      jobId,
      actor.deviceId || "",
      actor.id,
    );
    if (!job)
      throw new AppError(403, "job_forbidden", "이 작업에 접근할 수 없습니다.");
    await this.member(actor, job.channelId);
    return job;
  }
  async complete(actor: Actor, args: Record<string, unknown>) {
    const job = await this.ownedJob(
      actor,
      requiredString(args.jobId, "작업 ID", 250),
    );
    const jobRound=await this.one<Round>("SELECT * FROM rounds WHERE id=?",job.roundId);
    if(jobRound?.goalId)return this.goals.complete(actor,job,args);
    if (
      job.status === "completed" ||
      job.status === "skipped" ||
      job.status === "failed"
    )
      return { ok: true, duplicate: true };
    if (job.status !== "running")
      throw new AppError(
        409,
        "job_not_running",
        "이미 종료되었거나 불확실한 작업입니다.",
      );
    const status = args.error
      ? "failed"
      : args.skipped
        ? "skipped"
        : "completed";
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (text.length > 24000)
      throw new AppError(400, "too_long", "답변이 너무 깁니다.");
    const evidence = JSON.stringify(
      Array.isArray(args.evidence) ? args.evidence : [],
    );
    if (evidence.length > 64000)
      throw new AppError(400, "too_long", "근거 데이터가 너무 큽니다.");
    const participant = (await this.one<Participant>(
      "SELECT * FROM participants WHERE id=?",
      job.participantId,
    ))!;
    const round = (await this.one<Round>(
      "SELECT * FROM rounds WHERE id=?",
      job.roundId,
    ))!;
    const statements = [
      this.db
        .prepare(
          "UPDATE jobs SET status=?,error=? WHERE id=? AND status='running'",
        )
        .bind(
          status,
          typeof args.error === "string"
            ? args.error.slice(0, 1000)
            : args.skipped
              ? "로컬 한도 또는 참가자 설정으로 건너뜀"
              : null,
          job.id,
        ),
    ];
    if (text && status === "completed")
      statements.push(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO messages (id,channelId,ownerId,participantId,author,kind,text,replyTo,roundId,phase,evidence,createdAt) SELECT ?,?,?,?,?,'llm',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='completed')",
          )
          .bind(
            `answer:${job.id}`,
            job.channelId,
            actor.id,
            participant.id,
            `${actor.name} / ${participant.name}`,
            text,
            round.triggerId,
            round.id,
            job.phase,
            evidence,
            now(),
            job.id,
          ),
      );
    await this.db.batch(statements);
    await this.advance(job.roundId);
    return { ok: true };
  }
}
