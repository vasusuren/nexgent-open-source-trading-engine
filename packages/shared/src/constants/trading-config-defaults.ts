/**
 * Trading Configuration Defaults
 * 
 * Default configuration values for agent trading settings.
 * These defaults are applied when an agent is created or when
 * configuration is reset.
 */

import type { AgentTradingConfig, AutoTradeConfig, DCAConfig, PortfolioConfig, SignalConfig, TakeProfitConfig } from '../types/trading-config.js';

/** Hard minimum position size in SOL — prevents dust-sized trades. */
export const MINIMUM_POSITION_SIZE_SOL = 0.05;

/** Maximum open positions per agent — shared constant to prevent duplication. */
export const MAX_OPEN_POSITIONS = 25;

/**
 * Common signal types for dropdown selection
 * These are predefined options available in the UI
 */
export const COMMON_SIGNAL_TYPES = [
  'Velocity (Dormant Explosion)',
  'Velocity (Dex Boost Detection)',
  'Velocity (Hyper Surge Detection)',
  'Velocity (Price Reversal Detection)',
  'Velocity (Breakout Confirmation)',
  'Ignition Beta (Microcap Revival)',
  'Ignition Beta (ML Graduation)',
] as const;

/**
 * Default signal configuration
 * 
 * By default, accepts all signal types and all tokens.
 */
export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  minScore: 1,                    // Require signal strength >= 1 (accept all)
  allowedSignalTypes: [],         // Empty = accept all signal types
  tokenFilterMode: 'none',        // Accept all tokens
  tokenList: [],                  // Empty token list
  // Token metrics (Jupiter): all undefined = no filter
  marketCapMin: undefined,
  marketCapMax: undefined,
  liquidityMin: undefined,
  liquidityMax: undefined,
  holderCountMin: undefined,
  holderCountMax: undefined,
};

/**
 * Default DCA configuration
 * 
 * DCA is disabled by default (opt-in feature).
 * Uses moderate mode template when enabled.
 */
export const DEFAULT_DCA_CONFIG: DCAConfig = {
  enabled: false,          // Disabled by default (opt-in feature)
  mode: 'moderate',        // Moderate template as default when enabled
  levels: [],              // Empty - moderate mode generates levels from template
  maxDCACount: 3,          // Maximum 3 DCAs per position
  cooldownSeconds: 30,     // 30 second cooldown between DCAs
};

/**
 * Default take-profit configuration
 * 
 * Take-profit is disabled by default (opt-in feature).
 * Default levels: 50%, 150%, 300%, 400% gains (moderate mode)
 * Each level sells a percentage of the ORIGINAL position.
 * Total allocation: 90% (sell) + 10% (moon bag) = 100%
 * 
 * DCA and Take-Profit can both be enabled (append-levels model).
 */
export const DEFAULT_TAKE_PROFIT_CONFIG: TakeProfitConfig = {
  enabled: false,          // Disabled by default (opt-in feature)
  mode: 'moderate',        // Moderate template as default when enabled
  levels: [
    { targetPercent: 50, sellPercent: 25 },   // At +50% gain, sell 25%
    { targetPercent: 150, sellPercent: 25 },  // At +150% gain, sell 25%
    { targetPercent: 300, sellPercent: 25 },  // At +300% gain, sell 25%
    { targetPercent: 400, sellPercent: 15 },  // At +400% gain, sell 15% (reduced for moon bag)
  ],
  // Total sell: 90%
  moonBag: {
    enabled: true,
    triggerPercent: 300,   // Activate at 300% gain (before final 400% level)
    retainPercent: 10,     // Keep 10% of original position as moon bag
  },
  // Total: 90% + 10% = 100% ✓
};

/**
 * Default auto-trade configuration
 *
 * When enabled, only tokens in tokens[] with enabled=true are re-purchased
 * after position close.
 */
export const DEFAULT_AUTO_TRADE_CONFIG: AutoTradeConfig = {
  enabled: false,
  tokens: [],
};

/**
 * Default portfolio management configuration
 *
 * Legacy positions (null signalScore) are treated as maximum value until
 * requireScoreForReplacement is flipped to false.
 */
export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  replacementMargin: 0.10,
  requireScoreForReplacement: true,
  positionDecayHours: 4,
};

/**
 * Default trading configuration
 * 
 * Based on production values from the original hardcoded configuration.
 */
export const DEFAULT_TRADING_CONFIG: AgentTradingConfig = {
  purchaseLimits: {
    minimumAgentBalance: 0.5,
    maxPurchasePerToken: 2.0,
    maxPriceImpact: 0.05, // 5% max slippage
  },
  signals: DEFAULT_SIGNAL_CONFIG,
  stopLoss: {
    enabled: true,
    defaultPercentage: -32, // Negative: 32% loss from purchase price
    mode: 'fixed', // Fixed stepper mode (10% increments) - default for all new agents
    trailingLevels: [], // Empty - fixed mode doesn't use trailingLevels
  },
  positionCalculator: {
    solBalanceThresholds: {
      minimum: 0.2,      // Minimum SOL balance required
      medium: 5,         // Threshold for medium position size
      large: 10,         // Threshold for large position size
    },
    positionSizes: {
      small: {
        min: 0.1,      // Minimum position size for small balances
        max: 0.1,      // Maximum position size for small balances
      },
      medium: {
        min: 0.5,      // Minimum position size for medium balances
        max: 1.0,      // Maximum position size for medium balances
      },
      large: {
        min: 1.5,      // Minimum position size for large balances
        max: 2.0,      // Maximum position size for large balances
      },
    },
    randomization: {
      enabled: true,
    },
  },
  staleTrade: {
    enabled: true,           // Enabled by default
    minHoldTimeMinutes: 60,  // 1 hour minimum hold time
    minProfitPercent: 1,     // Close if profit >= 1%
    maxProfitPercent: 10,    // Close if profit <= 10%
  },
  dca: DEFAULT_DCA_CONFIG,
  takeProfit: DEFAULT_TAKE_PROFIT_CONFIG,
  autoTrade: DEFAULT_AUTO_TRADE_CONFIG,
  portfolio: DEFAULT_PORTFOLIO_CONFIG,
};

