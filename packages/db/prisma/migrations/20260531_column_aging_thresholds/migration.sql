-- Add per-board-column aging threshold payloads to the existing threshold model.
-- The JSON array is keyed by sync dataVersion through the parent row and keeps
-- the global model and per-column model atomically readable by the flow API.

ALTER TABLE "AgingThresholdModel"
  ADD COLUMN "columnThresholds" JSONB;
