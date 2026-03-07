/**
 * Test Data Factories
 * 
 * Provides factory functions for creating test data objects.
 */

import { randomUUID } from 'crypto';
import type { AgentTradingConfig, DCAConfig, DCALevel, TakeProfitConfig } from '@nexgent/shared';
import type { OpenPosition } from '@nexgent/shared';
import type { TradingSignal } from '@prisma/client';

/** Default user ID for mock signals (agent eligibility scopes by userId). */
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Create a mock trading signal.
 * Includes userId by default so eligibility logic (which scopes by signal creator) runs in unit tests.
 */
export function createMockSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: Math.floor(Math.random() * 1000000),
    tokenAddress: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    signalType: 'BUY',
    activationReason: 'test',
    signalStrength: 5,
    source: 'test',
    userId: TEST_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TradingSignal;
}

/**
 * Create a mock agent trading config
 */
export function createMockConfig(overrides: Partial<AgentTradingConfig> = {}): AgentTradingConfig {
  return {
    signals: {
      minScore: 1,
      allowedSignalTypes: [],
      tokenFilterMode: 'none' as const,
      tokenList: [],
    },
    positionCalculator: {
      solBalanceThresholds: {
        minimum: 0.1,
        medium: 1,
        large: 10,
      },
      positionSizes: {
        small: { min: 0.1, max: 0.5 },
        medium: { min: 0.5, max: 2 },
        large: { min: 2, max: 10 },
      },
      randomization: {
        enabled: false,
      },
    },
    purchaseLimits: {
      maxPurchasePerToken: 5,
      minimumAgentBalance: 0.1,
    },
    stopLoss: {
      enabled: true,
      defaultPercentage: -32,
      mode: 'custom' as const,
      trailingLevels: [
        { change: 50, stopLoss: 90 },
        { change: 100, stopLoss: 95 },
        { change: 200, stopLoss: 98 },
      ],
    },
    dca: {
      enabled: false,
      mode: 'moderate' as const,
      levels: [],
      maxDCACount: 3,
      cooldownSeconds: 30,
    },
    takeProfit: {
      enabled: false,
      mode: 'moderate' as const,
      levels: [
        { targetPercent: 50, sellPercent: 25 },
        { targetPercent: 150, sellPercent: 25 },
        { targetPercent: 300, sellPercent: 25 },
        { targetPercent: 400, sellPercent: 15 },
      ],
      moonBag: {
        enabled: true,
        triggerPercent: 300,
        retainPercent: 10,
      },
    },
    staleTrade: {
      enabled: true,
      minHoldTimeMinutes: 60,
      minProfitPercent: 1,
      maxProfitPercent: 10,
    },
    ...overrides,
  } as AgentTradingConfig;
}

/**
 * Create a mock agent ID
 */
export function createMockAgentId(): string {
  return randomUUID();
}

/**
 * Create a mock wallet address (Solana format)
 * Returns a valid Base58-encoded address for testing
 */
export function createMockWalletAddress(): string {
  // Generate a test wallet address in Solana format (Base58, 32-44 chars)
  // For tests, we use a simple pattern that's valid Base58
  const randomPart = randomUUID().replace(/-/g, '').substring(0, 32);
  // Pad to ensure it's at least 32 chars, max 44
  return `test-wallet-${randomPart}`.substring(0, 44);
}

/**
 * Create a mock open position
 */
export function createMockPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    id: randomUUID(),
    agentId: randomUUID(),
    walletAddress: createMockWalletAddress(),
    tokenAddress: 'So11111111111111111111111111111111111111112',
    tokenSymbol: 'SOL',
    purchaseTransactionId: randomUUID(),
    purchasePrice: 100,
    purchaseAmount: 1,
    totalInvestedSol: 100, // purchasePrice * purchaseAmount
    dcaCount: 0,
    lastDcaTime: null,
    lowestPrice: null,
    dcaTransactionIds: [],
    currentStopLossPercentage: -32,
    peakPrice: 100,
    lastStopLossUpdate: new Date(),
    // Take-profit fields
    remainingAmount: null, // null = full purchaseAmount
    takeProfitLevelsHit: 0,
    takeProfitTransactionIds: [],
    lastTakeProfitTime: null,
    moonBagActivated: false,
    moonBagAmount: null,
    realizedProfitSol: 0,
    tpBatchStartLevel: 0,
    totalTakeProfitLevels: null,
    signalScore: null,
    expectedMovePct: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a mock DCA config
 */
export function createMockDCAConfig(overrides: Partial<DCAConfig> = {}): DCAConfig {
  return {
    enabled: true,
    mode: 'moderate' as const,
    levels: [],
    maxDCACount: 3,
    cooldownSeconds: 30,
    ...overrides,
  };
}

/**
 * Create a mock DCA level
 */
export function createMockDCALevel(overrides: Partial<DCALevel> = {}): DCALevel {
  return {
    dropPercent: -15,
    buyPercent: 50,
    ...overrides,
  };
}

/**
 * Create a mock take-profit config
 */
export function createMockTakeProfitConfig(overrides: Partial<TakeProfitConfig> = {}): TakeProfitConfig {
  return {
    enabled: true,
    mode: 'custom' as const,
    levels: [
      { targetPercent: 50, sellPercent: 25 },
      { targetPercent: 150, sellPercent: 25 },
      { targetPercent: 300, sellPercent: 25 },
      { targetPercent: 400, sellPercent: 15 },
    ],
    moonBag: {
      enabled: true,
      triggerPercent: 300,
      retainPercent: 10,
    },
    ...overrides,
  };
}

/**
 * Create a mock position with DCA state
 * Convenience function for DCA-related tests
 */
export function createMockPositionWithDCA(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return createMockPosition({
    // Use smaller values more typical for token positions
    purchasePrice: 0.001, // SOL per token
    purchaseAmount: 1000, // tokens
    totalInvestedSol: 1.0, // 1000 * 0.001 = 1 SOL
    dcaCount: 0,
    lastDcaTime: null,
    lowestPrice: 0.001,
    dcaTransactionIds: [],
    ...overrides,
  });
}

/**
 * Stale trade configuration interface (matches the shared type)
 */
export interface StaleTradeConfig {
  enabled: boolean;
  minHoldTimeMinutes: number;
  minProfitPercent: number;
  maxProfitPercent: number;
}

/**
 * Create a mock stale trade config
 */
export function createMockStaleTradeConfig(overrides: Partial<StaleTradeConfig> = {}): StaleTradeConfig {
  return {
    enabled: true,
    minHoldTimeMinutes: 60,
    minProfitPercent: 1,
    maxProfitPercent: 10,
    ...overrides,
  };
}

/**
 * Create a mock position for stale trade testing
 * Convenience function that creates an "old" position
 */
export function createMockPositionForStaleTrade(overrides: Partial<OpenPosition> = {}): OpenPosition {
  // Default to a position created 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  
  return createMockPosition({
    purchasePrice: 1.0, // 1 SOL per token
    purchaseAmount: 1.0,
    totalInvestedSol: 1.0,
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo,
    ...overrides,
  });
}

