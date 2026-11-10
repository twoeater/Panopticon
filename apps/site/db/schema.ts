import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
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
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("message_id").on(t.id),
    index("channel_sequence").on(t.channelId, t.seq),
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
    error: text("error"),
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
