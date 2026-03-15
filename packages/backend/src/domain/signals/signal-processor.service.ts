/**
 * Signal Processor Service
 * 
 * Orchestrates the processing of trading signals.
 * Listens for new signals and triggers execution for eligible agents.
 */

import { signalEventEmitter } from './signal-events.js';
import { agentEligibilityService } from './agent-eligibility.service.js';
import { signalExecutionService } from './execution-tracker.service.js';
import { tradingExecutor, TradingExecutorError } from '../trading/trading-executor.service.js';
import { portfolioManagerService } from '../portfolio/index.js';
import { redisService } from '@/infrastructure/cache/redis-client.js';
import { REDIS_KEYS, REDIS_TTL } from '@/shared/constants/redis-keys.js';
import { fetchTokenMetrics } from '@/infrastructure/external/jupiter/index.js';
import type { TradingSignal } from '@prisma/client';
import { signalProcessingLatency, signalProcessingCount, errorCount } from '@/infrastructure/metrics/metrics.js';
import logger from '@/infrastructure/logging/logger.js';

export class SignalProcessor {
  private static instance: SignalProcessor;
  private isProcessing: boolean = false;

  private constructor() {
    this.setupEventListeners();
  }

  public static getInstance(): SignalProcessor {
    if (!SignalProcessor.instance) {
      SignalProcessor.instance = new SignalProcessor();
    }
    return SignalProcessor.instance;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    signalEventEmitter.on('signal_created', async (event) => {
      await this.processSignal(event.signal);
    });
    logger.info('Signal Processor listening for signal_created events');
  }

