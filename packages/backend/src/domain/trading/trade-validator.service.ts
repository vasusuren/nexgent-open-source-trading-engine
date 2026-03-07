/**
 * Trade Validator Service
 * 
 * Validates trade execution requests before they are processed.
 * Ensures all preconditions are met (agent exists, wallet unlocked, sufficient balance, etc.).
 */

import { prisma } from '@/infrastructure/database/client.js';
import logger from '@/infrastructure/logging/logger.js';
import { configService } from './config-service.js';
import { positionService } from './position-service.js';
import { positionCalculator } from './position-calculator.service.js';
import { redisBalanceService } from '@/infrastructure/cache/redis-balance-service.js';
import { redisPositionService } from '@/infrastructure/cache/redis-position-service.js';
import { walletStore } from '@/infrastructure/wallets/index.js';
import { validateWalletBelongsToAgent } from '../../api/v1/wallets/helpers.js';
import type { AgentTradingConfig } from '@nexgent/shared';
import { MAX_OPEN_POSITIONS } from '@nexgent/shared';

/**
 * Trade validator error
 */
export class TradeValidatorError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TradeValidatorError';
  }
}

/**
 * Trade validation result
 */
export interface TradeValidationResult {
  /** Whether validation passed */
  valid: boolean;
  
  /** Error message if validation failed */
  error?: string;
  
  /** Error code if validation failed */
  errorCode?: string;
  
  /** Agent trading configuration (if validation passed) */
  config?: AgentTradingConfig;
  
  /** Current SOL balance (if validation passed) */
  currentSolBalance?: number;
  
  /** Calculated position size (if validation passed) */
  positionSize?: number;
}

/**
 * Trade Validator Service
 * 
 * Singleton service for validating trade execution.
 */
class TradeValidator {
  /** SOL token address (native SOL mint) */
  private readonly SOL_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';
  
