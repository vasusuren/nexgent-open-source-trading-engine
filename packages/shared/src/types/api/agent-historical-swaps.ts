/**
 * Agent Historical Swaps API types
 * Shared between frontend and backend
 */

/**
 * Request body for creating an agent historical swap
 */
export interface CreateAgentHistoricalSwapRequest {
  agentId: string;
  walletAddress?: string;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number | string;
  purchasePrice: number | string;
  salePrice: number | string;
  changePercent: number | string;
  profitLossUsd: number | string;
  profitLossSol: number | string;
  purchaseTime: string;
  saleTime: string;
  purchaseTransactionId?: string | null;
  saleTransactionId?: string | null;
  signalId?: number | null;
  closeReason?: 'manual' | 'stop_loss' | 'stale_trade' | 'signal_replace' | 'take_profit' | null;
}

/**
 * Request body for updating an agent historical swap
 */
export interface UpdateAgentHistoricalSwapRequest {
  tokenAddress?: string;
  tokenSymbol?: string;
  amount?: number | string;
  purchasePrice?: number | string;
  salePrice?: number | string;
  changePercent?: number | string;
  profitLossUsd?: number | string;
  profitLossSol?: number | string;
  purchaseTime?: string;
  saleTime?: string;
  purchaseTransactionId?: string | null;
  saleTransactionId?: string | null;
  signalId?: number | null;
  closeReason?: 'manual' | 'stop_loss' | 'stale_trade' | 'signal_replace' | 'take_profit' | null;
}

/**
 * Agent Historical Swap response
 */
export interface AgentHistoricalSwapResponse {
  id: string;
  agentId: string;
  walletAddress: string | null;
  tokenAddress: string;
  tokenSymbol: string;
  amount: string;
  purchasePrice: string;
  salePrice: string;
  changePercent: string;
  profitLossUsd: string;
  profitLossSol: string;
  purchaseTime: Date;
  saleTime: Date;
  purchaseTransactionId: string | null;
  saleTransactionId: string | null;
  signalId: string | null;
  closeReason: 'manual' | 'stop_loss' | 'stale_trade' | 'signal_replace' | 'take_profit' | null;
  createdAt: Date;
}

/**
 * Query parameters for listing agent historical swaps
 */
export interface ListAgentHistoricalSwapsQuery {
  agentId: string;
  walletAddress?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  startPurchaseTime?: string;
  endPurchaseTime?: string;
  startSaleTime?: string;
  endSaleTime?: string;
  signalId?: string;
  purchaseTransactionId?: string;
  saleTransactionId?: string;
  minProfitLossUsd?: string;
  maxProfitLossUsd?: string;
  limit?: string;
  offset?: string;
}

/**
 * Query parameters for exporting agent historical swaps to CSV
 * Reuses all filters from ListAgentHistoricalSwapsQuery but excludes pagination
 */
export interface ExportAgentHistoricalSwapsQuery {
  agentId: string;
  walletAddress?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  startPurchaseTime?: string;
  endPurchaseTime?: string;
  startSaleTime?: string;
  endSaleTime?: string;
  signalId?: string;
  purchaseTransactionId?: string;
  saleTransactionId?: string;
  minProfitLossUsd?: string;
  maxProfitLossUsd?: string;
  /** User's timezone for date formatting (e.g., "America/New_York") */
  timezone?: string;
  /** User's currency preference ('USD' or 'SOL') */
  currency?: 'USD' | 'SOL';
  /** Current SOL price in USD (required for USD currency conversion) */
  solPrice?: string;
}

