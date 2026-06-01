ALTER TABLE "EpicForecastTarget"
  ADD COLUMN "storyCountSource" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "epicLinkStoryCount" INTEGER,
  ADD COLUMN "jiraStoryCount" INTEGER,
  ADD COLUMN "manualStoryCount" INTEGER,
  ADD COLUMN "closedAt" TIMESTAMP(3);

UPDATE "EpicForecastTarget"
SET "manualStoryCount" = "remainingStoryCount"
WHERE "manualStoryCount" IS NULL;
