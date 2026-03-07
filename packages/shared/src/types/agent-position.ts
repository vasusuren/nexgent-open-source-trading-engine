/**
 * Agent Position Types
 * 
 * TypeScript interfaces for tracking open positions with stop loss, DCA, and take-profit.
 * These types are shared between backend and frontend.
 */

/**
 * Open position with stop loss, DCA, and take-profit tracking
 * Represents an active position in a token with dynamic stop loss state, DCA history, and take-profit progress
 */
export interface OpenPosition {
  /** Unique position ID */
  id: string;
  
  /** Agent that owns this position */
  agentId: string;
  
  /** Wallet address that holds this position */
  walletAddress: string;
  
  /** Token address */
  tokenAddress: string;
  
  /** Token symbol */
  tokenSymbol: string;
  
  /** Reference to original purchase transaction (FK, no duplication) */
  purchaseTransactionId: string;
  
  /** 
   * Average SOL price per token (weighted average after DCAs)
   * Updated after each DCA buy to reflect new average cost basis
   */
  purchasePrice: number;
  
  /** 
   * Total amount of tokens held (original + DCA buys)
   * Updated after each DCA buy
   */
  purchaseAmount: number;
  
  /**
   * Total SOL invested in this position (original + all DCAs)
   * Used to calculate weighted average price after DCAs
   */
  totalInvestedSol: number;
  
  // DCA tracking
  
  /** Number of DCA buys executed for this position */
  dcaCount: number;
  
  /** Timestamp of last DCA buy (for cooldown enforcement) */
  lastDcaTime: Date | null;
  
  /** Lowest price seen since position opened (for analytics) */
  lowestPrice: number | null;
  
  /** Array of transaction IDs for DCA buys */
  dcaTransactionIds: string[];
  
  // Stop loss tracking
  
  /** Current stop loss percentage (null if not set) */
  currentStopLossPercentage: number | null;
  
  /** Highest price reached (for trailing stop loss) */
  peakPrice: number | null;
  
  /** When stop loss was last updated */
  lastStopLossUpdate: Date | null;
  
  // Take-profit tracking
  
  /**
   * Tokens remaining after partial take-profit sales
   * null = full purchaseAmount (no partial sales yet)
   */
  remainingAmount: number | null;
  
  /** Number of take-profit levels that have been executed */
  takeProfitLevelsHit: number;
  
  /** Array of transaction IDs for take-profit partial sales */
  takeProfitTransactionIds: string[];
  
  /** Timestamp of last take-profit execution */
  lastTakeProfitTime: Date | null;
  
  /** Whether moon bag has been activated (set aside) */
  moonBagActivated: boolean;
  
  /** Amount of tokens set aside as moon bag */
  moonBagAmount: number | null;
  
  /** Cumulative realized profit in SOL from take-profit sales */
  realizedProfitSol: number;
  
  /** TP level at which the current batch started (set on DCA for append-levels model) */
  tpBatchStartLevel: number;
  
  /** Total TP levels including appended batches from DCA (null = use config.levels.length) */
  totalTakeProfitLevels: number | null;
  
  // Signal metrics (B7: stored at entry time from signal engine)

  /** Composite quality score [0,1] from signal engine; null for legacy positions */
  signalScore: number | null;

  /** Magnitude regressor output in % (e.g. 18.5); null for legacy positions */
  expectedMovePct: number | null;

  // Timestamps

  /** When position was opened */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

