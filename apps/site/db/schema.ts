import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("ownerId").notNull(),
  passwordHash: text("passwordHash").notNull(),
  situation: text("situation").notNull().default(""),
  situationVersion: integer("situationVersion").notNull().default(1),
  heartbeatEnabled: integer("heartbeatEnabled").notNull().default(1),
  heartbeatSeconds: integer("heartbeatSeconds").notNull().default(180),
  heartbeatParticipants: integer("heartbeatParticipants").notNull().default(3),
  goalSummaryParticipantId: text("goalSummaryParticipantId"),
  generalMessageLimit: integer("generalMessageLimit").notNull().default(1000),
  generalPrunedThrough: integer("generalPrunedThrough").notNull().default(0),
  historyRevision: integer("historyRevision").notNull().default(0),
  nextHeartbeatAt: integer("nextHeartbeatAt").notNull(),
  paused: integer("paused").notNull().default(0),
  createdAt: integer("createdAt").notNull(),
});
export const members = sqliteTable(
  "members",
  {
    channelId: text("channelId").notNull(),
    userId: text("userId").notNull(),
    name: text("name").notNull(),
    banned: integer("banned").notNull().default(0),
  },
  (t) => [uniqueIndex("member_identity").on(t.channelId, t.userId)],
);
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    ownerId: text("ownerId").notNull(),
    ownerName: text("ownerName").notNull(),
    name: text("name").notNull(),
    tokenHash: text("tokenHash").notNull(),
    revoked: integer("revoked").notNull().default(0),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [uniqueIndex("device_token").on(t.tokenHash)],
);
export const pairings = sqliteTable("pairings", {
  hash: text("hash").primaryKey(),
  ownerId: text("ownerId").notNull(),
  ownerName: text("ownerName").notNull(),
  expiresAt: integer("expiresAt").notNull(),
});
export const participants = sqliteTable(
  "participants",
  {
    id: text("id").primaryKey(),
    channelId: text("channelId").notNull(),
    ownerId: text("ownerId").notNull(),
    deviceId: text("deviceId").notNull(),
    profileId: text("profileId").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    onlineAt: integer("onlineAt").notNull(),
    enabled: integer("enabled").notNull().default(1),
    goalsSupported: integer("goalsSupported").notNull().default(0),
  },
  (t) => [
    uniqueIndex("participant_identity").on(
      t.channelId,
      t.deviceId,
      t.profileId,
    ),
  ],
);
export const messages = sqliteTable(
  "messages",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    channelId: text("channelId").notNull(),
    ownerId: text("ownerId").notNull(),
    participantId: text("participantId"),
    author: text("author").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    replyTo: text("replyTo"),
    roundId: text("roundId"),
    phase: text("phase").notNull(),
    evidence: text("evidence").notNull().default("[]"),
    mentions: text("mentions").notNull().default("[]"),
    goalId: text("goalId"),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("message_id").on(t.id),
    index("channel_sequence").on(t.channelId, t.seq),
    index("goal_sequence").on(t.goalId, t.seq),
    index("general_channel_sequence").on(t.channelId, t.seq).where(sql`${t.goalId} IS NULL`),
  ],
);
export const rounds = sqliteTable(
  "rounds",
  {
    id: text("id").primaryKey(),
    channelId: text("channelId").notNull(),
    requestorId: text("requestorId").notNull(),
    triggerId: text("triggerId"),
    kind: text("kind").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    roster: text("roster").notNull(),
    targetParticipantIds: text("targetParticipantIds").notNull().default("[]"),
    goalId: text("goalId"),
    goalRevision: integer("goalRevision").notNull().default(0),
    contextThrough: integer("contextThrough").notNull().default(0),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [index("round_channel").on(t.channelId, t.status)],
);
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    roundId: text("roundId").notNull(),
    channelId: text("channelId").notNull(),
    participantId: text("participantId").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    createdAt: integer("createdAt").notNull(),
    startedAt: integer("startedAt"),
    timeoutAt: integer("timeoutAt"),
    error: text("error"),
    resultToken: text("resultToken"),
  },
  (t) => [
    uniqueIndex("job_once").on(t.roundId, t.participantId, t.phase),
    index("job_pending").on(t.participantId, t.status),
  ],
);
export const rateBuckets = sqliteTable("rateBuckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: integer("expiresAt").notNull(),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(), channelId: text("channelId").notNull(), creatorId: text("creatorId").notNull(),
  title: text("title").notNull(), instructions: text("instructions").notNull(),
  deadline: integer("deadline").notNull(), finalDeadline: integer("finalDeadline").notNull(),
  intervalSeconds: integer("intervalSeconds").notNull().default(60),
  status: text("status").notNull().default("active"), phase: text("phase").notNull().default("waiting"),
  roster: text("roster").notNull(), revision: integer("revision").notNull().default(0),
  mutationId: text("mutationId").notNull().default(""), cycle: integer("cycle").notNull().default(0),
  roundId: text("roundId"), proposalId: text("proposalId"), summary: text("summary").notNull().default(""),
  summaryThrough: integer("summaryThrough").notNull().default(0), issues: text("issues").notNull().default("[]"),
  cutoffSeq: integer("cutoffSeq"), afterCompact: text("afterCompact").notNull().default("goal_discuss"),
  nextRunAt: integer("nextRunAt").notNull(), lastError: text("lastError"), outcome: text("outcome"),
  createdAt: integer("createdAt").notNull(), completedAt: integer("completedAt"),
}, t=>[
  uniqueIndex("one_live_goal").on(t.channelId).where(sql`${t.status} IN ('active','finalizing')`),
  index("goal_channel_created").on(t.channelId,t.createdAt,t.id),
]);
export const goalProposals = sqliteTable("goalProposals", {
  id:text("id").primaryKey(), goalId:text("goalId").notNull(), version:integer("version").notNull(),
  text:text("text").notNull(), sourceSeq:integer("sourceSeq").notNull(), createdAt:integer("createdAt").notNull(),
},t=>[index("proposal_goal").on(t.goalId,t.version)]);
export const goalVotes = sqliteTable("goalVotes", {
  id:text("id").primaryKey(), goalId:text("goalId").notNull(), proposalId:text("proposalId").notNull(),
  participantId:text("participantId").notNull(), decision:text("decision").notNull(), reason:text("reason").notNull(),
  conclusion:text("conclusion").notNull(), createdAt:integer("createdAt").notNull(),
},t=>[uniqueIndex("goal_vote_once").on(t.proposalId,t.participantId),index("goal_opinions").on(t.goalId,t.participantId,t.createdAt)]);
export const goalCheckpoints = sqliteTable("goalCheckpoints", {
  id:text("id").primaryKey(), goalId:text("goalId").notNull(), throughSeq:integer("throughSeq").notNull(),
  summary:text("summary").notNull(), issues:text("issues").notNull(), sources:text("sources").notNull(), createdAt:integer("createdAt").notNull(),
},t=>[index("goal_checkpoint").on(t.goalId,t.throughSeq)]);

// Only identifiers survive deletion, so a retried create/delete cannot restore content.
export const deletedGoals = sqliteTable("deletedGoals", {
  id: text("id").primaryKey(), channelId: text("channelId").notNull(),
  creatorId: text("creatorId").notNull(), deletedAt: integer("deletedAt").notNull(),
});
