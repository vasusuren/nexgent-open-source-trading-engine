/**
 * Position Service
 * 
 * Handles loading, creating, updating, and closing agent positions.
 * Manages open positions with stop loss tracking.
 * Uses cache for performance and database for persistence.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { redisPositionService } from '@/infrastructure/cache/redis-position-service.js';
import type { OpenPosition } from '@nexgent/shared';
import { positionEventEmitter } from './position-events.js';
import type { IPositionRepository } from '../positions/position.repository.js';
import type { ITransactionRepository } from '../transactions/transaction.repository.js';
import { PositionRepository } from '@/infrastructure/database/repositories/position.repository.js';
import { TransactionRepository } from '@/infrastructure/database/repositories/transaction.repository.js';
import { randomUUID } from 'crypto';
import logger from '@/infrastructure/logging/logger.js';

/** Shape accepted by convertToOpenPosition (Prisma or Redis-cached position). */
type PositionLike = {
  id: string;
  agentId: string;
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  purchaseTransactionId: string;
  purchasePrice: Decimal | number;
  purchaseAmount: Decimal | number;
  totalInvestedSol?: Decimal | number;
  dcaCount?: number;
  lastDcaTime?: Date | null;
  lowestPrice?: Decimal | number | null;
  dcaTransactionIds?: string[];
  currentStopLossPercentage: Decimal | number | null;
  peakPrice: Decimal | number | null;
  lastStopLossUpdate: Date | null;
  remainingAmount?: Decimal | number | null;
  takeProfitLevelsHit?: number;
  takeProfitTransactionIds?: string[];
  lastTakeProfitTime?: Date | null;
  moonBagActivated?: boolean;
  moonBagAmount?: Decimal | number | null;
  realizedProfitSol?: Decimal | number;
  tpBatchStartLevel?: number;
  totalTakeProfitLevels?: number | null;
  signalScore?: number | null;
  expectedMovePct?: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Position service error
 */
export class PositionServiceError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PositionServiceError';
  }
}

/**
 * Position Service
 * 
 * Singleton service for managing agent positions.
 */
class PositionService {
  constructor(
    private readonly positionRepo: IPositionRepository,
    private readonly transactionRepo: ITransactionRepository
  ) { }

  /**
   * Load positions for an agent and wallet
   * 
   * Checks cache first, then database. Converts Prisma types to OpenPosition.
   * 
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address
   * @returns Array of open positions
   */
  async loadPositions(agentId: string, walletAddress: string): Promise<OpenPosition[]> {
    // Check cache first (get IDs from index, then load positions)
    const positionIds = await redisPositionService.getAgentPositionIds(agentId);
    console.log(`[PositionService] Loading positions for agent ${agentId}, wallet ${walletAddress}: Found ${positionIds.length} position ID(s) in Redis index`);

    if (positionIds.length > 0) {
      const positions: OpenPosition[] = [];
      for (const id of positionIds) {
        const pos = await redisPositionService.getPosition(id);
        // Filter by walletAddress and ensure it's valid
        if (pos && pos.walletAddress === walletAddress) {
          positions.push(this.convertToOpenPosition(pos as PositionLike));
        } else if (pos) {
          console.log(`[PositionService] Position ${id} found in cache but walletAddress mismatch: ${pos.walletAddress} !== ${walletAddress}`);
        }
      }

      console.log(`[PositionService] Loaded ${positions.length} position(s) from Redis cache for wallet ${walletAddress}`);
      // Return cached positions if found (assumes cache is populated if index exists)
      if (positions.length > 0) {
        return positions;
      }
    }

    // Load from repository
    console.log(`[PositionService] Falling back to database for agent ${agentId}, wallet ${walletAddress}`);
    const positions = await this.positionRepo.findByAgentId(agentId);
    const walletPositions = positions.filter(p => p.walletAddress === walletAddress);
    console.log(`[PositionService] Found ${positions.length} total position(s) in DB, ${walletPositions.length} for wallet ${walletAddress}`);

    // Convert Prisma positions to OpenPosition interface
    const openPositions: OpenPosition[] = walletPositions.map(p => this.convertToOpenPosition(p));

    // Cache all positions to keep Redis index consistent
    for (const p of positions) {
      await redisPositionService.setPosition(p);
    }

    return openPositions;
  }

