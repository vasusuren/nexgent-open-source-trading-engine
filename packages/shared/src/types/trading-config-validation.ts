/**
 * Trading Configuration Validation Schemas
 * 
 * Zod schemas for validating trading configuration at runtime.
 * Used by both backend (API validation) and frontend (form validation).
 */

import { z } from 'zod';
import { MINIMUM_POSITION_SIZE_SOL } from '../constants/trading-config-defaults.js';

/**
 * Trailing level validation schema
 * 
 * Note: stopLoss in trailing levels is always positive (gain-based).
 * Example: { change: 100, stopLoss: 60 } means:
 * - When price reaches +100% (2x purchase), set stop loss to +60% (1.6x purchase)
 * - This locks in 60% profit from purchase price
 */
export const trailingLevelSchema = z.object({
  change: z.number()
    .positive('Change must be positive')
    .describe('Price change % above purchase price (e.g., 200 = 200% = 2x)'),
  stopLoss: z.number()
    .positive('Stop loss must be positive (gain-based for trailing levels)')
    .max(1000, 'Stop loss cannot exceed 1000%')
    .describe('Stop loss % gain from purchase price (positive = gain-based, e.g., 60 = +60% from purchase)'),
});

/**
 * Stop loss configuration validation schema
 */
export const stopLossSchema = z.object({
  enabled: z.boolean(),
  defaultPercentage: z.number()
    .min(-100, 'Default percentage must be between -100 and 0 (negative = loss from purchase)')
    .max(0, 'Default percentage must be negative (loss-based)')
    .describe('Default stop loss % (negative = loss from purchase, e.g., -32 = sell at 68% of purchase = 32% loss)'),
  mode: z.enum(['fixed', 'exponential', 'zones', 'custom'], {
    errorMap: () => ({ message: 'Stop loss mode must be fixed, exponential, zones, or custom' }),
  }).default('fixed').describe('Stop loss calculation mode'),
  trailingLevels: z.array(trailingLevelSchema)
    .min(0, 'Trailing levels array cannot be empty if enabled'),
}).strip().superRefine((data, ctx) => {
  // For custom mode, validate trailing levels are sorted and not empty if enabled
  if (data.mode === 'custom') {
    if (data.enabled && data.trailingLevels.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Trailing levels cannot be empty when mode is custom and stop loss is enabled',
        path: ['trailingLevels'],
      });
    }
    
    // Check if sorted descending by change
    for (let i = 1; i < data.trailingLevels.length; i++) {
      if (data.trailingLevels[i].change >= data.trailingLevels[i - 1].change) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Trailing levels must be sorted descending by change (required for custom mode)',
          path: ['trailingLevels', i],
        });
      }
    }
  }
  // For non-custom modes, trailingLevels can be empty (will be generated algorithmically)
});

/**
 * Purchase limits validation schema
 */
export const purchaseLimitsSchema = z.object({
  minimumAgentBalance: z.number()
    .min(0.1, 'Minimum agent balance must be at least 0.1 SOL')
    .describe('Minimum SOL balance required for trading'),
  maxPurchasePerToken: z.number()
    .positive('Max purchase per token must be positive')
    .describe('Maximum SOL to use per token purchase'),
  maxPriceImpact: z.number()
    .min(0, 'Price impact must be between 0 and 1')
    .max(1, 'Price impact must be between 0 and 1')
    .describe('Maximum acceptable price impact percentage (0-1, e.g., 0.05 = 5%). Required.'),
});

/**
 * Position size range validation schema.
 * Enforces a hard floor of MINIMUM_POSITION_SIZE_SOL to prevent dust-sized trades.
 */
export const positionSizeRangeSchema = z.object({
  min: z.number()
    .min(MINIMUM_POSITION_SIZE_SOL, `Minimum purchase size is ${MINIMUM_POSITION_SIZE_SOL} SOL`),
  max: z.number()
    .min(MINIMUM_POSITION_SIZE_SOL, `Minimum purchase size is ${MINIMUM_POSITION_SIZE_SOL} SOL`),
}).refine(
  (data) => data.min <= data.max,
  { message: 'Max must be greater than or equal to min', path: ['max'] }
);

