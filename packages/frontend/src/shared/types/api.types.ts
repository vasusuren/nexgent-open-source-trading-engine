/**
 * API Types
 * 
 * Shared types for API requests and responses.
 * 
 * @module shared/types
 */

/**
 * Agent data structure
 */
export interface Agent {
  id: string;
  userId: string;
  name: string;
  tradingMode: 'simulation' | 'live';
  automatedTradingSimulation: boolean;
  automatedTradingLive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create agent request
 */
export interface CreateAgentRequest {
  name: string;
  tradingMode?: 'simulation' | 'live';
}

/**
 * Update agent request
 */
export interface UpdateAgentRequest {
  name?: string;
  tradingMode?: 'simulation' | 'live';
  automatedTradingSimulation?: boolean;
  automatedTradingLive?: boolean;
}

/**
 * Agent balance data structure
 */
export interface AgentBalance {
  id: string;
  agentId: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  balance: string;
  lastUpdated: string;
  priceSol?: number; // Optional: Price per token in SOL (enriched from price cache)
}

/**
 * Trading signal data structure
 */
export interface TradingSignal {
  id: number;
  createdAt: string;
  updatedAt: string;
  tokenAddress: string;
  symbol: string | null;
  signalType: string;
  activationReason: string | null;
  signalStrength: number;
  source: string | null;
}

/**
 * Agent transaction data structure
 */
export interface AgentTransaction {
  id: string;
  agentId: string;
  walletAddress: string | null;
  transactionType: 'DEPOSIT' | 'SWAP' | 'BURN';
  transactionValueUsd: string;
  transactionTime: string;
  destinationAddress: string | null;
  signalId: number | null;
  fees: string | null;
  routes: unknown | null;
  inputMint: string | null;
  inputSymbol: string | null;
  inputAmount: string | null;
  inputPrice: string | null;
  outputMint: string | null;
  outputSymbol: string | null;
  outputAmount: string | null;
  outputPrice: string | null;
  slippage: string | null;
  priceImpact: string | null;
  isDca: boolean;
  isTakeProfit: boolean;
  transactionHash: string | null;
  protocolFeeSol: string | null;
  networkFeeSol: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Trading Signals Query Parameters
 */
export interface TradingSignalsQueryParams {
  limit?: number;
  offset?: number;
  tokenAddress?: string;
  signalType?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Agent Transactions Query Parameters
 */
export interface ListAgentTransactionsParams {
  agentId: string;
  walletAddress?: string;
  transactionType?: 'DEPOSIT' | 'SWAP' | 'BURN';
  startTime?: string;
  endTime?: string;
  signalId?: number | string;
  isDca?: boolean;
  isTakeProfit?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Create Agent Transaction Request
 */
export interface CreateAgentTransactionRequest {
  agentId: string;
  walletAddress?: string;
  transactionType: 'DEPOSIT' | 'SWAP' | 'BURN';
  transactionValueUsd: number | string;
  transactionTime: string;
  destinationAddress?: string | null;
  signalId?: number | null;
  fees?: number | string | null;
  routes?: unknown | null;
  inputMint?: string | null;
  inputSymbol?: string | null;
  inputAmount?: number | string | null;
  inputPrice?: number | string | null;
  outputMint?: string | null;
  outputSymbol?: string | null;
  outputAmount?: number | string | null;
  outputPrice?: number | string | null;
  slippage?: number | string | null;
  priceImpact?: number | string | null;
  isDca?: boolean;
  isTakeProfit?: boolean;
}

/**
 * Agent historical swap data structure
 */
export interface AgentHistoricalSwap {
  id: string;
  agentId: string;
  walletAddress: string | null;
  tokenAddress: string;
  tokenSymbol: string;
  amount: string; // Decimal returned as string
  purchasePrice: string; // Decimal returned as string
  salePrice: string; // Decimal returned as string
  changePercent: string; // Decimal returned as string
  profitLossUsd: string; // Decimal returned as string
  profitLossSol: string; // Decimal returned as string
  purchaseTime: string; // ISO date string
  saleTime: string; // ISO date string
  purchaseTransactionId: string | null;
  saleTransactionId: string | null;
  signalId: string | null;
  closeReason: 'manual' | 'stop_loss' | 'stale_trade' | 'signal_replace' | 'take_profit' | null;
  createdAt: string;
}

/**
 * Token balance with price information
 */
export interface TokenBalance {
  tokenAddress: string;
  tokenSymbol: string;
  balance: number;
  priceUsd: number;
  totalValueUsd: number;
  priceSol: number; // Price per token in SOL (used for direct display, avoids conversion errors)
}

/**
 * Portfolio balance response
 */
export interface PortfolioBalance {
  totalBalanceUsd: number;
  totalBalanceSol: number; // Total balance in SOL (calculated directly from tokens, avoids conversion errors)
  tokens: TokenBalance[];
}

/**
 * API error response
 */
export interface ApiError {
  error: string;
  message?: string;
}

/**
 * Wallet Types
 */

export interface WalletListItem {
  walletAddress: string;
  walletType: 'simulation' | 'live';
  isAvailable: boolean; // For live wallets: true if loaded from env, false otherwise. For simulation: always true.
  createdAt: string;
  updatedAt: string;
}

export interface AvailableWallet {
  walletAddress: string;
  isAssigned: boolean; // Indicates if this available wallet is already assigned to an agent
}

export interface ListWalletsResponse {
  agentWallets: WalletListItem[];
  availableWallets: AvailableWallet[];
}

export interface AssignWalletRequest {
  agentId: string;
  walletAddress: string;
  walletType: 'live'; // Only live wallets can be assigned from env vars
}

export interface AssignWalletResponse {
  success: boolean;
  walletAddress: string;
  agentId: string;
  walletType: 'live';
  message: string;
}
