/**
 * Trading Configuration Types
 * 
 * TypeScript interfaces for agent trading configuration.
 * These types are shared between backend and frontend.
 */

/**
 * Trailing stop loss level
 * Defines a discrete stop loss level based on price change
 */
export interface TrailingLevel {
  /**
   * Price change percentage above purchase price
   * Example: 200 = 200% = 2x purchase price
   */
  change: number;
  
  /**
   * Stop loss percentage to set at this level
   * Example: 90 = keep 90% of peak value = 10% loss from peak
   */
  stopLoss: number;
}

/**
 * Stop loss calculation mode
 * - 'fixed': Fixed stepper with 10% increments
 * - 'exponential': Exponential decay curve (loose at low levels, tight at high)
 * - 'zones': Step-based volatility zones with different keep percentages
 * - 'custom': Manual discrete levels (existing system)
 */
export type StopLossMode = 'fixed' | 'exponential' | 'zones' | 'custom';

/**
 * Stop loss configuration
 */
export interface StopLossConfig {
  /** Whether stop loss is active */
  enabled: boolean;
  
  /**
   * Default stop loss % if no trailing level matches (before any price increase)
   * Negative value indicates loss from purchase price (e.g., -32 = 32% loss)
   * Positive value indicates percentage of peak to keep (used in trailing levels)
   */
  defaultPercentage: number;
  
  /**
   * Stop loss calculation mode
   * - 'fixed': Linear 10% steps (stopLoss = change - 10)
   * - 'exponential': Exponential decay (loose → tight curve)
   * - 'zones': 5-zone system with different keep percentages
   * - 'custom': Manual discrete levels (trailingLevels array)
   */
  mode: StopLossMode;
  
  /**
   * Discrete trailing levels (only used when mode === 'custom')
   * For other modes, levels are generated algorithmically
   * Must be sorted descending by change when mode === 'custom'
   */
  trailingLevels: TrailingLevel[];
}

/**
 * Purchase limits configuration
 */
export interface PurchaseLimits {
  /** Minimum SOL balance required for trading */
  minimumAgentBalance: number;
  
  /** Maximum SOL to use per token purchase */
  maxPurchasePerToken: number;
  
  /** Maximum acceptable price impact percentage (0-1, e.g., 0.05 = 5%) */
  maxPriceImpact?: number;
}

/**
 * Position size configuration for a balance category
 */
export interface PositionSizeRange {
  /** Minimum position size */
  min: number;
  
  /** Maximum position size */
  max: number;
}

/**
 * Position sizes configuration by balance category
 */
export interface PositionSizes {
  /** Position sizes for small balances */
  small: PositionSizeRange;
  
  /** Position sizes for medium balances */
  medium: PositionSizeRange;
  
  /** Position sizes for large balances */
  large: PositionSizeRange;
}

/**
 * Position calculator configuration
 */
export interface PositionCalculator {
  /** SOL balance thresholds for categorizing position sizes */
  solBalanceThresholds: {
    /** Minimum SOL balance */
    minimum: number;
    
    /** Threshold for medium position size */
    medium: number;
    
    /** Threshold for large position size */
    large: number;
  };
  
  /** Position size ranges by category */
  positionSizes: PositionSizes;
  
  /** Position size randomization configuration */
  randomization: {
    /** Whether to randomize position size within min/max range */
    enabled: boolean;
  };
}

/**
 * Token filter mode for signal filtering
 * - 'none': Accept signals for any token (default)
 * - 'blacklist': Accept all tokens EXCEPT those in the list
 * - 'whitelist': ONLY accept tokens in the list
 */
export type TokenFilterMode = 'none' | 'blacklist' | 'whitelist';

/**
 * Signal configuration
 */
export interface SignalConfig {
  /** Minimum signal strength score (1-5) required to trade */
  minScore: number;

  /**
   * Minimum composite signal score [0,1] required to trade.
   * Fine-grained gate alongside minScore. Undefined = no minimum.
   */
  minSignalScore?: number;

  /**
   * Minimum expected move percentage required to trade.
   * Signals with expectedMovePct below this threshold are filtered out.
   * 0 or undefined = no minimum (backward compatible).
   */
  minExpectedMove?: number;
  
  /** 
   * Allowed signal types (e.g., ['buy', 'Hypersurge'])
   * Empty array = accept all signal types
   */
  allowedSignalTypes: string[];
  
  /** 
   * Token filter mode
   * - 'none': Accept all tokens
   * - 'blacklist': Block tokens in the list
   * - 'whitelist': Only allow tokens in the list
   */
  tokenFilterMode: TokenFilterMode;
  
  /** List of token addresses for filtering (used by blacklist/whitelist mode) */
  tokenList: string[];

