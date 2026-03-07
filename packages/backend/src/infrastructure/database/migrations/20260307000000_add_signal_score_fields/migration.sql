-- Add signal scoring fields to trading_signals (required for portfolio replacement logic)
ALTER TABLE "trading_signals"
  ADD COLUMN IF NOT EXISTS "signal_score"             DECIMAL(8,6),
  ADD COLUMN IF NOT EXISTS "expected_move_pct"        DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS "position_size_multiplier" DECIMAL(6,3);

-- Add signal scoring fields to agent_positions (used by remainingValue scoring)
ALTER TABLE "agent_positions"
  ADD COLUMN IF NOT EXISTS "signal_score"      DECIMAL(8,6),
  ADD COLUMN IF NOT EXISTS "expected_move_pct" DECIMAL(8,4);