/**
 * Position sizes validation schema
 */
export const positionSizesSchema = z.object({
  small: positionSizeRangeSchema,
  medium: positionSizeRangeSchema,
  large: positionSizeRangeSchema,
});

/**
 * Position calculator validation schema
 */
export const positionCalculatorSchema = z.object({
  solBalanceThresholds: z.object({
    minimum: z.number().positive('Minimum threshold must be positive'),
    medium: z.number().positive('Medium threshold must be positive'),
    large: z.number().positive('Large threshold must be positive'),
  }).refine(
    (data) => data.minimum < data.medium,
    { message: 'Minimum threshold must be < medium threshold' }
  ).refine(
    (data) => data.medium < data.large,
    { message: 'Medium threshold must be < large threshold' }
  ),
  positionSizes: positionSizesSchema,
  randomization: z.object({
    enabled: z.boolean(),
  }),
});

/**
 * Stale trade auto-close validation schema
 */
export const staleTradeSchema = z.object({
  enabled: z.boolean()
    .describe('Whether stale trade auto-close is active'),
  minHoldTimeMinutes: z.number()
    .min(1, 'Minimum hold time must be at least 1 minute')
    .describe('Minimum time to hold position before stale trade check can trigger'),
  minProfitPercent: z.number()
    .describe('Minimum profit/loss percentage to trigger close (can be negative for losses)'),
  maxProfitPercent: z.number()
    .describe('Maximum profit/loss percentage to trigger close (can be negative for losses)'),
}).refine(
  (data) => data.minProfitPercent <= data.maxProfitPercent,
  {
    message: 'Minimum profit/loss must be less than or equal to maximum profit/loss',
    path: ['maxProfitPercent'],
  }
);

/**
 * DCA level validation schema
 */
export const dcaLevelSchema = z.object({
  dropPercent: z.number()
    .max(-1, 'Drop percent must be negative (at least -1%)')
    .min(-99, 'Drop percent cannot exceed -99%')
    .describe('Price drop percentage from average purchase price to trigger DCA'),
  buyPercent: z.number()
    .min(1, 'Buy percent must be at least 1%')
    .max(500, 'Buy percent cannot exceed 500%')
    .describe('Amount to buy as percentage of current position value'),
});

/**
 * Signal configuration validation schema
 */
const optionalPositiveNumber = z.number().positive().optional();
const optionalNonNegativeInt = z.number().int().min(0).optional();

export const signalConfigSchema = z.object({
  minScore: z.number()
    .int('Signal strength must be a whole number')
    .min(1, 'Minimum signal strength is 1')
    .max(5, 'Maximum signal strength is 5')
    .describe('Minimum signal strength score (1-5) required to trade'),
  minSignalScore: z.number()
    .min(0, 'Minimum signal score must be >= 0')
    .max(1, 'Minimum signal score must be <= 1')
    .optional()
    .describe('Minimum composite signal score [0,1]; undefined = no minimum'),
  allowedSignalTypes: z.array(z.string().min(1).max(50))
    .describe('Allowed signal types (empty = accept all)'),
  tokenFilterMode: z.enum(['none', 'blacklist', 'whitelist'], {
    errorMap: () => ({ message: 'Token filter mode must be none, blacklist, or whitelist' }),
  }).describe('Token filter mode'),
  tokenList: z.array(z.string().min(32, 'Token address too short').max(44, 'Token address too long'))
    .describe('List of token addresses for filtering'),
  marketCapMin: optionalPositiveNumber.describe('Minimum market cap (USD)'),
  marketCapMax: optionalPositiveNumber.describe('Maximum market cap (USD)'),
  liquidityMin: optionalPositiveNumber.describe('Minimum liquidity (USD)'),
  liquidityMax: optionalPositiveNumber.describe('Maximum liquidity (USD)'),
  holderCountMin: optionalNonNegativeInt.describe('Minimum holder count'),
  holderCountMax: optionalNonNegativeInt.describe('Maximum holder count'),
}).strip().superRefine((data, ctx) => {
  if (data.marketCapMin != null && data.marketCapMax != null && data.marketCapMin > data.marketCapMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Minimum market cap must be ≤ maximum', path: ['marketCapMax'] });
  }
  if (data.liquidityMin != null && data.liquidityMax != null && data.liquidityMin > data.liquidityMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Minimum liquidity must be ≤ maximum', path: ['liquidityMax'] });
  }
  if (data.holderCountMin != null && data.holderCountMax != null && data.holderCountMin > data.holderCountMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Minimum holder count must be ≤ maximum', path: ['holderCountMax'] });
  }
});