  /**
   * Token metrics bounds (from Jupiter Tokens API v2). Optional; omit or leave undefined = no bound.
   * Applied as a signal pre-check: token must satisfy all set bounds to be eligible.
   */
  /** Minimum market cap (USD); undefined = no minimum */
  marketCapMin?: number;
  /** Maximum market cap (USD); undefined = no maximum */
  marketCapMax?: number;
  /** Minimum liquidity (USD); undefined = no minimum */
  liquidityMin?: number;
  /** Maximum liquidity (USD); undefined = no maximum */
  liquidityMax?: number;
  /** Minimum holder count; undefined = no minimum */
  holderCountMin?: number;
  /** Maximum holder count; undefined = no maximum */
  holderCountMax?: number;
}

/**
 * Stale trade auto-close configuration
 * 
 * Automatically closes positions after a minimum hold time if profit/loss is within a target range.
 * Targets "stale" trades that have modest gains (or small losses) but aren't moving significantly,
 * freeing up capital for new opportunities.
 * 
 * Profit/loss percentages can be negative to allow closing losing positions (e.g., -5% to -1%).
 */
export interface StaleTradeConfig {
  /** Whether stale trade auto-close is active */
  enabled: boolean;
  
  /** Minimum time to hold position before stale trade check can trigger (in minutes) */
  minHoldTimeMinutes: number;
  
  /** Minimum profit/loss percentage to trigger close (e.g., 1 = 1%, -5 = -5% for losses) */
  minProfitPercent: number;
  
  /** Maximum profit/loss percentage to trigger close (e.g., 10 = 10%, -1 = -1% for losses) */
  maxProfitPercent: number;
}

/**
 * DCA (Dollar Cost Averaging) level configuration
 * Defines when to DCA and how much to buy
 */
export interface DCALevel {
  /**
   * Price drop percentage from average purchase price to trigger DCA
   * Negative value (e.g., -15 = 15% drop from average)
   */
  dropPercent: number;
  
  /**
   * Amount to buy as percentage of current position value
   * e.g., 50 = buy 50% more (if position is 1 SOL, buy 0.5 SOL more)
   */
  buyPercent: number;
}

/**
 * DCA calculation mode
 * - 'aggressive': Tighter levels, more DCAs (e.g., -10%, -20%, -30%, -40%)
 * - 'moderate': Standard levels (e.g., -15%, -30%, -45%)
 * - 'conservative': Wider levels, fewer DCAs (e.g., -20%, -40%)
 * - 'custom': Manual discrete levels (user-defined)
 */
export type DCAMode = 'aggressive' | 'moderate' | 'conservative' | 'custom';

/**
 * DCA (Dollar Cost Averaging) configuration
 * 
 * Automatically buys more of a token when price drops to configured levels.
 * This is the inverse of stop loss — instead of selling on drops, buy more
 * to lower average cost basis.
 * 
 * DCA can run concurrently with Take-Profit. When both are enabled,
 * DCA buys are based on the remaining position size after partial TP sales.
 */
export interface DCAConfig {
  /** Whether DCA is active */
  enabled: boolean;
  
  /**
   * DCA calculation mode
   * - 'aggressive': Tighter levels, more frequent DCAs
   * - 'moderate': Balanced approach (default)
   * - 'conservative': Wider levels, fewer DCAs
   * - 'custom': Manual discrete levels
   */
  mode: DCAMode;
  
  /**
   * Discrete DCA levels (only used when mode === 'custom')
   * For other modes, levels are generated from templates
   * Must be sorted ascending by dropPercent (most negative first)
   */
  levels: DCALevel[];
  
  /**
   * Maximum number of DCA buys per position
   * Prevents unlimited buying into a falling knife
   */
  maxDCACount: number;
  
  /**
   * Minimum time between DCA buys in seconds
   * Prevents rapid-fire DCAs during volatile price swings
   * Default: 30 seconds
   */
  cooldownSeconds: number;
}

/**
 * Take-profit calculation mode
 * - 'aggressive': Lower targets, more frequent profit-taking (e.g., 25%, 50%, 100%, 150%)
 * - 'moderate': Standard targets (e.g., 50%, 150%, 300%, 400%) - default
 * - 'conservative': Higher targets, fewer sales (e.g., 100%, 200%, 400%, 600%)
 * - 'custom': Manual discrete levels (user-defined)
 */
export type TakeProfitMode = 'aggressive' | 'moderate' | 'conservative' | 'custom';

/**
 * Take-profit level configuration
 * Defines when to take profit and how much to sell
 */
export interface TakeProfitLevel {
  /**
   * Percentage gain from entry price to trigger this level
   * Example: 50 = 50% gain from purchase price
   */
  targetPercent: number;
  
