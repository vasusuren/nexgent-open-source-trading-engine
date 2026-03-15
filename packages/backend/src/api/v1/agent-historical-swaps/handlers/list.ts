/**
 * List agent historical swaps endpoint
 * 
 * GET /api/agent-historical-swaps
 * 
 * Returns agent historical swaps with optional filtering.
 * Requires authentication. Users can only access swaps for their own agents.
 */

import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/database/client.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import type { AgentHistoricalSwapResponse, ListAgentHistoricalSwapsQuery } from '../types.js';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Get agent historical swaps with optional filters
 * 
 * Query params:
 * - agentId: Required - Filter by agent ID
 * - tokenAddress: Filter by token address
 * - tokenSymbol: Filter by token symbol
 * - startPurchaseTime: Filter by start purchase time (ISO string)
 * - endPurchaseTime: Filter by end purchase time (ISO string)
 * - startSaleTime: Filter by start sale time (ISO string)
 * - endSaleTime: Filter by end sale time (ISO string)
 * - signalId: Filter by signal ID
 * - purchaseTransactionId: Filter by purchase transaction ID
 * - saleTransactionId: Filter by sale transaction ID
 * - minProfitLossUsd: Filter by minimum profit/loss USD
 * - maxProfitLossUsd: Filter by maximum profit/loss USD
 * - limit: Maximum number of results (default: 100)
 * - offset: Number of results to skip (default: 0)
 * 
 * Returns: Array of swap objects
 */
export async function listAgentHistoricalSwaps(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const query = req.query as unknown as ListAgentHistoricalSwapsQuery;

    // Validate required agentId
    if (!query.agentId) {
      return res.status(400).json({
        error: 'Agent ID is required',
      });
    }

    // Verify agent belongs to the authenticated user
    const agent = await prisma.agent.findUnique({
      where: { id: query.agentId },
      select: { userId: true },
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
      });
    }

    if (agent.userId !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only access swaps for your own agents',
      });
    }

    // Build where clause
    const where: Prisma.AgentHistoricalSwapWhereInput = {
      agentId: query.agentId,
    };

    // Filter by walletAddress if provided
    if (query.walletAddress) {
      where.walletAddress = query.walletAddress;
    }

    if (query.tokenAddress) {
      where.tokenAddress = query.tokenAddress.trim();
    }

    if (query.tokenSymbol) {
      where.tokenSymbol = query.tokenSymbol.trim();
    }

    if (query.startPurchaseTime || query.endPurchaseTime) {
      where.purchaseTime = {};
      if (query.startPurchaseTime) {
        const startDate = new Date(query.startPurchaseTime);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            error: 'Invalid start purchase time format (use ISO date string)',
          });
        }
        where.purchaseTime.gte = startDate;
      }
      if (query.endPurchaseTime) {
        const endDate = new Date(query.endPurchaseTime);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            error: 'Invalid end purchase time format (use ISO date string)',
          });
        }
        where.purchaseTime.lte = endDate;
      }
    }

    if (query.startSaleTime || query.endSaleTime) {
      where.saleTime = {};
      if (query.startSaleTime) {
        const startDate = new Date(query.startSaleTime);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            error: 'Invalid start sale time format (use ISO date string)',
          });
        }
        where.saleTime.gte = startDate;
      }
      if (query.endSaleTime) {
        const endDate = new Date(query.endSaleTime);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            error: 'Invalid end sale time format (use ISO date string)',
          });
        }
        where.saleTime.lte = endDate;
      }
    }

    if (query.signalId) {
      const parsedSignalId = parseInt(query.signalId, 10);
      if (isNaN(parsedSignalId)) {
        return res.status(400).json({
          error: 'Signal ID must be a valid integer',
        });
      }
      where.signalId = parsedSignalId;
    }

    if (query.purchaseTransactionId) {
      where.purchaseTransactionId = query.purchaseTransactionId;
    }

    if (query.saleTransactionId) {
      where.saleTransactionId = query.saleTransactionId;
    }

    if (query.minProfitLossUsd || query.maxProfitLossUsd) {
      where.profitLossUsd = {};
      if (query.minProfitLossUsd) {
        where.profitLossUsd.gte = new Decimal(query.minProfitLossUsd);
      }
      if (query.maxProfitLossUsd) {
        where.profitLossUsd.lte = new Decimal(query.maxProfitLossUsd);
      }
    }

    // Parse pagination
    const limit = query.limit ? Math.min(parseInt(query.limit, 10), 1000) : 100;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;

    // Validate pagination
    if (isNaN(limit) || limit < 1) {
      return res.status(400).json({
        error: 'Limit must be a positive number',
      });
    }

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({
        error: 'Offset must be a non-negative number',
      });
    }

    // Get swaps
    const swaps = await prisma.agentHistoricalSwap.findMany({
      where,
      select: {
        id: true,
        agentId: true,
        walletAddress: true,
        tokenAddress: true,
        tokenSymbol: true,
        amount: true,
        purchasePrice: true,
        salePrice: true,
        changePercent: true,
        profitLossUsd: true,
        profitLossSol: true,
        purchaseTime: true,
        saleTime: true,
        purchaseTransactionId: true,
        saleTransactionId: true,
        signalId: true,
        closeReason: true,
        createdAt: true,
      },
      orderBy: {
        saleTime: 'desc', // Most recent sales first
      },
      take: limit,
      skip: offset,
    });

    const response: AgentHistoricalSwapResponse[] = swaps.map((swap) => ({
      id: swap.id,
      agentId: swap.agentId,
      walletAddress: swap.walletAddress,
      tokenAddress: swap.tokenAddress,
      tokenSymbol: swap.tokenSymbol,
      amount: swap.amount.toString(),
      purchasePrice: swap.purchasePrice.toString(),
      salePrice: swap.salePrice.toString(),
      changePercent: swap.changePercent.toString(),
      profitLossUsd: swap.profitLossUsd.toString(),
      profitLossSol: swap.profitLossSol.toString(),
      purchaseTime: swap.purchaseTime,
      saleTime: swap.saleTime,
      purchaseTransactionId: swap.purchaseTransactionId,
      saleTransactionId: swap.saleTransactionId,
      signalId: swap.signalId?.toString() || null,
      closeReason: (swap.closeReason as 'manual' | 'stop_loss' | 'stale_trade' | 'signal_replace' | 'take_profit' | null) || null,
      createdAt: swap.createdAt,
    }));

    res.json(response);
  } catch (error) {
    console.error('List agent historical swaps error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