/**
 * DCA (Dollar Cost Averaging) configuration validation schema
 */
export const dcaSchema = z.object({
  enabled: z.boolean()
    .describe('Whether DCA is active'),
  mode: z.enum(['aggressive', 'moderate', 'conservative', 'custom'], {
    errorMap: () => ({ message: 'DCA mode must be aggressive, moderate, conservative, or custom' }),
  }).default('moderate').describe('DCA calculation mode'),
  levels: z.array(dcaLevelSchema)
    .describe('DCA levels (only used when mode is custom)'),
  maxDCACount: z.number()
    .min(1, 'Max DCA count must be at least 1')
    .max(10, 'Max DCA count cannot exceed 10')
    .describe('Maximum number of DCA buys per position'),
  cooldownSeconds: z.number()
    .min(10, 'Cooldown must be at least 10 seconds')
    .max(3600, 'Cooldown cannot exceed 1 hour')
    .describe('Minimum time between DCA buys in seconds'),
}).strip().superRefine((data, ctx) => {
  // For custom mode, validate levels are not empty and sorted
  if (data.mode === 'custom') {
    if (data.enabled && data.levels.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DCA levels cannot be empty when mode is custom and DCA is enabled',
        path: ['levels'],
      });
    }
    
    // Check levels are sorted by dropPercent (least negative first); equal values allowed
    for (let i = 1; i < data.levels.length; i++) {
      if (data.levels[i].dropPercent > data.levels[i - 1].dropPercent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DCA levels must be sorted by dropPercent (least negative first; e.g. -20 before -30)',
          path: ['levels', i],
        });
      }
    }
  }
  // For non-custom modes, levels can be empty (will be generated from template)
});

/**
 * Take-profit level validation schema
 */
export const takeProfitLevelSchema = z.object({
  targetPercent: z.number()
    .min(1, 'Target percent must be at least 1%')
    .max(10000, 'Target percent cannot exceed 10000%')
    .describe('Percentage gain from entry price to trigger this level'),
  sellPercent: z.number()
    .min(1, 'Sell percent must be at least 1%')
    .max(100, 'Sell percent cannot exceed 100%')
    .describe('Percentage of ORIGINAL position to sell at this level'),
});

/**
 * Moon bag configuration validation schema
 */
export const moonBagConfigSchema = z.object({
  enabled: z.boolean()
    .describe('Whether moon bag feature is enabled'),
  triggerPercent: z.number()
    .min(1, 'Trigger percent must be at least 1%')
    .max(10000, 'Trigger percent cannot exceed 10000%')
    .describe('Percentage gain threshold to activate moon bag'),
  retainPercent: z.number()
    .min(1, 'Retain percent must be at least 1%')
    .max(50, 'Retain percent cannot exceed 50%')
    .describe('Percentage of ORIGINAL position to retain as moon bag'),
});

/**
 * Take-profit configuration validation schema
 * 
 * Validates:
 * - Mode is valid (aggressive, moderate, conservative, custom)
 * - Levels array has 1-10 entries (only validated in custom mode)
 * - Total sell % + moon bag retain % <= 100% (only in custom mode)
 * - Levels are sorted by targetPercent ascending (only in custom mode)
 */