  /**
   * Percentage of ORIGINAL position to sell at this level
   * Example: 25 = sell 25% of the original position amount
   * Note: This is always calculated from the original position, not remaining
   */
  sellPercent: number;
}

/**
 * Moon bag configuration
 * 
 * A moon bag is a small portion of the position retained indefinitely
 * to capture potential massive gains ("to the moon").
 */
export interface MoonBagConfig {
  /** Whether moon bag feature is enabled */
  enabled: boolean;
  
  /**
   * Percentage gain threshold to activate moon bag
   * Example: 300 = activate at 300% gain (4x purchase price)
   * Moon bag is set aside BEFORE the final take-profit level executes
   */
  triggerPercent: number;
  
  /**
   * Percentage of ORIGINAL position to retain as moon bag
   * Example: 10 = keep 10% of original position
   */
  retainPercent: number;
}

/**
 * Take-profit configuration
 * 
 * Automatically sells portions of a position as price increases.
 * Each level defines a price target and the percentage to sell.
 * All percentages are calculated from the ORIGINAL position amount.
 * 
 * Take-Profit can run concurrently with DCA. When both are enabled,
 * DCA appends fresh TP levels after each buy (append-levels model).
 */
export interface TakeProfitConfig {
  /** Whether take-profit is active */
  enabled: boolean;
  
  /**
   * Take-profit calculation mode
   * - 'aggressive': Lower targets, more frequent profit-taking
   * - 'moderate': Standard targets (default)
   * - 'conservative': Higher targets, fewer sales
   * - 'custom': Manual discrete levels
   */
  mode: TakeProfitMode;
  
  /**
   * Take-profit levels (only used when mode === 'custom')
   * For other modes, levels are generated from templates
   * Should be sorted by targetPercent ascending
   * Each level's sellPercent is calculated from the ORIGINAL position
   */
  levels: TakeProfitLevel[];
  
  /** Moon bag configuration */
  moonBag: MoonBagConfig;
}

/**
 * Auto trade (immediate re-entry) configuration
 *
 * When enabled, only tokens listed in `tokens` with `enabled: true` are
 * auto-traded: when a position in one of those tokens closes, it is
 * re-purchased immediately using the agent's standard position size.
 */
export interface AutoTradeTokenConfig {
  /** Token mint address to track for auto-trade re-entry */
  address: string;
  /** Optional token symbol for UI display (resolved from data providers like DexScreener) */
  symbol?: string;
  /** Optional token image URL (resolved from DexScreener pair info) */
  logoUrl?: string;
  /** Per-token on/off control in the UI */
  enabled: boolean;
  /**
   * Minimum market cap (USD) required for auto-trade actions on this token.
   * Undefined means no lower bound.
   */
  marketCapMin?: number;
  /**
   * Maximum market cap (USD) allowed for auto-trade actions on this token.
   * Undefined means no upper bound.
   */
  marketCapMax?: number;
}

/**
 * Auto trade configuration for an agent.
 */
export interface AutoTradeConfig {
  /** Whether auto-trade is on for this agent */
  enabled: boolean;
  /** Token list with per-token enable state and optional market-cap bounds */
  tokens: AutoTradeTokenConfig[];
}

/**
 * Portfolio management configuration
 */
export interface PortfolioConfig {
  /**
   * Margin by which incoming signal score must exceed the weakest position's
   * remaining value before replacement is triggered. Default 0.10.
   */
  replacementMargin: number;

  /**
   * When true, positions with null signalScore are treated as maximum value
   * (rv = 1.0) and are never candidates for replacement.
   * Flip to false once all positions carry a score. Default true.
   */
  requireScoreForReplacement: boolean;

  /**
   * Hours after which a position's time factor decays to zero.
   * Shorter = faster turnover. Default 4 (suits meme coin move windows).
   */
  positionDecayHours: number;
}

/**
 * Complete agent trading configuration
 */
export interface AgentTradingConfig {
  /** Purchase limits */
  purchaseLimits: PurchaseLimits;

  /** Signal configuration */
  signals: SignalConfig;

  /** Stop loss configuration */
  stopLoss: StopLossConfig;

  /** Position sizing configuration */
  positionCalculator: PositionCalculator;

  /** Stale trade auto-close configuration */
  staleTrade: StaleTradeConfig;

  /** DCA (Dollar Cost Averaging) configuration */
  dca: DCAConfig;

  /** Take-profit configuration */
  takeProfit: TakeProfitConfig;

  /** Auto trade: immediately re-buy when an enabled token position closes */
  autoTrade?: AutoTradeConfig;

  /** Portfolio management: capital-aware entry decisions and replacement logic */
  portfolio?: PortfolioConfig;
}

