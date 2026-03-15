/**
 * Get agent historical swap endpoint
 * 
 * GET /api/agent-historical-swaps/:id
 * 
 * Returns a single agent historical swap by ID.
 * Requires authentication. Users can only access swaps for their own agents.
 */

import { Response } from 'express';
import { prisma } from '@/infrastructure/database/client.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import type { AgentHistoricalSwapResponse } from '../types.js';

/**
 * Get an agent historical swap by ID
 * 
 * Params: { id: string }
 * Returns: Swap object
 */
export async function getAgentHistoricalSwap(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        error: 'Swap ID is required',
      });
    }

    // Get swap with agent relationship
    const swap = await prisma.agentHistoricalSwap.findUnique({
      where: { id },
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
        agent: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!swap) {
      return res.status(404).json({
        error: 'Historical swap not found',
      });
    }

    // Verify swap belongs to the authenticated user's agent
    if (swap.agent.userId !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only access swaps for your own agents',
      });
    }

    const response: AgentHistoricalSwapResponse = {
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
      signalId: swap.signalId !== null ? swap.signalId.toString() : null,
      closeReason: (swap.closeReason as 'manual' | 'stop_loss' | 'stale_trade' | 'signal_replace' | 'take_profit' | null) || null,
      createdAt: swap.createdAt,
    };

    res.json(response);
  } catch (error) {
    console.error('Get agent historical swap error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

