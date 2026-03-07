/**
 * Remaining Value — pure scoring function for open positions.
 *
 * Estimates how much upside is left in an open position as a number in [0, 1].
 * Used by the portfolio manager to rank positions for potential replacement.
 */

export interface PositionForScoring {
  id: string;
  tokenSymbol: string;
  /** Composite quality score [0,1] from signal engine; null for legacy positions */
  signalScore: number | null;
  /** Magnitude regressor output in %; null falls back to tp3-derived estimate */
  expectedMovePct: number | null;
  /** Average entry price in SOL per token */
  entryPrice: number;
  /** Current live price in SOL per token */
  currentPrice: number;
  /** TP3-level target price (used to derive expectedMove when expectedMovePct is null) */
  tp3Price: number;
  /** When the position was opened */
  openedAt: Date;
}

/**
 * Compute the remaining value score for a position.
 *
 * Formula:
 *   rv = entryScore × timeFactor × (1 − upConsumed) × (1 − lossRatio)
 *
 * Where:
 *   entryScore  = signalScore ?? 0.5
 *   timeFactor  = max(0, 1 − hoursOpen / positionDecayHours)
 *   pnlRatio    = unrealizedPnlPct / expectedMove
 *   upConsumed  = clamp(pnlRatio, 0, 1)   — winners decay toward 0 as gain is captured
 *   lossRatio   = clamp(-pnlRatio, 0, 1)  — losers are penalised toward 0
 *
 * Legacy positions (signalScore = null, requireScoreForReplacement = true)
 * always return 1.0 so they are never candidates for replacement.
 */
export function remainingValue(
  position: PositionForScoring,
  config: { requireScoreForReplacement: boolean; positionDecayHours: number },
  now: Date,
): number {
  if (config.requireScoreForReplacement && position.signalScore == null) {
    return 1.0;
  }

  const entryScore = position.signalScore ?? 0.5;

  const hoursOpen = (now.getTime() - position.openedAt.getTime()) / 3_600_000;
  const timeFactor = Math.max(0.0, 1.0 - hoursOpen / config.positionDecayHours);

  const expectedMove =
    position.expectedMovePct != null
      ? position.expectedMovePct
      : ((position.tp3Price - position.entryPrice) / position.entryPrice) * 100;

  const unrealizedPnlPct =
    position.entryPrice > 0
      ? ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100
      : 0;

  const pnlRatio = expectedMove > 0 ? unrealizedPnlPct / expectedMove : 0;
  const upConsumed = Math.min(Math.max(pnlRatio, 0.0), 1.0);
  const lossRatio = Math.min(Math.max(-pnlRatio, 0.0), 1.0);

  return entryScore * timeFactor * (1.0 - upConsumed) * (1.0 - lossRatio);
}