  /**
   * Process a trading signal
   */
  public async processSignal(signal: TradingSignal): Promise<void> {
    const startTime = Date.now();
    const signalLogger = logger.child({ signalId: signal.id, tokenAddress: signal.tokenAddress });
    
    signalLogger.info('Processing signal');

    try {
      // 1. Fetch token metrics once per signal (one Jupiter API call; reused for all agents)
      const tokenMetrics = await fetchTokenMetrics(signal.tokenAddress);

      // 2. Get eligible agents (pass token metrics for token-metrics pre-check)
      const eligibleAgentIds = await agentEligibilityService.getEligibleAgents(signal, tokenMetrics);
      signalLogger.info({ eligibleAgentCount: eligibleAgentIds.length }, 'Found eligible agents');

      if (eligibleAgentIds.length === 0) {
        const duration = Date.now() - startTime;
        const durationSeconds = duration / 1000;
        signalProcessingLatency.observe({ status: 'skipped' }, durationSeconds);
        signalProcessingCount.inc({ status: 'skipped' });
        return;
      }

      // 3. Execute for each agent
      // We execute in parallel for maximum speed
      await Promise.all(eligibleAgentIds.map(async (agentId) => {
        await this.executeForAgent(agentId, signal);
      }));

      // Record success metrics
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;
      signalProcessingLatency.observe({ status: 'success' }, durationSeconds);
      signalProcessingCount.inc({ status: 'success' });
      
      signalLogger.info({ duration, eligibleAgentCount: eligibleAgentIds.length }, 'Signal processing completed');

    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = duration / 1000;
      
      // Record failure metrics
      signalProcessingLatency.observe({ status: 'failed' }, durationSeconds);
      signalProcessingCount.inc({ status: 'failed' });
      errorCount.inc({ type: 'signals', code: 'PROCESSING_FAILED' });
      
      signalLogger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration,
      }, 'Error processing signal');
    }
  }

  /**
   * Execute signal for a specific agent
   */
  private async executeForAgent(agentId: string, signal: TradingSignal): Promise<void> {
    // 1. Create execution record (deduplication)
    const executionId = await signalExecutionService.createPendingExecution(signal.id, agentId);
    
    if (!executionId) {
      // Already processing or processed
      return;
    }

    // Acquire per-agent lock to prevent concurrent signals from double-spending capital
    const lockKey = REDIS_KEYS.LOCK(`portfolio:agent:${agentId}`);
    const lockToken = await redisService.acquireLock(lockKey, REDIS_TTL.LOCK);

    try {
      if (!lockToken) {
        // Another signal is mid-execution for this agent — skip rather than risk double-spend
        logger.info({ signalId: signal.id, agentId, executionId }, 'Signal skipped: agent portfolio lock held by concurrent signal');
        await signalExecutionService.updateExecutionSkipped(executionId, 'agent_portfolio_locked');
        return;
      }

      // 2. Portfolio management: decide whether to proceed, replace, or suppress
      const decision = await portfolioManagerService.evaluateTrade({
        agentId,
        incomingScore: (signal as unknown as Record<string, unknown>).signalScore != null
          ? Number((signal as unknown as Record<string, unknown>).signalScore)
          : undefined,
        incomingExpectedMovePct: (signal as unknown as Record<string, unknown>).expectedMovePct != null
          ? Number((signal as unknown as Record<string, unknown>).expectedMovePct)
          : undefined,
        now: new Date(),
      });

      if (decision.action === 'suppress') {
        logger.info({
          signalId: signal.id,
          agentId,
          executionId,
          reason: decision.reason,
          weakestRv: decision.weakestRv,
          incomingScore: decision.incomingScore,
        }, 'Signal suppressed by portfolio manager');
        await signalExecutionService.updateExecutionSkipped(executionId, decision.reason);
        return;
      }

      if (decision.action === 'replace') {
        logger.info({
          signalId: signal.id,
          agentId,
          executionId,
          positionsToClose: decision.positionsToClose,
          count: decision.positionsToClose.length,
        }, `Portfolio replacing ${decision.positionsToClose.length} position(s) with incoming signal`);
        // Eject each position sequentially (capital lock may require multiple)
        for (const pos of decision.positionsToClose) {
          await tradingExecutor.executeSale({
            agentId,
            positionId: pos.id,
            reason: 'replaced_by_higher_score_signal',
          });
        }
        // Fall through — executePurchase opens the new position
      }

      // 3. Execute trade
      // Note: walletAddress is optional, executor will pick default for agent
      const result = await tradingExecutor.executePurchase({
        agentId,
        tokenAddress: signal.tokenAddress,
        tokenSymbol: signal.symbol || undefined,
        signalId: signal.id,
        positionSizeMultiplier: (signal as unknown as Record<string, unknown>).positionSizeMultiplier != null
          ? Number((signal as unknown as Record<string, unknown>).positionSizeMultiplier)
          : undefined,
        signalScore: (signal as unknown as Record<string, unknown>).signalScore != null
          ? Number((signal as unknown as Record<string, unknown>).signalScore)
          : undefined,
        expectedMovePct: (signal as unknown as Record<string, unknown>).expectedMovePct != null
          ? Number((signal as unknown as Record<string, unknown>).expectedMovePct)
          : undefined,
      });

      // 4. Update execution status (Success)
      await signalExecutionService.updateExecutionSuccess(executionId, result.transactionId);
      
      logger.info({
        signalId: signal.id,
        agentId,
        executionId,
        transactionId: result.transactionId,
        positionId: result.positionId,
      }, 'Executed trade for agent on signal');

    } catch (error) {
      // 4. Update execution status (Failure)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof TradingExecutorError ? error.code : 'EXECUTION_FAILED';
      
      // Downgrade insufficient balance errors to warnings (expected business logic)
      const isInsufficientBalance = errorCode === 'INSUFFICIENT_BALANCE' || 
                                    errorMessage.includes('Insufficient SOL balance') ||
                                    errorMessage.includes('Insufficient balance');
      
      if (isInsufficientBalance) {
        logger.warn({
          signalId: signal.id,
          agentId,
          executionId,
          error: errorMessage,
          code: errorCode,
        }, 'Trade skipped: insufficient balance');
      } else {
        logger.error({
          signalId: signal.id,
          agentId,
          executionId,
          error: errorMessage,
          code: errorCode,
        }, 'Failed to execute trade for agent');
      }
      
      errorCount.inc({ type: 'signals', code: errorCode });
      
      // Check if it was a "soft" failure (e.g. insufficient balance) or hard error
      // We record it as FAILED regardless, but error message helps
      await signalExecutionService.updateExecutionFailure(executionId, error as Error);
    } finally {
      if (lockToken) {
        await redisService.releaseLock(lockKey, lockToken);
      }
    }
  }
}

// Export singleton instance
export const signalProcessor = SignalProcessor.getInstance();

