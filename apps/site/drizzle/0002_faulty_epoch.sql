ALTER TABLE `messages` ADD `mentions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `rounds` ADD `targetParticipantIds` text DEFAULT '[]' NOT NULL;