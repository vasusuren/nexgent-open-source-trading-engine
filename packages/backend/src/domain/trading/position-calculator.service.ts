/**
 * Position Calculator Service
 * 
 * Calculates position sizes based on SOL balance and trading configuration.
 * Determines category (small/medium/large) and applies randomization if enabled.
 */

import { configService } from './config-service.js';
import type { AgentTradingConfig } from '@nexgent/shared';

/**
 * Position calculator error
 */
export class PositionCalculatorError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PositionCalculatorError';
  }
}

/**
 * Position calculation result
 */
export interface PositionCalculationResult {
  /** Calculated position size in SOL */
  size: number;
  
  /** Category used (small, medium, or large) */
  category: 'small' | 'medium' | 'large';
  
  /** Whether randomization was applied */
  randomized: boolean;
}

/**
 * Position Calculator Service
 * 
 * Singleton service for calculating position sizes.
 */
class PositionCalculator {
  /**
   * Calculate position size for a trade
   *
   * Determines category based on SOL balance, applies randomization if enabled,
   * and ensures constraints are met (maxPurchasePerToken, minimumAgentBalance).
   *
   * When `sizeMultiplier` is provided the size is computed deterministically as:
   *   positionSize = min + sizeMultiplier × (max - min)
   * where [min, max] is the range for the balance category.
   * This bypasses randomization entirely (the random/max path is skipped).
   * All clamping (maxPurchasePerToken, minimumAgentBalance) still applies.
   *
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address
   * @param currentSolBalance - Current SOL balance (as number)
   * @param config - Trading configuration (optional, will load if not provided)
   * @param sizeMultiplier - Optional deterministic multiplier in [0, 1].
   *   When provided: size = min + sizeMultiplier × (max − min).
   * @returns Calculated position size and metadata
   * @throws PositionCalculatorError if balance is insufficient or config invalid
   */
  async calculatePositionSize(
    agentId: string,
    walletAddress: string,
    currentSolBalance: number,
    config?: AgentTradingConfig,
    sizeMultiplier?: number,
  ): Promise<PositionCalculationResult> {
    // Load config if not provided
    const tradingConfig = config || await configService.loadAgentConfig(agentId);

    // Validate balance
    if (currentSolBalance <= 0) {
      throw new PositionCalculatorError(
        'SOL balance must be positive',
        'INSUFFICIENT_BALANCE'
      );
    }

    // Check minimum balance threshold
    if (currentSolBalance < tradingConfig.positionCalculator.solBalanceThresholds.minimum) {
      throw new PositionCalculatorError(
        `Balance below minimum threshold: ${tradingConfig.positionCalculator.solBalanceThresholds.minimum} SOL`,
        'BELOW_MINIMUM_THRESHOLD',
        { currentBalance: currentSolBalance, minimumThreshold: tradingConfig.positionCalculator.solBalanceThresholds.minimum }
      );
    }

    // Determine category based on balance thresholds
    const category = this.determineCategory(
      currentSolBalance,
      tradingConfig.positionCalculator.solBalanceThresholds
    );

    // Get position size range for category
    const sizeRange = tradingConfig.positionCalculator.positionSizes[category];

    // Calculate base position size
    let positionSize: number;
    if (sizeMultiplier !== undefined) {
      // Deterministic: linear interpolation between min and max
      const clampedMultiplier = Math.min(Math.max(sizeMultiplier, 0.0), 1.0);
      positionSize = sizeRange.min + clampedMultiplier * (sizeRange.max - sizeRange.min);
    } else if (tradingConfig.positionCalculator.randomization.enabled) {
      // Randomize between min and max
      positionSize = this.randomizePositionSize(sizeRange.min, sizeRange.max);
    } else {
      // Use maximum for category
      positionSize = sizeRange.max;
    }

    // Apply maxPurchasePerToken limit
    const maxPurchase = tradingConfig.purchaseLimits.maxPurchasePerToken;
    if (positionSize > maxPurchase) {
      positionSize = maxPurchase;
    }

    // Ensure remaining balance meets minimumAgentBalance requirement
    const minimumBalance = tradingConfig.purchaseLimits.minimumAgentBalance;
    const remainingBalance = currentSolBalance - positionSize;
    
    if (remainingBalance < minimumBalance) {
      // Adjust position size to leave minimum balance
      const adjustedSize = currentSolBalance - minimumBalance;
      
      // Floating-point edge case: balance may be only epsilon above minimumBalance,
      // producing an adjustedSize too small to represent as a lamport (1e-9 SOL).
      // Treat sub-lamport adjustedSize as insufficient balance.
      const MIN_LAMPORTS = 10_000; // 0.00001 SOL — practical trade floor
      if (adjustedSize <= 0 || Math.floor(adjustedSize * 1e9) < MIN_LAMPORTS) {
        throw new PositionCalculatorError(
          `Cannot maintain minimum balance: ${minimumBalance} SOL (adjusted size ${adjustedSize.toExponential(3)} SOL too small)`,
          'INSUFFICIENT_BALANCE_FOR_MINIMUM',
          {
            currentBalance: currentSolBalance,
            minimumBalance,
            requestedSize: positionSize,
            adjustedSize,
          }
        );
      }

      // Ensure adjusted size doesn't exceed maxPurchasePerToken
      positionSize = Math.min(adjustedSize, maxPurchase);
    }

    // Final validation: ensure position size is positive and doesn't exceed available balance
    if (positionSize <= 0) {
      throw new PositionCalculatorError(
        'Calculated position size must be positive',
        'INVALID_POSITION_SIZE'
      );
    }

    if (positionSize > currentSolBalance) {
      throw new PositionCalculatorError(
        'Position size exceeds available balance',
        'POSITION_SIZE_EXCEEDS_BALANCE',
        { positionSize, currentBalance: currentSolBalance }
      );
    }

    return {
      size: positionSize,
      category,
      randomized: tradingConfig.positionCalculator.randomization.enabled,
    };
  }

