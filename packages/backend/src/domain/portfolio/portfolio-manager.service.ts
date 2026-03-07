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
  | { action: 'replace'; positionIdToClose: string; positionSymbol: string }
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
   * the incoming signal score.
   *
   * Returns a replacement decision with the weakest position when the incoming
   * signal beats it by more than `replacementMargin`.
   */
  async evaluateReplacement(
    agentId: string,
    walletAddress: string,
    incomingScore: number,
    incomingExpectedMovePct: number | undefined,
    now: Date,
  ): Promise<{
    shouldReplace: boolean;
    positionToClose?: { id: string; symbol: string; rv: number };
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

    // Score each position
    const scored: Array<{ id: string; symbol: string; rv: number }> = [];
    for (const p of dbPositions) {
      const entryPrice = typeof p.purchasePrice === 'object' && 'toNumber' in p.purchasePrice
        ? (p.purchasePrice as unknown as { toNumber: () => number }).toNumber()
        : Number(p.purchasePrice);

      const currentPrice = priceMap.get(p.tokenAddress.toLowerCase()) ?? entryPrice;
      const tp3Price = entryPrice * (1 + tp3TargetPercent / 100);

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
      scored.push({ id: p.id, symbol: p.tokenSymbol, rv });
    }

    // Find weakest
    const weakest = scored.reduce((a, b) => (a.rv < b.rv ? a : b));

    if (incomingScore > weakest.rv + portfolioConfig.replacementMargin) {
      return {
        shouldReplace: true,
        positionToClose: weakest,
        reason: `incoming_score_${incomingScore.toFixed(3)}_beats_weakest_${weakest.rv.toFixed(3)}`,
        weakestRv: weakest.rv,
      };
    }

    return {
      shouldReplace: false,
      reason: `incoming_score_${incomingScore.toFixed(3)}_insufficient_vs_weakest_${weakest.rv.toFixed(3)}`,
      weakestRv: weakest.rv,
    };
  }

  /**
   * Main entry point — called by the signal processor before every purchase.
   *
   * Logic:
   *   1. Resolve wallet for agent.
   *   2. If capacity is available → proceed.
   *   3. If at capacity and no incoming score → suppress (cannot compare).
   *   4. If at capacity and score available → evaluate replacement.
   */
  async evaluateTrade(params: {
    agentId: string;
    walletAddress?: string;
    incomingScore?: number;
    incomingExpectedMovePct?: number;
    now: Date;
  }): Promise<TradeDecision> {
    const { agentId, incomingScore, incomingExpectedMovePct, now } = params;

    // Resolve wallet address
    const walletAddress = params.walletAddress ?? await getDefaultWalletAddress(agentId);
    if (!walletAddress) {
      return { action: 'suppress', reason: 'no_wallet_found' };
    }

    const canAccept = await this.canAcceptTrade(agentId, walletAddress);

    if (canAccept) {
      return { action: 'proceed' };
    }

    // Capacity is full — check if replacement is warranted
    if (incomingScore == null) {
      return {
        action: 'suppress',
        reason: 'capital_full_no_score_for_comparison',
      };
    }

    const replacement = await this.evaluateReplacement(
      agentId,
      walletAddress,
      incomingScore,
      incomingExpectedMovePct,
      now,
    );

    if (replacement.shouldReplace && replacement.positionToClose) {
      return {
        action: 'replace',
        positionIdToClose: replacement.positionToClose.id,
        positionSymbol: replacement.positionToClose.symbol,
      };
    }

    return {
      action: 'suppress',
      reason: replacement.reason,
      weakestRv: replacement.weakestRv,
      incomingScore,
    };
  }
}

export const portfolioManagerService = new PortfolioManagerService();