export const takeProfitConfigSchema = z.object({
  enabled: z.boolean()
    .describe('Whether take-profit is active'),
  mode: z.enum(['aggressive', 'moderate', 'conservative', 'custom'], {
    errorMap: () => ({ message: 'Take-profit mode must be aggressive, moderate, conservative, or custom' }),
  }).default('moderate').describe('Take-profit calculation mode'),
  levels: z.array(takeProfitLevelSchema)
    .max(10, 'Cannot have more than 10 take-profit levels')
    .describe('Take-profit levels (used only in custom mode)'),
  moonBag: moonBagConfigSchema
    .describe('Moon bag configuration'),
}).strip().superRefine((data, ctx) => {
  // Only validate levels in custom mode
  if (data.mode === 'custom') {
    // Validate at least one level in custom mode
    if (data.levels.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one take-profit level is required in custom mode',
        path: ['levels'],
      });
      return;
    }

    // Validate total sell % + moon bag % <= 100%
    const totalSellPercent = data.levels.reduce((sum, level) => sum + level.sellPercent, 0);
    const moonBagPercent = data.moonBag.enabled ? data.moonBag.retainPercent : 0;
    const totalAllocation = totalSellPercent + moonBagPercent;
    
    if (totalAllocation > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total allocation (${totalAllocation}%) exceeds 100%. Sell levels total ${totalSellPercent}% + moon bag ${moonBagPercent}% = ${totalAllocation}%`,
        path: ['levels'],
      });
    }
    
    // Validate levels are sorted by targetPercent ascending
    for (let i = 1; i < data.levels.length; i++) {
      if (data.levels[i].targetPercent <= data.levels[i - 1].targetPercent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Take-profit levels must be sorted by targetPercent ascending (each level higher than the previous)',
          path: ['levels', i],
        });
      }
    }
    
    // Validate moon bag trigger is before or at the final level
    if (data.moonBag.enabled && data.levels.length > 0) {
      const finalLevelTarget = data.levels[data.levels.length - 1].targetPercent;
      if (data.moonBag.triggerPercent > finalLevelTarget) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Moon bag trigger (${data.moonBag.triggerPercent}%) must be at or before the final take-profit level (${finalLevelTarget}%)`,
          path: ['moonBag', 'triggerPercent'],
        });
      }
    }
  }
});

/**
 * Auto-trade (whitelist) validation schema
 * Only tokens in `tokens` with `enabled: true` are re-bought when a position closes.
 */
export const autoTradeTokenSchema = z.object({
  address: z.string().min(32, 'Token address too short').max(44, 'Token address too long'),
  symbol: z.string().min(1).max(20).optional(),
  logoUrl: z.string().url('Invalid token image URL').optional(),
  enabled: z.boolean().default(false),
  marketCapMin: optionalPositiveNumber.describe('Per-token auto-trade minimum market cap (USD)'),
  marketCapMax: optionalPositiveNumber.describe('Per-token auto-trade maximum market cap (USD)'),
}).strip().superRefine((data, ctx) => {
  if (data.marketCapMin != null && data.marketCapMax != null && data.marketCapMin > data.marketCapMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Auto-trade minimum market cap must be ≤ maximum',
      path: ['marketCapMax'],
    });
  }
});

export const autoTradeSchema = z.object({
  enabled: z.boolean().describe('Whether auto-trade is on for this agent'),
  tokens: z
    .array(autoTradeTokenSchema)
    .max(100, 'Maximum 100 tokens in auto-trade list')
    .default([])
    .describe('Token mint addresses with per-token enabled state and optional market-cap bounds'),
}).strip().superRefine((data, ctx) => {
  const seen = new Set<string>();
  data.tokens.forEach((token, index) => {
    const key = token.address.trim().toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Duplicate token address in auto-trade list',
        path: ['tokens', index, 'address'],
      });
      return;
    }
    seen.add(key);
  });
});

/**
 * Portfolio management configuration validation schema
 */
export const portfolioConfigSchema = z.object({
  replacementMargin: z.number()
    .min(0, 'Replacement margin must be >= 0')
    .max(1, 'Replacement margin must be <= 1')
    .default(0.10),
  requireScoreForReplacement: z.boolean().default(true),
  positionDecayHours: z.number()
    .min(0.5, 'Position decay hours must be >= 0.5')
    .max(24, 'Position decay hours must be <= 24')
    .default(4),
}).strip();

/**
 * Complete agent trading configuration validation schema
 *
 * Uses .strip() to automatically remove unknown fields (like old continuousTrailing).
 * DCA and Take-Profit can both be enabled (append-levels model).
 */
