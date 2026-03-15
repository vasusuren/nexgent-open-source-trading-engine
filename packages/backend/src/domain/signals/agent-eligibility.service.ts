/**
 * Agent Eligibility Service
 *
 * Determines which agents should act on a given trading signal.
 * Uses Redis for high-performance lookups.
 */

import { redisAgentService } from '@/infrastructure/cache/redis-agent-service.js';
import { redisConfigService } from '@/infrastructure/cache/redis-config-service.js';
import { prisma } from '@/infrastructure/database/client.js';
import type { TradingSignal } from '@prisma/client';
import type { TokenMetrics } from '@/infrastructure/external/jupiter/index.js';

export class AgentEligibilityService {
  private static instance: AgentEligibilityService;

  private constructor() {}

  public static getInstance(): AgentEligibilityService {
    if (!AgentEligibilityService.instance) {
      AgentEligibilityService.instance = new AgentEligibilityService();
    }
    return AgentEligibilityService.instance;
  }

  /**
   * Get all agents eligible to trade on a signal.
   * @param signal - The trading signal
   * @param tokenMetrics - Token metrics from Jupiter (one fetch per signal); null if unavailable
   */
  public async getEligibleAgents(signal: TradingSignal, tokenMetrics: TokenMetrics | null): Promise<string[]> {
    // 0. Enforce user scoping — signals must be tied to a creator
    if (!signal.userId) {
      console.warn(`[AgentEligibility] Signal ${signal.id} has no userId — skipping (legacy signal)`);
      return [];
    }

    // 1. Get all active agents from Redis
    const activeAgentIds = await redisAgentService.getActiveAgentIds();
    console.log(`[AgentEligibility] Found ${activeAgentIds.length} active agents`);

    if (activeAgentIds.length === 0) {
      console.warn('[AgentEligibility] ⚠️  No active agents found in Redis. Make sure cache was warmed up.');
      return [];
    }

    // 2. Scope to the signal creator's agents only
    const userAgents = await prisma.agent.findMany({
      where: { userId: signal.userId },
      select: { id: true },
    });
    const userAgentIdSet = new Set(userAgents.map(a => a.id));
    const scopedAgentIds = activeAgentIds.filter(id => userAgentIdSet.has(id));

    console.log(`[AgentEligibility] Scoped to ${scopedAgentIds.length} active agents belonging to user ${signal.userId}`);

    if (scopedAgentIds.length === 0) {
      console.log(`[AgentEligibility] No active agents for user ${signal.userId}`);
      return [];
    }

    const eligibleAgentIds: string[] = [];

    // 3. Check eligibility for each scoped agent (in parallel)
    await Promise.all(scopedAgentIds.map(async (agentId) => {
      const isEligible = await this.checkEligibility(agentId, signal, tokenMetrics);
      if (isEligible) {
        eligibleAgentIds.push(agentId);
      }
    }));

    console.log(`[AgentEligibility] ${eligibleAgentIds.length} of ${scopedAgentIds.length} agents are eligible for signal ${signal.id}`);
    return eligibleAgentIds;
  }

