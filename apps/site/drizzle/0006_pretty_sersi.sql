CREATE TABLE `deletedGoals` (
	`id` text PRIMARY KEY NOT NULL,
	`channelId` text NOT NULL,
	`creatorId` text NOT NULL,
	`deletedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `channels` ADD `generalMessageLimit` integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `generalPrunedThrough` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `historyRevision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `general_channel_sequence` ON `messages` (`channelId`,`seq`) WHERE "messages"."goalId" IS NULL;