  /**
   * Determine position size category based on SOL balance
   * 
   * @param balance - Current SOL balance
   * @param thresholds - Balance thresholds configuration
   * @returns Category (small, medium, or large)
   */
  private determineCategory(
    balance: number,
    thresholds: {
      minimum: number;
      medium: number;
      large: number;
    }
  ): 'small' | 'medium' | 'large' {
    if (balance >= thresholds.large) {
      return 'large';
    } else if (balance >= thresholds.medium) {
      return 'medium';
    } else {
      return 'small';
    }
  }

  /**
   * Randomize position size within min/max range
   * 
   * @param min - Minimum position size
   * @param max - Maximum position size
   * @returns Random value between min and max (inclusive)
   */
  private randomizePositionSize(min: number, max: number): number {
    if (min >= max) {
      return min; // If min equals max, return that value
    }

    // Generate random number between min and max
    // Using Math.random() which generates [0, 1), so we adjust to [min, max]
    return min + Math.random() * (max - min);
  }

  /**
   * Get SOL balance from balances array
   * 
   * Helper method to extract SOL balance from an array of balances.
   * SOL token address is the native SOL mint: So11111111111111111111111111111111111111112
   * 
   * @param balances - Array of balance objects
   * @returns SOL balance as number, or 0 if not found
   */
  getSolBalance(balances: Array<{ tokenAddress: string; balance: string }>): number {
    const SOL_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';
    
    const solBalance = balances.find(b => b.tokenAddress === SOL_TOKEN_ADDRESS);
    
    if (!solBalance) {
      return 0;
    }

    // Parse balance string to number
    const balance = parseFloat(solBalance.balance);
    
    // Handle lamports (if balance is very large, it might be in lamports)
    // 1 SOL = 1,000,000,000 lamports
    // If balance > 1 million, assume it's in lamports
    if (balance > 1_000_000) {
      return balance / 1_000_000_000; // Convert lamports to SOL
    }

    return balance;
  }
}

// Export singleton instance
export const positionCalculator = new PositionCalculator();