  /**
   * Get a single position by ID
   * 
   * @param positionId - Position ID
   * @returns Position or null if not found
   */
  async getPositionById(positionId: string): Promise<OpenPosition | null> {
    const position = await this.positionRepo.findById(positionId);

    if (!position) {
      return null;
    }

    return this.convertToOpenPosition(position);
  }

  /**
   * Get all active positions for a token address (across all agents/wallets)
   * 
   * Note: Token address should be normalized to lowercase before calling this method.
   * Uses case-insensitive comparison to handle mixed-case addresses in database.
   * 
   * @param tokenAddress - Token address (should be lowercase)
   * @returns Array of open positions
   */
  async getPositionsByToken(tokenAddress: string): Promise<OpenPosition[]> {
    // Normalize token address to lowercase for consistent comparison
    const normalizedAddress = tokenAddress.toLowerCase();

    // Get position IDs from Redis index
    const positionIds = await redisPositionService.getTokenPositionIds(normalizedAddress);

    const positions: OpenPosition[] = [];

    // Try loading from Redis first
    for (const id of positionIds) {
      const pos = await redisPositionService.getPosition(id);
      if (pos) {
        positions.push(this.convertToOpenPosition(pos as PositionLike));
      }
    }

    if (positions.length > 0) {
      return positions;
    }

    // Fallback: Load from database if Redis is empty
    // This can happen if positions were created before Redis was set up,
    // or if cache warm-up failed, or if positions weren't properly indexed
    const logger = (await import('@/infrastructure/logging/logger.js')).default;
    logger.warn({
      tokenAddress: normalizedAddress,
      redisPositionCount: positionIds.length,
    }, 'No positions found in Redis for token, falling back to database');

    // Load from database using Prisma directly (repository doesn't have findMany with where clause)
    // Note: Positions are deleted when closed, not marked with closedAt, so we just filter by tokenAddress
    const { prisma } = await import('@/infrastructure/database/client.js');
    const dbPositions = await prisma.agentPosition.findMany({
      where: {
        tokenAddress: {
          equals: normalizedAddress,
          mode: 'insensitive', // Case-insensitive match
        },
      },
    });

    // Convert and return
    return dbPositions.map(pos => this.convertToOpenPosition(pos));
  }

  /**
   * Get position by token address for an agent/wallet
   * 
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address
   * @param tokenAddress - Token address
   * @returns Position or null if not found
   */
  async getPositionByToken(
    agentId: string,
    walletAddress: string,
    tokenAddress: string
  ): Promise<OpenPosition | null> {
    // Check cache first
    const positionIds = await redisPositionService.getTokenPositionIds(tokenAddress);

    for (const id of positionIds) {
      const pos = await redisPositionService.getPosition(id);
      if (pos && pos.agentId === agentId && pos.walletAddress === walletAddress) {
        return this.convertToOpenPosition(pos as PositionLike);
      }
    }

    // Load from repository
    // We need to find by agent and wallet first
    const positions = await this.positionRepo.findByAgentId(agentId);
    const position = positions.find(p => p.walletAddress === walletAddress && p.tokenAddress === tokenAddress);

    if (!position) {
      return null;
    }

    // Update cache
    await redisPositionService.setPosition(position);

    return this.convertToOpenPosition(position);
  }

