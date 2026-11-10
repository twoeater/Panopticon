CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ownerId` text NOT NULL,
	`passwordHash` text NOT NULL,
	`situation` text DEFAULT '' NOT NULL,
	`situationVersion` integer DEFAULT 1 NOT NULL,
	`heartbeatEnabled` integer DEFAULT 1 NOT NULL,
	`heartbeatSeconds` integer DEFAULT 180 NOT NULL,
	`nextHeartbeatAt` integer NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`ownerName` text NOT NULL,
	`name` text NOT NULL,
	`tokenHash` text NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_token` ON `devices` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`roundId` text NOT NULL,
	`channelId` text NOT NULL,
	`participantId` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`createdAt` integer NOT NULL,
	`startedAt` integer,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_once` ON `jobs` (`roundId`,`participantId`,`phase`);--> statement-breakpoint
CREATE INDEX `job_pending` ON `jobs` (`participantId`,`status`);--> statement-breakpoint
CREATE TABLE `members` (
	`channelId` text NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`banned` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_identity` ON `members` (`channelId`,`userId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`channelId` text NOT NULL,
	`ownerId` text NOT NULL,
	`participantId` text,
	`author` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`replyTo` text,
	`roundId` text,
	`phase` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_id` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `channel_sequence` ON `messages` (`channelId`,`seq`);--> statement-breakpoint
CREATE TABLE `pairings` (
	`hash` text PRIMARY KEY NOT NULL,
	`ownerId` text NOT NULL,
	`ownerName` text NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`channelId` text NOT NULL,
	`ownerId` text NOT NULL,
	`deviceId` text NOT NULL,
	`profileId` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`onlineAt` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_identity` ON `participants` (`channelId`,`deviceId`,`profileId`);--> statement-breakpoint
CREATE TABLE `rateBuckets` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`channelId` text NOT NULL,
	`requestorId` text NOT NULL,
	`triggerId` text,
	`kind` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`roster` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `round_channel` ON `rounds` (`channelId`,`status`);