  /**
   * Validate trade execution
   * 
   * Performs all pre-trade validation checks:
   * - Agent exists and is valid
   * - Wallet exists, belongs to agent, and is unlocked
   * - Sufficient SOL balance
   * - Minimum balance threshold met
   * - No existing open position for token
   * - Position size is valid
   * 
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address
   * @param tokenAddress - Token address to purchase
   * @param positionSize - Desired position size in SOL (optional, will be calculated if not provided)
   * @returns Validation result with config, balance, and position size if valid
   * @throws TradeValidatorError if validation fails
   */
  async validateTradeExecution(
    agentId: string,
    walletAddress: string,
    tokenAddress: string,
    positionSize?: number
  ): Promise<TradeValidationResult> {
    // 1. Check agent exists
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        tradingMode: true,
      },
    });

    if (!agent) {
      throw new TradeValidatorError(
        `Agent not found: ${agentId}`,
        'AGENT_NOT_FOUND'
      );
    }

    // 2. Load trading configuration
    let config: AgentTradingConfig;
    try {
      config = await configService.loadAgentConfig(agentId);
    } catch (error) {
      if (error instanceof Error && error.name === 'ConfigServiceError') {
        throw new TradeValidatorError(
          `Failed to load trading configuration: ${error.message}`,
          'CONFIG_ERROR',
          { originalError: (error as { code?: string }).code }
        );
      }
      throw error;
    }

    // 3. Check wallet exists and belongs to agent
    const wallet = await prisma.agentWallet.findFirst({
      where: {
        walletAddress: walletAddress,
        agentId,
      },
      select: {
        walletAddress: true,
        walletType: true,
      },
    });

    if (!wallet) {
      throw new TradeValidatorError(
        `Wallet not found or does not belong to agent`,
        'WALLET_NOT_FOUND',
        { walletAddress, agentId }
      );
    }

    // Verify wallet belongs to agent (double-check)
    const walletBelongsToAgent = await validateWalletBelongsToAgent(walletAddress, agentId);
    if (!walletBelongsToAgent) {
      throw new TradeValidatorError(
        `Wallet does not belong to agent`,
        'WALLET_MISMATCH',
        { walletAddress, agentId }
      );
    }

    // 4. Check wallet is available (for live wallets only)
    // Simulation wallets don't need to be in WalletStore (no private key needed)
    if (wallet.walletType === 'live' && !walletStore.isWalletAvailable(wallet.walletAddress)) {
      const loadedCount = walletStore.getLoadedCount();
      const availableAddresses = walletStore.getAllWalletAddresses();
      logger.warn({
        walletAddress: wallet.walletAddress,
        loadedCount,
        availableAddresses: availableAddresses.join(', ') || 'none',
        msg: 'Live wallet is not loaded',
      });
      throw new TradeValidatorError(
        `Wallet not loaded from environment. Please configure WALLET_1, WALLET_2, etc. environment variables.`,
        'WALLET_NOT_LOADED',
        { walletAddress: wallet.walletAddress }
      );
    }

    // 5. Check trading mode matches wallet type
    if (agent.tradingMode !== wallet.walletType) {
      throw new TradeValidatorError(
        `Trading mode mismatch: agent is in '${agent.tradingMode}' mode but wallet is '${wallet.walletType}'`,
        'TRADING_MODE_MISMATCH',
        { agentTradingMode: agent.tradingMode, walletType: wallet.walletType }
      );
    }

    // 6. Load balances (check cache first, then database)
    const currentSolBalance = await this.getSolBalance(agentId, walletAddress);

    if (currentSolBalance <= 0) {
      throw new TradeValidatorError(
        'Insufficient SOL balance',
        'INSUFFICIENT_BALANCE',
        { currentBalance: currentSolBalance }
      );
    }

    // 7. Check minimum balance threshold
    const minimumBalance = config.purchaseLimits.minimumAgentBalance;
    if (currentSolBalance < minimumBalance) {
      throw new TradeValidatorError(
        `Balance below minimum threshold: ${minimumBalance} SOL`,
        'BELOW_MINIMUM_THRESHOLD',
        {
          currentBalance: currentSolBalance,
          minimumBalance,
        }
      );
    }

    // 8. Check for existing open position (prevent duplicates)
    const existingPosition = await positionService.getPositionByToken(
      agentId,
      walletAddress,
      tokenAddress
    );

    if (existingPosition) {
      throw new TradeValidatorError(
        `Position already exists for token: ${tokenAddress}`,
        'POSITION_EXISTS',
        {
          tokenAddress,
          positionId: existingPosition.id,
          purchasePrice: existingPosition.purchasePrice,
          purchaseAmount: existingPosition.purchaseAmount,
        }
      );
    }

    // 8.5. Check maximum open positions limit
    const openPositionCount = await this.getOpenPositionCount(agentId);
    if (openPositionCount >= MAX_OPEN_POSITIONS) {
      throw new TradeValidatorError(
        `Agent has reached maximum limit of ${MAX_OPEN_POSITIONS} open positions`,
        'MAX_POSITIONS_EXCEEDED',
        {
          currentCount: openPositionCount,
          maxPositions: MAX_OPEN_POSITIONS,
        }
      );
    }

    // 9. Calculate or validate position size
    let finalPositionSize: number;
    
    if (positionSize !== undefined) {
      // Position size provided - validate it
      if (positionSize <= 0) {
        throw new TradeValidatorError(
          'Position size must be positive',
          'INVALID_POSITION_SIZE',
          { positionSize }
        );
      }

      if (positionSize > currentSolBalance) {
        throw new TradeValidatorError(
          'Position size exceeds available balance',
          'POSITION_SIZE_EXCEEDS_BALANCE',
          { positionSize, currentBalance: currentSolBalance }
        );
      }

      // Ensure remaining balance meets minimum threshold
      const remainingBalance = currentSolBalance - positionSize;
      if (remainingBalance < minimumBalance) {
        throw new TradeValidatorError(
          `Position size would violate minimum balance requirement: ${minimumBalance} SOL`,
          'VIOLATES_MINIMUM_BALANCE',
          {
            positionSize,
            currentBalance: currentSolBalance,
            minimumBalance,
            remainingBalance,
          }
        );
      }

      // Check maxPurchasePerToken limit
      if (positionSize > config.purchaseLimits.maxPurchasePerToken) {
        throw new TradeValidatorError(
          `Position size exceeds maximum purchase per token: ${config.purchaseLimits.maxPurchasePerToken} SOL`,
          'EXCEEDS_MAX_PURCHASE',
          {
            positionSize,
            maxPurchasePerToken: config.purchaseLimits.maxPurchasePerToken,
          }
        );
      }

      finalPositionSize = positionSize;
    } else {
      // Position size not provided - calculate it
      try {
        const calculationResult = await positionCalculator.calculatePositionSize(
          agentId,
          walletAddress,
          currentSolBalance,
          config
        );
        finalPositionSize = calculationResult.size;
      } catch (error) {
        if (error instanceof Error && error.name === 'PositionCalculatorError') {
          throw new TradeValidatorError(
            `Failed to calculate position size: ${error.message}`,
            'POSITION_CALCULATION_ERROR',
            { originalError: (error as { code?: string }).code }
          );
        }
        throw error;
      }
    }

    // All validations passed
    return {
      valid: true,
      config,
      currentSolBalance,
      positionSize: finalPositionSize,
    };
  }

  /**
   * Get SOL balance for agent and wallet
   * 
   * Checks cache first, then database.
   * 
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address
   * @returns SOL balance as number
   */
  private async getSolBalance(agentId: string, walletAddress: string): Promise<number> {
    // Check cache first
    const cached = await redisBalanceService.getBalance(agentId, walletAddress, this.SOL_TOKEN_ADDRESS);
    
    if (cached) {
      return this.parseBalance(cached.balance);
    }

    // Load from database
    const balance = await prisma.agentBalance.findUnique({
      where: {
        walletAddress_tokenAddress: {
          walletAddress,
          tokenAddress: this.SOL_TOKEN_ADDRESS,
        }
      }
    });

    if (!balance) {
      return 0;
    }

    // Cache it
    await redisBalanceService.setBalance({
        id: balance.id,
        agentId: balance.agentId,
        walletAddress: balance.walletAddress,
        tokenAddress: balance.tokenAddress,
        tokenSymbol: balance.tokenSymbol,
        balance: balance.balance,
        lastUpdated: balance.lastUpdated
    });

    return this.parseBalance(balance.balance);
  }

  /**
   * Parse balance string to number (handling lamports if needed)
   */
  private parseBalance(balanceStr: string): number {
    const balance = parseFloat(balanceStr);
    
    // Handle lamports (if balance is very large, it might be in lamports)
    // 1 SOL = 1,000,000,000 lamports
    // If balance > 1 million, assume it's in lamports
    if (balance > 1_000_000) {
      return balance / 1_000_000_000; // Convert lamports to SOL
    }

    return balance;
  }

  /**
   * Get count of open positions for an agent
   * 
   * Checks Redis cache first (fast), then falls back to database if needed.
   * 
   * @param agentId - Agent ID
   * @returns Count of open positions
   */
  private async getOpenPositionCount(agentId: string): Promise<number> {
    // Try Redis first (fast O(1) operation)
    try {
      const positionIds = await redisPositionService.getAgentPositionIds(agentId);
      if (positionIds.length > 0) {
        return positionIds.length;
      }
    } catch (error) {
      // Redis might be unavailable or cache might be cold, fall back to database
      logger.warn({ agentId, error }, 'Failed to get position count from Redis, falling back to database');
    }

    // Fallback to database count
    const positions = await prisma.agentPosition.findMany({
      where: { agentId },
      select: { id: true }, // Only select ID for efficiency
    });

    return positions.length;
  }
}

// Export singleton instance
export const tradeValidator = new TradeValidator();