  /**
   * Create a new position from a purchase transaction
   * 
   * @param agentId - Agent ID
   * @param walletAddress - Wallet address
   * @param transactionId - Purchase transaction ID
   * @param tokenAddress - Token address
   * @param tokenSymbol - Token symbol
   * @param purchasePrice - Price in SOL per token
   * @param purchaseAmount - Amount of tokens purchased
   * @param tx - Optional Prisma transaction client
   * @returns Created position
   * @throws PositionServiceError if transaction not found or position already exists
   */
  async createPosition(
    agentId: string,
    walletAddress: string,
    transactionId: string,
    tokenAddress: string,
    tokenSymbol: string,
    purchasePrice: number,
    purchaseAmount: number,
    tx?: Prisma.TransactionClient,
    /** When provided (e.g. total SOL debited including fees from Jupiter), use for totalInvestedSol instead of purchasePrice * purchaseAmount */
    totalInvestedSolOverride?: number,
    /** B7: Composite quality score [0,1] from signal engine */
    signalScore?: number | null,
    /** B7: Magnitude regressor output in % from signal engine */
    expectedMovePct?: number | null
  ): Promise<OpenPosition> {
    // Verify transaction exists (use transaction context if provided)
    const transaction = await this.transactionRepo.findById(transactionId, tx);

    if (!transaction) {
      throw new PositionServiceError(
        `Transaction not found: ${transactionId}`,
        'TRANSACTION_NOT_FOUND'
      );
    }

    if (transaction.agentId !== agentId || transaction.walletAddress !== walletAddress) {
      throw new PositionServiceError(
        'Transaction does not belong to specified agent/wallet',
        'TRANSACTION_MISMATCH'
      );
    }

    if (transaction.transactionType !== 'SWAP' || !transaction.outputMint) {
      throw new PositionServiceError(
        'Transaction must be a SWAP with an output token',
        'INVALID_TRANSACTION_TYPE'
      );
    }

    // Check if position already exists
    const existingPositions = await this.positionRepo.findByAgentId(agentId, tx);
    const existing = existingPositions.find(p => p.walletAddress === walletAddress && p.tokenAddress === tokenAddress);

    if (existing) {
      throw new PositionServiceError(
        `Position already exists for token: ${tokenAddress}`,
        'POSITION_EXISTS'
      );
    }

    // Create position (Write-Through: DB first, then cache)
    const id = randomUUID();

    // Initial totalInvestedSol: use override when provided (total SOL debited including fees), else purchasePrice * purchaseAmount
    const totalInvestedSol = totalInvestedSolOverride ?? (purchasePrice * purchaseAmount);

    // Write to DB first (source of truth)
    const dbPosition = await this.positionRepo.create({
      id,
      agent: { connect: { id: agentId } },
      wallet: { connect: { walletAddress: walletAddress } },
      tokenAddress,
      tokenSymbol,
      purchaseTransaction: { connect: { id: transactionId } },
      // Convert to string first to preserve precision for very small numbers
      // This prevents precision loss when purchasePrice is something like 6.632e-11
      purchasePrice: new Decimal(purchasePrice.toString()),
      purchaseAmount: new Decimal(purchaseAmount.toString()),
      // DCA tracking - initial values
      totalInvestedSol: new Decimal(totalInvestedSol.toString()),
      dcaCount: 0,
      lastDcaTime: null,
      lowestPrice: new Decimal(purchasePrice.toString()), // Initial lowest = purchase price
      dcaTransactionIds: [],
      // Stop loss tracking
      currentStopLossPercentage: null,
      peakPrice: null,
      lastStopLossUpdate: null,
      // Signal metrics (B7)
      signalScore: signalScore ?? null,
      expectedMovePct: expectedMovePct ?? null,
    }, tx);

    // Update Redis cache (only if not in transaction - if in transaction, caller updates after commit)
    if (!tx) {
      await redisPositionService.setPosition(dbPosition);
    }

    const openPosition = this.convertToOpenPosition(dbPosition);

    // Emit position created only when not in a transaction. When tx is provided (e.g. from
    // trading executor), the caller must emit after the transaction commits and Redis is
    // updated, so price tracking and getPositionsByToken see the position immediately.
    if (!tx) {
      console.log(`[PositionService] 📊 Emitting position_created event for agent ${agentId}, position ${openPosition.id}, token ${tokenAddress}`);
      positionEventEmitter.emitPositionCreated({
        agentId,
        walletAddress,
        position: openPosition,
      });
    }

    return openPosition;
  }

