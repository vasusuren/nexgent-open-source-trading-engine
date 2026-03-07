/**
 * Agent Position API types
 * Shared between frontend and backend
 */

/**
 * Position response
 */
export interface PositionResponse {
  id: string;
  agentId: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  
  // Purchase information
  purchase: {
    priceNative: number;
    priceUsd: number;
    amount: number;
    transaction: {
      id: string;
      hash: string | null;
      time: Date;
    };
  };
  
  // Current market data
  current: {
    priceNative: number;
    priceUsd: number;
    valueNative: number;
    valueUsd: number;
  };
  
  // Profit/Loss metrics
  profitLoss: {
    native: number;
    usd: number;
    percent: number;
    priceChangePercent: number;
  };
  
  // Stop loss information
  stopLoss: {
    percentage: number;
    peakPrice: number;
  };
  
  // Take-profit information
  takeProfit: {
    /** Number of take-profit levels that have been executed */
    levelsHit: number;
    /** Total TP levels including appended batches from DCA (null = use config.levels.length) */
    totalLevels: number | null;
    /** TP level at which current batch started (for append-levels model) */
    tpBatchStartLevel: number;
    /** Remaining token amount after partial sales */
    remainingAmount: number;
    /** Original purchase amount (for calculating sold percentage) */
    originalAmount: number;
    /** Percentage of position that has been sold through take-profit */
    soldPercent: number;
    /** Whether moon bag has been activated */
    moonBagActivated: boolean;
    /** Moon bag amount (if activated) */
    moonBagAmount: number | null;
    /** Last take-profit execution time */
    lastTakeProfitTime: Date | null;
    /** List of take-profit transaction IDs */
    transactionIds: string[];
  };
  
  // DCA information
  dca: {
    /** Number of DCA buys executed */
    count: number;
    /** Total SOL invested (including DCA buys) */
    totalInvestedSol: number;
    /** Last DCA execution time */
    lastDcaTime: Date | null;
  };
  
  // Signal metrics (B8: from signal engine at entry time)
  signalScore: number | null;
  expectedMovePct: number | null;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Request body for closing a position
 */
export interface ClosePositionRequest {
  reason?: 'manual' | 'stop_loss' | 'take_profit';
}

/**
 * Response from closing a position
 */
export interface ClosePositionResponse {
  success: boolean;
  transactionId?: string;
  historicalSwapId?: string;
  profitLossSol?: string;
  profitLossUsd?: string;
  changePercent?: string;
  transactionHash?: string;
  error?: string;
}

/**
 * Take-profit summary for an agent
 */
export interface TakeProfitSummaryResponse {
  /** Total number of open positions */
  totalPositions: number;
  /** Positions that have had at least one take-profit level hit */
  positionsWithTakeProfitHit: number;
  /** Positions with active moon bags */
  activeMoonBags: number;
  /** Total take-profit levels hit across all positions */
  totalLevelsHit: number;
  /** Detailed breakdown by position (optional, for expanded view) */
  positions?: Array<{
    id: string;
    tokenSymbol: string;
    levelsHit: number;
    remainingPercent: number;
    moonBagActivated: boolean;
    lastTakeProfitTime: Date | null;
  }>;
}
