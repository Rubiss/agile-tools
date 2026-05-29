ALTER TABLE "ForecastResultCache"
  ADD COLUMN "sampleMode" TEXT NOT NULL DEFAULT 'rolling',
  ADD COLUMN "sampleStartDate" TEXT,
  ADD COLUMN "sampleEndDate" TEXT,
  ALTER COLUMN "historicalWindowDays" DROP NOT NULL;

UPDATE "ForecastResultCache"
SET "sampleMode" = 'rolling'
WHERE "sampleMode" IS NULL;