  /**
   * Update position (typically for stop loss changes)
   * 
   * @param positionId - Position ID
   * @param updates - Partial position updates
   * @returns Updated position
   * @throws PositionServiceError if position not found
   */
  async updatePosition(
    positionId: string,
    updates: {
      currentStopLossPercentage?: number | null;
      peakPrice?: number | null;
      lastStopLossUpdate?: Date | null;
    }
  ): Promise<OpenPosition> {
    // Check Redis cache first (cache-aside pattern)
    let existing = await redisPositionService.getPosition(positionId);

    // If not in cache, check database
    if (!existing) {
      existing = await this.positionRepo.findById(positionId);

      // If found in DB, cache it for next time
      if (existing) {
        await redisPositionService.setPosition(existing);
      }
    }

    if (!existing) {
      throw new PositionServiceError(
        `Position not found: ${positionId}`,
        'POSITION_NOT_FOUND'
      );
    }

    // Build update data for Prisma
    const updateData: Prisma.AgentPositionUpdateInput = {};
    if (updates.currentStopLossPercentage !== undefined) {
      if (updates.currentStopLossPercentage === null) {
        updateData.currentStopLossPercentage = null;
      } else {
        // Validate value is finite before converting to Decimal (Prisma cannot handle Infinity/NaN)
        if (!isFinite(updates.currentStopLossPercentage) || isNaN(updates.currentStopLossPercentage)) {
          throw new PositionServiceError(
            `Cannot update position: currentStopLossPercentage is not finite (value: ${updates.currentStopLossPercentage})`,
            'INVALID_STOP_LOSS_PERCENTAGE'
          );
        }
        updateData.currentStopLossPercentage = new Decimal(updates.currentStopLossPercentage);
      }
    }
    if (updates.peakPrice !== undefined) {
      if (updates.peakPrice === null) {
        updateData.peakPrice = null;
      } else {
        // Validate value is finite and positive before converting to Decimal (Prisma cannot handle Infinity/NaN)
        if (!isFinite(updates.peakPrice) || isNaN(updates.peakPrice) || updates.peakPrice <= 0) {
          throw new PositionServiceError(
            `Cannot update position: peakPrice is not finite or invalid (value: ${updates.peakPrice})`,
            'INVALID_PEAK_PRICE'
          );
        }
        updateData.peakPrice = new Decimal(updates.peakPrice);
      }
    }
    if (updates.lastStopLossUpdate !== undefined) {
      updateData.lastStopLossUpdate = updates.lastStopLossUpdate;
    }

    // Write-Through: Update DB first (source of truth)
    const dbPosition = await this.positionRepo.update(positionId, updateData);

    // Then update Redis cache
    await redisPositionService.setPosition(dbPosition);

    const openPosition = this.convertToOpenPosition(dbPosition);

    // Emit position updated event
    positionEventEmitter.emitPositionUpdated({
      agentId: existing.agentId,
      walletAddress: existing.walletAddress,
      position: openPosition,
    });

    return openPosition;
  }

  /**
   * Close a position (delete it, typically after sale)
   * 
   * @param positionId - Position ID
   * @throws PositionServiceError if position not found
   */
  async closePosition(positionId: string): Promise<void> {
    // Load position first to verify it exists and get metadata for event
    const position = await this.positionRepo.findById(positionId);

    if (!position) {
      throw new PositionServiceError(
        `Position not found: ${positionId}`,
        'POSITION_NOT_FOUND'
      );
    }

    // Store position info before deletion for event
    const { agentId, walletAddress, tokenAddress, tokenSymbol } = position;

    // Write-Through: Delete from DB first (source of truth)
    await this.positionRepo.delete(positionId);

    // Then delete from Redis cache
    await redisPositionService.deletePosition(position);

    positionEventEmitter.emitPositionClosed({
      agentId,
      walletAddress,
      positionId,
      tokenAddress,
      tokenSymbol: tokenSymbol ?? undefined,
    });
  }