  /**
   * Check if a specific agent is eligible for a signal.
   * Returns eligibility result with detailed reasons.
   */
  private async checkEligibility(
    agentId: string,
    signal: TradingSignal,
    tokenMetrics: TokenMetrics | null
  ): Promise<boolean> {
    const reasons: string[] = [];

    // 0. Check if automated trading is enabled for agent's current mode (single Redis round trip)
    const automatedTrading = await redisAgentService.isAutomatedTradingEnabled(agentId);
    if (!automatedTrading) {
      console.log(`[AgentEligibility] ⏸️  Agent ${agentId}: Automated trading is paused`);
      return false;
    }

    // 1. Get agent configuration
    const config = await redisConfigService.getAgentConfig(agentId);
    if (!config) {
      reasons.push('No config found in Redis');
      console.log(`[AgentEligibility] ❌ Agent ${agentId}: ${reasons.join(', ')}`);
      return false;
    }

    // 2. Check Signal Score (coarse integer gate)
    if (signal.signalStrength < config.signals.minScore) {
      reasons.push(`Signal strength ${signal.signalStrength} < minScore ${config.signals.minScore}`);
    }

    // 2b. Check composite signal score (fine-grained float gate)
    const signalScore = (signal as unknown as Record<string, unknown>).signalScore;
    if (config.signals.minSignalScore != null && signalScore != null) {
      if (Number(signalScore) < config.signals.minSignalScore) {
        reasons.push(`signalScore ${Number(signalScore).toFixed(3)} < minSignalScore ${config.signals.minSignalScore}`);
      }
    }

    // 2c. Check minimum expected move percentage
    const expectedMovePct = (signal as unknown as Record<string, unknown>).expectedMovePct;
    if (config.signals.minExpectedMove != null && config.signals.minExpectedMove > 0) {
      if (expectedMovePct == null || Number(expectedMovePct) < config.signals.minExpectedMove) {
        reasons.push(`expectedMovePct ${expectedMovePct} < minExpectedMove ${config.signals.minExpectedMove}`);
      }
    }

    // 3. Check Signal Type Filter (if configured)
    if (config.signals.allowedSignalTypes && config.signals.allowedSignalTypes.length > 0) {
      if (!config.signals.allowedSignalTypes.includes(signal.signalType)) {
        reasons.push(`Signal type '${signal.signalType}' not in allowed types [${config.signals.allowedSignalTypes.join(', ')}]`);
      }
    }

    // 4. Check Token Filter (blacklist/whitelist)
    if (config.signals.tokenFilterMode === 'blacklist') {
      if (config.signals.tokenList.includes(signal.tokenAddress)) {
        reasons.push(`Token ${signal.tokenAddress} is blacklisted`);
      }
    } else if (config.signals.tokenFilterMode === 'whitelist') {
      if (!config.signals.tokenList.includes(signal.tokenAddress)) {
        reasons.push(`Token ${signal.tokenAddress} not in whitelist`);
      }
    }
    // tokenFilterMode === 'none' means accept all tokens (no filter)

    // 5. Check Token Metrics (Jupiter) - if agent has any bounds set
    const hasTokenMetricsBounds = this.hasTokenMetricsBounds(config.signals);
    if (hasTokenMetricsBounds) {
      if (tokenMetrics === null) {
        reasons.push('Token metrics unavailable (Jupiter API); agent has token metrics bounds set');
      } else {
        const metricsReason = this.checkTokenMetricsBounds(config.signals, tokenMetrics);
        if (metricsReason) {
          reasons.push(metricsReason);
        }
      }
    }

    // If any checks failed, log all reasons and return false
    if (reasons.length > 0) {
      console.log(`[AgentEligibility] ❌ Agent ${agentId}: Not eligible - ${reasons.join('; ')}`);
      return false;
    }

    console.log(`[AgentEligibility] ✅ Agent ${agentId} is eligible for signal ${signal.id} (type: ${signal.signalType}, strength: ${signal.signalStrength})`);
    return true;
  }

  private hasTokenMetricsBounds(signals: {
    marketCapMin?: number;
    marketCapMax?: number;
    liquidityMin?: number;
    liquidityMax?: number;
    holderCountMin?: number;
    holderCountMax?: number;
  }): boolean {
    return (
      signals.marketCapMin != null ||
      signals.marketCapMax != null ||
      signals.liquidityMin != null ||
      signals.liquidityMax != null ||
      signals.holderCountMin != null ||
      signals.holderCountMax != null
    );
  }

  /**
   * Check token metrics against agent bounds. Returns reason string if out of bounds, null if pass.
   */
  private checkTokenMetricsBounds(
    signals: {
      marketCapMin?: number;
      marketCapMax?: number;
      liquidityMin?: number;
      liquidityMax?: number;
      holderCountMin?: number;
      holderCountMax?: number;
    },
    metrics: TokenMetrics
  ): string | null {
    if (signals.marketCapMin != null) {
      if (metrics.mcap == null) return 'Token market cap unknown; agent requires minimum market cap';
      if (metrics.mcap < signals.marketCapMin) {
        return `Token market cap ${metrics.mcap} < min ${signals.marketCapMin}`;
      }
    }
    if (signals.marketCapMax != null) {
      if (metrics.mcap == null) return 'Token market cap unknown; agent requires maximum market cap';
      if (metrics.mcap > signals.marketCapMax) {
        return `Token market cap ${metrics.mcap} > max ${signals.marketCapMax}`;
      }
    }
    if (signals.liquidityMin != null) {
      if (metrics.liquidity == null) return 'Token liquidity unknown; agent requires minimum liquidity';
      if (metrics.liquidity < signals.liquidityMin) {
        return `Token liquidity ${metrics.liquidity} < min ${signals.liquidityMin}`;
      }
    }
    if (signals.liquidityMax != null) {
      if (metrics.liquidity == null) return 'Token liquidity unknown; agent requires maximum liquidity';
      if (metrics.liquidity > signals.liquidityMax) {
        return `Token liquidity ${metrics.liquidity} > max ${signals.liquidityMax}`;
      }
    }
    if (signals.holderCountMin != null) {
      if (metrics.holderCount == null) return 'Token holder count unknown; agent requires minimum holders';
      if (metrics.holderCount < signals.holderCountMin) {
        return `Token holder count ${metrics.holderCount} < min ${signals.holderCountMin}`;
      }
    }
    if (signals.holderCountMax != null) {
      if (metrics.holderCount == null) return 'Token holder count unknown; agent requires maximum holders';
      if (metrics.holderCount > signals.holderCountMax) {
        return `Token holder count ${metrics.holderCount} > max ${signals.holderCountMax}`;
      }
    }
    return null;
  }
}

export const agentEligibilityService = AgentEligibilityService.getInstance();


