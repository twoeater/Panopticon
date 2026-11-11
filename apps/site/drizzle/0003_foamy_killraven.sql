CREATE TABLE `goalCheckpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`goalId` text NOT NULL,
	`throughSeq` integer NOT NULL,
	`summary` text NOT NULL,
	`issues` text NOT NULL,
	`sources` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_checkpoint` ON `goalCheckpoints` (`goalId`,`throughSeq`);--> statement-breakpoint
CREATE TABLE `goalProposals` (
	`id` text PRIMARY KEY NOT NULL,
	`goalId` text NOT NULL,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`sourceSeq` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposal_goal` ON `goalProposals` (`goalId`,`version`);--> statement-breakpoint
CREATE TABLE `goalVotes` (
	`id` text PRIMARY KEY NOT NULL,
	`goalId` text NOT NULL,
	`proposalId` text NOT NULL,
	`participantId` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`conclusion` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_vote_once` ON `goalVotes` (`proposalId`,`participantId`);--> statement-breakpoint
CREATE INDEX `goal_opinions` ON `goalVotes` (`goalId`,`participantId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`channelId` text NOT NULL,
	`creatorId` text NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`deadline` integer NOT NULL,
	`finalDeadline` integer NOT NULL,
	`intervalSeconds` integer DEFAULT 60 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`phase` text DEFAULT 'waiting' NOT NULL,
	`roster` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`mutationId` text DEFAULT '' NOT NULL,
	`cycle` integer DEFAULT 0 NOT NULL,
	`roundId` text,
	`proposalId` text,
	`summary` text DEFAULT '' NOT NULL,
	`summaryThrough` integer DEFAULT 0 NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`cutoffSeq` integer,
	`afterCompact` text DEFAULT 'goal_discuss' NOT NULL,
	`nextRunAt` integer NOT NULL,
	`lastError` text,
	`outcome` text,
	`createdAt` integer NOT NULL,
	`completedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_live_goal` ON `goals` (`channelId`) WHERE "goals"."status" IN ('active','finalizing');--> statement-breakpoint
CREATE INDEX `goal_channel_created` ON `goals` (`channelId`,`createdAt`,`id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `resultToken` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `goalId` text;--> statement-breakpoint
CREATE INDEX `goal_sequence` ON `messages` (`goalId`,`seq`);--> statement-breakpoint
ALTER TABLE `participants` ADD `goalsSupported` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rounds` ADD `goalId` text;--> statement-breakpoint
ALTER TABLE `rounds` ADD `goalRevision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rounds` ADD `contextThrough` integer DEFAULT 0 NOT NULL;