/**
 * Portfolio Manager Service
 *
 * Capital-aware entry decision service.  Called by the signal processor before
 * every purchase to determine whether to proceed, replace an existing position,
 * or suppress the trade entirely.
 *
 * Three outcomes:
 *   proceed  — capacity is available, open the position normally.
 *   replace  — capacity is full but the incoming signal beats the weakest
 *               position by more than replacementMargin; close that position
 *               first, then open the new one.
 *   suppress — capacity is full and the incoming signal is not strong enough
 *               to replace anything; skip the trade.
 */

import { prisma } from '@/infrastructure/database/client.js';
import { priceFeedService } from '@/infrastructure/external/dexscreener/index.js';
import { configService } from '@/domain/trading/config-service.js';
import { redisBalanceService } from '@/infrastructure/cache/redis-balance-service.js';
import { redisPositionService } from '@/infrastructure/cache/redis-position-service.js';
import { DEFAULT_PORTFOLIO_CONFIG, MAX_OPEN_POSITIONS } from '@nexgent/shared';
import { remainingValue } from './remaining-value.js';
import type { PositionForScoring } from './remaining-value.js';
import logger from '@/infrastructure/logging/logger.js';

/** SOL native mint address (matches TradeValidator) */
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TradeDecision =
  | { action: 'proceed' }
  | { action: 'replace'; positionsToClose: Array<{ id: string; symbol: string }> }
  | { action: 'suppress'; reason: string; weakestRv?: number; incomingScore?: number };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseBalance(balanceStr: string): number {
  const balance = parseFloat(balanceStr);
  // If value is very large assume lamports → convert to SOL
  return balance > 1_000_000 ? balance / 1_000_000_000 : balance;
}

async function getSolBalance(agentId: string, walletAddress: string): Promise<number> {
  const cached = await redisBalanceService.getBalance(agentId, walletAddress, SOL_MINT_ADDRESS);
  if (cached) return parseBalance(cached.balance);

  const balance = await prisma.agentBalance.findUnique({
    where: {
      walletAddress_tokenAddress: { walletAddress, tokenAddress: SOL_MINT_ADDRESS },
    },
  });

  if (!balance) return 0;

  await redisBalanceService.setBalance({
    id: balance.id,
    agentId: balance.agentId,
    walletAddress: balance.walletAddress,
    tokenAddress: balance.tokenAddress,
    tokenSymbol: balance.tokenSymbol,
    balance: balance.balance,
    lastUpdated: balance.lastUpdated,
  });

  return parseBalance(balance.balance);
}

async function getOpenPositionCount(agentId: string): Promise<number> {
  try {
    const ids = await redisPositionService.getAgentPositionIds(agentId);
    if (ids.length > 0) return ids.length;
  } catch {
    // fall through to DB
  }
  const rows = await prisma.agentPosition.findMany({
    where: { agentId },
    select: { id: true },
  });
  return rows.length;
}