export const agentTradingConfigSchema = z.object({
  purchaseLimits: purchaseLimitsSchema,
  signals: signalConfigSchema,
  stopLoss: stopLossSchema,
  positionCalculator: positionCalculatorSchema,
  staleTrade: staleTradeSchema,
  dca: dcaSchema,
  takeProfit: takeProfitConfigSchema,
  autoTrade: autoTradeSchema.optional(),
  portfolio: portfolioConfigSchema.optional(),
}).strip();

/**
 * Type inference from schema
 */
export type AgentTradingConfigSchema = z.infer<typeof agentTradingConfigSchema>;

/**
 * Validate trading configuration with custom business logic
 * 
 * This function performs additional validation beyond Zod schema validation,
 * such as checking that position sizes increase with balance thresholds.
 */
export function validateTradingConfigBusinessLogic(
  config: z.infer<typeof agentTradingConfigSchema>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check that position sizes increase with balance thresholds
  const { positionCalculator } = config;
  const { small, medium, large } = positionCalculator.positionSizes;

  // Small max should generally be <= medium min (but allow flexibility)
  // Medium max should generally be <= large min (but allow flexibility)
  // Just log warnings, not errors

  // If stop loss is enabled and mode is custom, ensure trailing levels exist
  if (config.stopLoss.enabled && config.stopLoss.mode === 'custom' && config.stopLoss.trailingLevels.length === 0) {
    errors.push('Trailing levels cannot be empty when stop loss is enabled in custom mode');
  }

  // Validate that stopLoss values in trailing levels are reasonable
  // (stopLoss should generally be < change, but allow flexibility)
  for (const level of config.stopLoss.trailingLevels) {
    if (level.stopLoss > level.change) {
      // This is unusual but not necessarily wrong - just a warning
      // We'll log it in application logic
    }
  }

  // If DCA is enabled and mode is custom, ensure levels exist
  if (config.dca?.enabled && config.dca.mode === 'custom' && config.dca.levels.length === 0) {
    errors.push('DCA levels cannot be empty when DCA is enabled in custom mode');
  }

  // Validate DCA levels are reasonable
  if (config.dca?.levels) {
    for (const level of config.dca.levels) {
      // Ensure drop percent is more negative than -99% (position would be nearly worthless)
      if (level.dropPercent < -99) {
        errors.push(`DCA level dropPercent ${level.dropPercent}% is too extreme`);
      }
    }
  }

  // Validate take-profit total allocation (only in custom mode)
  // For preset modes (aggressive, moderate, conservative), templates are pre-validated
  if (config.takeProfit?.enabled && config.takeProfit.mode === 'custom') {
    const totalSellPercent = config.takeProfit.levels.reduce((sum, level) => sum + level.sellPercent, 0);
    const moonBagPercent = config.takeProfit.moonBag.enabled ? config.takeProfit.moonBag.retainPercent : 0;
    const totalAllocation = totalSellPercent + moonBagPercent;
    
    if (totalAllocation > 100) {
      errors.push(`Take-profit total allocation (${totalAllocation}%) exceeds 100%`);
    }
    
    // Warn if total allocation is significantly less than 100%
    if (totalAllocation < 90) {
      // This is a warning, not an error - some positions may be left unsold intentionally
      // Could add a warnings array if needed
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Helper function to calculate total take-profit allocation
 * Returns the sum of all sell percentages plus moon bag retain percentage
 */
export function calculateTakeProfitAllocation(config: {
  levels: Array<{ sellPercent: number }>;
  moonBag: { enabled: boolean; retainPercent: number };
}): { totalSellPercent: number; moonBagPercent: number; totalAllocation: number } {
  const totalSellPercent = config.levels.reduce((sum, level) => sum + level.sellPercent, 0);
  const moonBagPercent = config.moonBag.enabled ? config.moonBag.retainPercent : 0;
  return {
    totalSellPercent,
    moonBagPercent,
    totalAllocation: totalSellPercent + moonBagPercent,
  };
}

// Note: normalizeTakeProfitLevels is exported from utils/take-profit-calculator.ts

