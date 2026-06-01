CREATE TYPE "JiraChangelogStrategy" AS ENUM ('subresource', 'issue_expand');

ALTER TABLE "JiraConnection"
  ADD COLUMN "jiraVersion" TEXT,
  ADD COLUMN "jiraDeploymentType" TEXT,
  ADD COLUMN "changelogStrategy" "JiraChangelogStrategy",
  ADD COLUMN "capabilitiesDetectedAt" TIMESTAMP(3);