  /**
   * Convert Prisma AgentPosition to OpenPosition interface
   * 
   * @param position - Prisma position
   * @returns OpenPosition
   */
  /**
   * Helper to safely convert Decimal or number to number
   * Handles both Prisma Decimal objects and plain numbers from Redis
   */
  private toNumber(value: Decimal | number | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      return value;
    }
    // It's a Decimal object
    if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: () => number }).toNumber === 'function') {
      return (value as Decimal).toNumber();
    }
    // Fallback: try to convert string or other types
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? null : num;
  }

  private convertToOpenPosition(position: {
    id: string;
    agentId: string;
    walletAddress: string;
    tokenAddress: string;
    tokenSymbol: string;
    purchaseTransactionId: string;
    purchasePrice: Decimal | number;
    purchaseAmount: Decimal | number;
    totalInvestedSol?: Decimal | number;
    dcaCount?: number;
    lastDcaTime?: Date | null;
    lowestPrice?: Decimal | number | null;
    dcaTransactionIds?: string[];
    currentStopLossPercentage: Decimal | number | null;
    peakPrice: Decimal | number | null;
    lastStopLossUpdate: Date | null;
    // Take-profit fields
    remainingAmount?: Decimal | number | null;
    takeProfitLevelsHit?: number;
    takeProfitTransactionIds?: string[];
    lastTakeProfitTime?: Date | null;
    moonBagActivated?: boolean;
    moonBagAmount?: Decimal | number | null;
    realizedProfitSol?: Decimal | number;
    tpBatchStartLevel?: number;
    totalTakeProfitLevels?: number | null;
    // Signal metrics (B7)
    signalScore?: number | null;
    expectedMovePct?: number | null;
    createdAt: Date;
    updatedAt: Date;
  }): OpenPosition {
    const purchasePrice = this.toNumber(position.purchasePrice) ?? 0;
    const purchaseAmount = this.toNumber(position.purchaseAmount) ?? 0;

    return {
      id: position.id,
      agentId: position.agentId,
      walletAddress: position.walletAddress,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      purchaseTransactionId: position.purchaseTransactionId,
      purchasePrice,
      purchaseAmount,
      // DCA fields - provide defaults for backward compatibility
      totalInvestedSol: this.toNumber(position.totalInvestedSol) ?? (purchasePrice * purchaseAmount),
      dcaCount: position.dcaCount ?? 0,
      lastDcaTime: position.lastDcaTime ?? null,
      lowestPrice: this.toNumber(position.lowestPrice),
      dcaTransactionIds: position.dcaTransactionIds ?? [],
      // Stop loss fields
      currentStopLossPercentage: this.toNumber(position.currentStopLossPercentage),
      peakPrice: this.toNumber(position.peakPrice),
      lastStopLossUpdate: position.lastStopLossUpdate,
      // Take-profit fields - provide defaults for backward compatibility
      remainingAmount: this.toNumber(position.remainingAmount),
      takeProfitLevelsHit: position.takeProfitLevelsHit ?? 0,
      takeProfitTransactionIds: position.takeProfitTransactionIds ?? [],
      lastTakeProfitTime: position.lastTakeProfitTime ?? null,
      moonBagActivated: position.moonBagActivated ?? false,
      moonBagAmount: this.toNumber(position.moonBagAmount),
      realizedProfitSol: this.toNumber(position.realizedProfitSol) ?? 0,
      tpBatchStartLevel: position.tpBatchStartLevel ?? 0,
      totalTakeProfitLevels: position.totalTakeProfitLevels ?? null,
      // Signal metrics (B7)
      signalScore: position.signalScore ?? null,
      expectedMovePct: position.expectedMovePct ?? null,
      // Timestamps
      createdAt: position.createdAt,
      updatedAt: position.updatedAt,
    };
  }

  /**
   * Update position after a DCA buy
   * 
   * @param positionId - Position ID
   * @param updates - DCA-specific updates
   * @returns Updated position
   * @throws PositionServiceError if position not found
   */
  async updatePositionAfterDCA(
    positionId: string,
    updates: {
      newAveragePurchasePrice: number;
      newTotalPurchaseAmount: number;
      newTotalInvestedSol: number;
      dcaTransactionId: string;
      /** Number of new tokens acquired in this DCA buy */
      newTokensAcquired: number;
      /** Number of TP levels in the current config (for append-levels model) */
      configTpLevelsCount: number;
    }
  ): Promise<OpenPosition> {
    // Check position exists
    const existing = await this.positionRepo.findById(positionId);

    if (!existing) {
      throw new PositionServiceError(
        `Position not found: ${positionId}`,
        'POSITION_NOT_FOUND'
      );
    }

    // Validate values are finite
    if (!isFinite(updates.newAveragePurchasePrice) || updates.newAveragePurchasePrice <= 0) {
      throw new PositionServiceError(
        `Invalid average purchase price: ${updates.newAveragePurchasePrice}`,
        'INVALID_PRICE'
      );
    }

    // Build update data
    const currentDcaIds = existing.dcaTransactionIds ?? [];
    const newDcaIds = [...currentDcaIds, updates.dcaTransactionId];

    const updateData: Record<string, unknown> = {
      purchasePrice: new Decimal(updates.newAveragePurchasePrice.toString()),
      purchaseAmount: new Decimal(updates.newTotalPurchaseAmount.toString()),
      totalInvestedSol: new Decimal(updates.newTotalInvestedSol.toString()),
      dcaCount: (existing.dcaCount ?? 0) + 1,
      lastDcaTime: new Date(),
      dcaTransactionIds: newDcaIds,
    };

    // Update remainingAmount if TP has occurred (remainingAmount is not null/undefined)
    if (existing.remainingAmount != null) {
      const currentRemaining = parseFloat(existing.remainingAmount.toString());
      updateData.remainingAmount = new Decimal(
        (currentRemaining + updates.newTokensAcquired).toString()
      );
    }

    // Set TP batch fields for append-levels model
    const levelsHit = existing.takeProfitLevelsHit ?? 0;
    updateData.tpBatchStartLevel = levelsHit;
    updateData.totalTakeProfitLevels = levelsHit + updates.configTpLevelsCount;

    // Write-Through: Update DB first (source of truth)
    const dbPosition = await this.positionRepo.update(positionId, updateData);

    // Then update Redis cache
    await redisPositionService.setPosition(dbPosition);

    const openPosition = this.convertToOpenPosition(dbPosition);

    // Emit position updated event
    positionEventEmitter.emitPositionUpdated({
      agentId: existing.agentId,
      walletAddress: existing.walletAddress,
      position: openPosition,
    });

    return openPosition;
  }

  /**
   * Update lowest price for a position (for DCA analytics)
   * 
   * @param positionId - Position ID
   * @param currentPrice - Current token price
   */
  async updateLowestPrice(positionId: string, currentPrice: number): Promise<void> {
    const existing = await this.positionRepo.findById(positionId);

    if (!existing) {
      return; // Position may have been closed
    }

    const currentLowest = existing.lowestPrice ? existing.lowestPrice.toNumber() : Infinity;

    if (currentPrice < currentLowest) {
      const updateData = {
        lowestPrice: new Decimal(currentPrice.toString()),
      };

      const dbPosition = await this.positionRepo.update(positionId, updateData);
      await redisPositionService.setPosition(dbPosition);
    }
  }

  /**
   * Update position after a take-profit sale
   * 
   * @param positionId - Position ID
   * @param updates - Take-profit specific updates
   * @returns Updated position
   * @throws PositionServiceError if position not found
   */
  async updatePositionAfterTakeProfit(
    positionId: string,
    updates: {
      /** New remaining amount after partial sale */
      newRemainingAmount: number;
      /** Number of levels executed in this sale */
      levelsExecuted: number;
      /** Transaction ID for this take-profit sale */
      takeProfitTransactionId: string;
      /** Whether to activate moon bag */
      activateMoonBag: boolean;
      /** Moon bag amount (if activating) */
      moonBagAmount?: number;
      /** Realized profit in SOL from this take-profit sale */
      profitLossSol?: number;
    }
  ): Promise<OpenPosition> {
    // Check position exists
    const existing = await this.positionRepo.findById(positionId);

    if (!existing) {
      throw new PositionServiceError(
        `Position not found: ${positionId}`,
        'POSITION_NOT_FOUND'
      );
    }

    // Validate values
    if (!isFinite(updates.newRemainingAmount) || updates.newRemainingAmount < 0) {
      throw new PositionServiceError(
        `Invalid remaining amount: ${updates.newRemainingAmount}`,
        'INVALID_AMOUNT'
      );
    }

    // Build update data
    const currentTpIds = existing.takeProfitTransactionIds ?? [];
    const newTpIds = [...currentTpIds, updates.takeProfitTransactionId];
    const newLevelsHit = (existing.takeProfitLevelsHit ?? 0) + updates.levelsExecuted;

    // Accumulate realized profit from take-profit sales
    const currentRealizedProfit = existing.realizedProfitSol ? parseFloat(existing.realizedProfitSol.toString()) : 0;
    const newRealizedProfit = currentRealizedProfit + (updates.profitLossSol ?? 0);

    const updateData: Record<string, unknown> = {
      remainingAmount: new Decimal(updates.newRemainingAmount.toString()),
      takeProfitLevelsHit: newLevelsHit,
      takeProfitTransactionIds: newTpIds,
      lastTakeProfitTime: new Date(),
      realizedProfitSol: new Decimal(newRealizedProfit.toString()),
    };

    // Activate moon bag if requested
    if (updates.activateMoonBag && updates.moonBagAmount !== undefined) {
      updateData.moonBagActivated = true;
      updateData.moonBagAmount = new Decimal(updates.moonBagAmount.toString());
    }

    // Write-Through: Update DB first (source of truth)
    const dbPosition = await this.positionRepo.update(positionId, updateData);

    // Then update Redis cache
    await redisPositionService.setPosition(dbPosition);

    const openPosition = this.convertToOpenPosition(dbPosition);

    // Emit position updated event
    positionEventEmitter.emitPositionUpdated({
      agentId: existing.agentId,
      walletAddress: existing.walletAddress,
      position: openPosition,
    });

    logger.info({
      positionId,
      agentId: existing.agentId,
      tokenSymbol: existing.tokenSymbol,
      levelsExecuted: updates.levelsExecuted,
      totalLevelsHit: newLevelsHit,
      newRemainingAmount: updates.newRemainingAmount,
      moonBagActivated: updates.activateMoonBag,
      moonBagAmount: updates.moonBagAmount,
    }, 'Position updated after take-profit');

    return openPosition;
  }

  /**
   * Get positions with take-profit activity for an agent
   * 
   * Returns positions that have at least one take-profit level executed.
   * 
   * @param agentId - Agent ID
   * @returns Array of positions with take-profit activity
   */
  async getPositionsWithTakeProfitActivity(agentId: string): Promise<OpenPosition[]> {
    const positions = await this.positionRepo.findPositionsWithTakeProfitActivity(agentId);
    return positions.map(p => this.convertToOpenPosition(p));
  }

  /**
   * Get moon bag positions for an agent
   * 
   * Returns positions where the moon bag has been activated.
   * These positions are held indefinitely unless stop-loss triggers.
   * 
   * @param agentId - Agent ID
   * @returns Array of moon bag positions
   */
  async getMoonBagPositions(agentId: string): Promise<OpenPosition[]> {
    const positions = await this.positionRepo.findMoonBagPositions(agentId);
    return positions.map(p => this.convertToOpenPosition(p));
  }

  /**
   * Get take-profit summary for an agent
   * 
   * Returns statistics about take-profit activity across all positions.
   * 
   * @param agentId - Agent ID
   * @returns Take-profit summary statistics
   */
  async getTakeProfitSummary(agentId: string): Promise<{
    totalPositions: number;
    positionsWithTakeProfitHit: number;
    activeMoonBags: number;
    totalLevelsHit: number;
  }> {
    const allPositions = await this.positionRepo.findByAgentId(agentId);
    
    let positionsWithTakeProfitHit = 0;
    let activeMoonBags = 0;
    let totalLevelsHit = 0;

    for (const position of allPositions) {
      if (position.takeProfitLevelsHit > 0) {
        positionsWithTakeProfitHit++;
        totalLevelsHit += position.takeProfitLevelsHit;
      }
      if (position.moonBagActivated) {
        activeMoonBags++;
      }
    }

    return {
      totalPositions: allPositions.length,
      positionsWithTakeProfitHit,
      activeMoonBags,
      totalLevelsHit,
    };
  }
}

// Export singleton instance
export const positionService = new PositionService(
  new PositionRepository(),
  new TransactionRepository()
);
