CREATE TABLE "EpicForecastTarget" (
  "id" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "jiraIssueKey" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "dueDate" TEXT NOT NULL,
  "remainingStoryCount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EpicForecastTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EpicForecastTarget_scopeId_jiraIssueKey_key"
  ON "EpicForecastTarget"("scopeId", "jiraIssueKey");

CREATE INDEX "EpicForecastTarget_scopeId_status_dueDate_idx"
  ON "EpicForecastTarget"("scopeId", "status", "dueDate");

ALTER TABLE "EpicForecastTarget"
  ADD CONSTRAINT "EpicForecastTarget_scopeId_fkey"
  FOREIGN KEY ("scopeId") REFERENCES "FlowScope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
