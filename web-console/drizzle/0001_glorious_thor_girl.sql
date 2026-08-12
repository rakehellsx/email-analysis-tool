CREATE TABLE `mail_tasks` (
	`taskId` varchar(64) NOT NULL,
	`taskType` enum('analysis','training') NOT NULL,
	`status` varchar(24) NOT NULL,
	`originalFilename` varchar(255) NOT NULL,
	`resultJson` longtext,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `mail_tasks_taskId` PRIMARY KEY(`taskId`)
);
