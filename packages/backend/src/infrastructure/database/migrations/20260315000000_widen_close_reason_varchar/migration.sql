-- Migration: widen close_reason column from VARCHAR(20) to VARCHAR(50)
-- Required to support 'signal_replace' (14 chars) and future close reasons.
ALTER TABLE "agent_historical_swaps"
  ALTER COLUMN "close_reason" TYPE VARCHAR(50);