/** Resolve the default (active) wallet address for an agent */
async function getDefaultWalletAddress(agentId: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { tradingMode: true },
  });
  if (!agent) return null;

  const wallet = await prisma.agentWallet.findFirst({
    where: { agentId, walletType: agent.tradingMode },
    select: { walletAddress: true },
  });
  return wallet?.walletAddress ?? null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class PortfolioManagerService {
  /**
   * True when the agent has enough SOL balance and a free position slot.
   */
  async canAcceptTrade(agentId: string, walletAddress: string): Promise<boolean> {
    const config = await configService.loadAgentConfig(agentId);
    const minimumBalance = config.purchaseLimits.minimumAgentBalance;

    const [solBalance, positionCount] = await Promise.all([
      getSolBalance(agentId, walletAddress),
      getOpenPositionCount(agentId),
    ]);

    if (solBalance < minimumBalance) return false;
    if (positionCount >= MAX_OPEN_POSITIONS) return false;
    return true;
  }

  /**
   * Load all open positions for the agent, score each one, and compare against
   * the incoming signal's expected move.
   *
   * Returns a replacement decision with the weakest position when the incoming
   * signal beats it by more than `replacementMargin` (proportional, in % units).
   *
   * @param bypassThreshold - When true (capital-lock path), always replace the
   *   weakest position regardless of the margin threshold.
   */
  async evaluateReplacement(
    agentId: string,
    walletAddress: string,
    incomingExpectedMovePct: number,
    now: Date,
    bypassThreshold: boolean,
    /** Current SOL balance — used in capital-lock path to determine how many positions to eject */
    currentSolBalance?: number,
    /** Minimum SOL balance that must remain after ejections + new purchase */
    minimumBalance?: number,
  ): Promise<{
    shouldReplace: boolean;
    positionsToClose?: Array<{ id: string; symbol: string; rv: number }>;
    reason: string;
    weakestRv?: number;
  }> {
    const config = await configService.loadAgentConfig(agentId);
    const portfolioConfig = config.portfolio ?? DEFAULT_PORTFOLIO_CONFIG;

    // Load all open positions for this agent+wallet from DB
    const dbPositions = await prisma.agentPosition.findMany({
      where: { agentId, walletAddress },
      select: {
        id: true,
        tokenAddress: true,
        tokenSymbol: true,
        purchasePrice: true,
        purchaseAmount: true,
        signalScore: true,
        expectedMovePct: true,
        createdAt: true,
      },
    });

    if (dbPositions.length === 0) {
      return { shouldReplace: false, reason: 'no_positions' };
    }

    // Batch-fetch current prices
    const tokenAddresses = dbPositions.map((p) => p.tokenAddress);
    const priceMap = new Map<string, number>();
    try {
      const prices = await priceFeedService.getMultipleTokenPrices(tokenAddresses);
      for (const p of prices) {
        priceMap.set(p.tokenAddress.toLowerCase(), p.priceSol);
      }
    } catch (err) {
      logger.warn({ agentId, err }, 'PortfolioManager: failed to fetch prices for replacement evaluation');
    }

    // Derive tp3Price from config take-profit levels if available
    const tp3TargetPercent = (() => {
      const levels = config.takeProfit?.levels;
      if (levels && levels.length >= 3) return levels[2].targetPercent;
      return 25; // fallback: 25% gain as tp3 proxy
    })();

    // Score each position; also estimate current SOL value for capital-lock ejection sizing
    const scored: Array<{ id: string; symbol: string; rv: number; estimatedSolValue: number }> = [];
    for (const p of dbPositions) {
      const entryPrice = typeof p.purchasePrice === 'object' && 'toNumber' in p.purchasePrice
        ? (p.purchasePrice as unknown as { toNumber: () => number }).toNumber()
        : Number(p.purchasePrice);

      const purchaseAmountSol = typeof p.purchaseAmount === 'object' && 'toNumber' in p.purchaseAmount
        ? (p.purchaseAmount as unknown as { toNumber: () => number }).toNumber()
        : Number(p.purchaseAmount);

      const currentPrice = priceMap.get(p.tokenAddress.toLowerCase()) ?? entryPrice;
      const tp3Price = entryPrice * (1 + tp3TargetPercent / 100);

      // Estimated current SOL value: scale purchase cost by price ratio
      const priceRatio = entryPrice > 0 ? currentPrice / entryPrice : 1;
      const estimatedSolValue = purchaseAmountSol * priceRatio;

      const pos: PositionForScoring = {
        id: p.id,
        tokenSymbol: p.tokenSymbol,
        signalScore: p.signalScore,
        expectedMovePct: p.expectedMovePct,
        entryPrice,
        currentPrice,
        tp3Price,
        openedAt: p.createdAt,
      };

      const rv = remainingValue(pos, {
        requireScoreForReplacement: portfolioConfig.requireScoreForReplacement,
        positionDecayHours: portfolioConfig.positionDecayHours ?? DEFAULT_PORTFOLIO_CONFIG.positionDecayHours,
      }, now);
      scored.push({ id: p.id, symbol: p.tokenSymbol, rv, estimatedSolValue });
    }

    // Sort ascending by RV — weakest first
    scored.sort((a, b) => a.rv - b.rv);

    const weakest = scored[0];

    // Capital-lock path: eject the minimum number of positions (weakest first, each
    // must have rv < incomingExpectedMovePct) until enough SOL is freed to fund a new trade.
    if (bypassThreshold) {
      // Positions eligible to eject: incoming must be stronger (rv < incoming)
      const eligible = scored.filter(p => incomingExpectedMovePct > p.rv);

      if (eligible.length === 0) {
        return {
          shouldReplace: false,
          reason: `capital_locked_but_all_positions_stronger_than_incoming_${incomingExpectedMovePct.toFixed(2)}pct`,
          weakestRv: weakest.rv,
        };
      }

      // How much headroom do we need above the minimum balance?
      // Use the small-tier minimum position size as the floor (0.1 SOL default).
      const smallTierMin = config.positionCalculator?.positionSizes?.small?.min ?? 0.1;
      const minRequired = (minimumBalance ?? 0) + smallTierMin;
      const available = currentSolBalance ?? 0;

      const toEject: Array<{ id: string; symbol: string; rv: number }> = [];
      let projectedBalance = available;

      for (const p of eligible) {
        if (projectedBalance >= minRequired) break;
        toEject.push({ id: p.id, symbol: p.symbol, rv: p.rv });
        projectedBalance += p.estimatedSolValue;
      }

      // Even if not enough (all eligible positions are tiny), still eject what we can
      if (toEject.length === 0) toEject.push({ id: eligible[0].id, symbol: eligible[0].symbol, rv: eligible[0].rv });

      return {
        shouldReplace: true,
        positionsToClose: toEject,
        reason: `capital_lock_ejecting_${toEject.length}_position(s)_weakest_rv_${weakest.rv.toFixed(3)}`,
        weakestRv: weakest.rv,
      };
    }

    // Proportional threshold: incoming (in %) must beat weakest rv (in %) by replacementMargin factor
    if (incomingExpectedMovePct > weakest.rv * (1 + portfolioConfig.replacementMargin)) {
      return {
        shouldReplace: true,
        positionsToClose: [{ id: weakest.id, symbol: weakest.symbol, rv: weakest.rv }],
        reason: `incoming_${incomingExpectedMovePct.toFixed(2)}pct_beats_weakest_rv_${weakest.rv.toFixed(2)}pct`,
        weakestRv: weakest.rv,
      };
    }

    return {
      shouldReplace: false,
      reason: `incoming_${incomingExpectedMovePct.toFixed(2)}pct_insufficient_vs_weakest_rv_${weakest.rv.toFixed(2)}pct`,
      weakestRv: weakest.rv,
    };
  }

  /**
   * Main entry point — called by the signal processor before every purchase.
   *
   * Logic:
   *   1. Resolve wallet for agent.
   *   2. Fetch balance + position count in parallel.
   *   3. If balance < minimumAgentBalance AND positions > 0:
   *        capital locked → force-replace weakest (no threshold check).
   *   4. If positionCount < MAX_OPEN_POSITIONS AND balance >= min:
   *        proceed (open new slot — preferred over replacement).
   *   5. If positionCount >= MAX_OPEN_POSITIONS:
   *        threshold-gated replacement.
   *   6. Otherwise → suppress.
   */
  async evaluateTrade(params: {
    agentId: string;
    walletAddress?: string;
    incomingScore?: number;
    incomingExpectedMovePct?: number;
    now: Date;
  }): Promise<TradeDecision> {
    const { agentId, incomingExpectedMovePct, now } = params;

    // Resolve wallet address
    const walletAddress = params.walletAddress ?? await getDefaultWalletAddress(agentId);
    if (!walletAddress) {
      return { action: 'suppress', reason: 'no_wallet_found' };
    }

    const config = await configService.loadAgentConfig(agentId);
    const minimumBalance = config.purchaseLimits.minimumAgentBalance;

    const [solBalance, positionCount] = await Promise.all([
      getSolBalance(agentId, walletAddress),
      getOpenPositionCount(agentId),
    ]);

    // Path 3: capital locked — force-replace weakest regardless of score.
    // Triggered when balance is below minimum OR when the headroom above the
    // minimum is too small to fund a real trade (< 0.01 SOL = 10M lamports).
    // The latter handles the floating-point edge case where balance is
    // epsilon above minimumBalance but effectively at the floor.
    const MIN_USABLE_ABOVE_MINIMUM = 0.01; // SOL
    const capitalLocked =
      (solBalance < minimumBalance ||
        solBalance - minimumBalance < MIN_USABLE_ABOVE_MINIMUM) &&
      positionCount > 0;
    if (capitalLocked) {
      logger.info(
        { agentId, solBalance, minimumBalance, positionCount },
        'PortfolioManager: capital locked — evaluating force-replace',
      );

      if (incomingExpectedMovePct == null) {
        return { action: 'suppress', reason: 'capital_locked_no_expected_move_for_comparison' };
      }

      const replacement = await this.evaluateReplacement(
        agentId,
        walletAddress,
        incomingExpectedMovePct,
        now,
        true, // bypassThreshold
        solBalance,
        minimumBalance,
      );

      if (replacement.shouldReplace && replacement.positionsToClose?.length) {
        return {
          action: 'replace',
          positionsToClose: replacement.positionsToClose,
        };
      }

      return { action: 'suppress', reason: replacement.reason };
    }

    // Path 4: free slot available — open normally
    if (positionCount < MAX_OPEN_POSITIONS && solBalance >= minimumBalance + MIN_USABLE_ABOVE_MINIMUM) {
      return { action: 'proceed' };
    }

    // Path 5: at capacity — threshold-gated replacement
    if (positionCount >= MAX_OPEN_POSITIONS) {
      if (incomingExpectedMovePct == null) {
        return { action: 'suppress', reason: 'capacity_full_no_expected_move_for_comparison' };
      }

      const replacement = await this.evaluateReplacement(
        agentId,
        walletAddress,
        incomingExpectedMovePct,
        now,
        false, // threshold-gated
      );

      if (replacement.shouldReplace && replacement.positionsToClose?.length) {
        return {
          action: 'replace',
          positionsToClose: replacement.positionsToClose,
        };
      }

      return {
        action: 'suppress',
        reason: replacement.reason,
        weakestRv: replacement.weakestRv,
        incomingScore: incomingExpectedMovePct,
      };
    }

    // Path 6: suppress (e.g. balance below min, no positions to replace)
    return { action: 'suppress', reason: 'insufficient_balance_no_positions' };
  }
}

export const portfolioManagerService = new PortfolioManagerService();
