/**
 * Update agent historical swap endpoint
 * 
 * PUT /api/agent-historical-swaps/:id
 * 
 * Updates an existing agent historical swap.
 * Requires authentication. Users can only update swaps for their own agents.
 */

import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '@/infrastructure/database/client.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import type { UpdateAgentHistoricalSwapRequest, AgentHistoricalSwapResponse } from '../types.js';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Update an agent historical swap
 * 
 * Params: { id: string }
 * Body: Partial swap fields
 * Returns: Updated swap object
 */
export async function updateAgentHistoricalSwap(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;
    const updateData: UpdateAgentHistoricalSwapRequest = req.body;

    if (!id) {
      return res.status(400).json({
        error: 'Swap ID is required',
      });
    }

    // Check if swap exists and belongs to user's agent
    const existingSwap = await prisma.agentHistoricalSwap.findUnique({
      where: { id },
      select: {
        agent: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!existingSwap) {
      return res.status(404).json({
        error: 'Historical swap not found',
      });
    }

    if (existingSwap.agent.userId !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only update swaps for your own agents',
      });
    }

    // Build update data
    const data: Prisma.AgentHistoricalSwapUpdateInput = {};

    if (updateData.tokenAddress !== undefined) {
      if (typeof updateData.tokenAddress !== 'string' || updateData.tokenAddress.trim().length === 0) {
        return res.status(400).json({
          error: 'Token address must be a non-empty string',
        });
      }
      if (updateData.tokenAddress.length > 255) {
        return res.status(400).json({
          error: 'Token address must be 255 characters or less',
        });
      }
      data.tokenAddress = updateData.tokenAddress.trim();
    }

    if (updateData.tokenSymbol !== undefined) {
      if (typeof updateData.tokenSymbol !== 'string' || updateData.tokenSymbol.trim().length === 0) {
        return res.status(400).json({
          error: 'Token symbol must be a non-empty string',
        });
      }
      if (updateData.tokenSymbol.length > 20) {
        return res.status(400).json({
          error: 'Token symbol must be 20 characters or less',
        });
      }
      data.tokenSymbol = updateData.tokenSymbol.trim();
    }

    if (updateData.amount !== undefined) {
      const amount = new Decimal(updateData.amount.toString());
      if (amount.lt(0)) {
        return res.status(400).json({
          error: 'Amount must be non-negative',
        });
      }
      data.amount = amount;
    }

    if (updateData.purchasePrice !== undefined) {
      const price = new Decimal(updateData.purchasePrice.toString());
      if (price.lte(0)) {
        return res.status(400).json({
          error: 'Purchase price must be positive',
        });
      }
      data.purchasePrice = price;
    }

    if (updateData.salePrice !== undefined) {
      const price = new Decimal(updateData.salePrice.toString());
      if (price.lte(0)) {
        return res.status(400).json({
          error: 'Sale price must be positive',
        });
      }
      data.salePrice = price;
    }

    if (updateData.changePercent !== undefined) {
      data.changePercent = new Decimal(updateData.changePercent.toString());
    }

    if (updateData.profitLossUsd !== undefined) {
      data.profitLossUsd = new Decimal(updateData.profitLossUsd.toString());
    }

    if (updateData.profitLossSol !== undefined) {
      data.profitLossSol = new Decimal(updateData.profitLossSol.toString());
    }

    if (updateData.purchaseTime !== undefined) {
      const time = new Date(updateData.purchaseTime);
      if (isNaN(time.getTime())) {
        return res.status(400).json({
          error: 'Invalid purchase time format (use ISO date string)',
        });
      }
      data.purchaseTime = time;
    }

    if (updateData.saleTime !== undefined) {
      const time = new Date(updateData.saleTime);
      if (isNaN(time.getTime())) {
        return res.status(400).json({
          error: 'Invalid sale time format (use ISO date string)',
        });
      }
      data.saleTime = time;
    }

    // Validate sale_time >= purchase_time if both are being updated
    if (data.saleTime && data.purchaseTime) {
      if (data.saleTime < data.purchaseTime) {
        return res.status(400).json({
          error: 'Sale time must be greater than or equal to purchase time',
        });
      }
    } else if (data.saleTime) {
      // If only saleTime is being updated, check against existing purchaseTime
      const existing = await prisma.agentHistoricalSwap.findUnique({
        where: { id },
        select: { purchaseTime: true },
      });
      if (existing && data.saleTime < existing.purchaseTime) {
        return res.status(400).json({
          error: 'Sale time must be greater than or equal to purchase time',
        });
      }
    } else if (data.purchaseTime) {
      // If only purchaseTime is being updated, check against existing saleTime
      const existing = await prisma.agentHistoricalSwap.findUnique({
        where: { id },
        select: { saleTime: true },
      });
      if (existing && existing.saleTime < data.purchaseTime) {
        return res.status(400).json({
          error: 'Sale time must be greater than or equal to purchase time',
        });
      }
    }

    if (updateData.purchaseTransactionId !== undefined) {
      if (updateData.purchaseTransactionId !== null) {
        if (typeof updateData.purchaseTransactionId !== 'string') {
          return res.status(400).json({
            error: 'Purchase transaction ID must be a string or null',
          });
        }

        // Verify transaction exists and belongs to the same agent
        const transaction = await prisma.agentTransaction.findUnique({
          where: { id: updateData.purchaseTransactionId },
          select: { agentId: true },
        });

        if (!transaction) {
          return res.status(404).json({
            error: 'Purchase transaction not found',
          });
        }

        const swap = await prisma.agentHistoricalSwap.findUnique({
          where: { id },
          select: { agentId: true },
        });

        if (swap && transaction.agentId !== swap.agentId) {
          return res.status(400).json({
            error: 'Purchase transaction must belong to the same agent',
          });
        }
        data.purchaseTransaction = { connect: { id: updateData.purchaseTransactionId } };
      } else {
        data.purchaseTransaction = { disconnect: true };
      }
    }

    if (updateData.saleTransactionId !== undefined) {
      if (updateData.saleTransactionId !== null) {
        if (typeof updateData.saleTransactionId !== 'string') {
          return res.status(400).json({
            error: 'Sale transaction ID must be a string or null',
          });
        }

        // Verify transaction exists and belongs to the same agent
        const transaction = await prisma.agentTransaction.findUnique({
          where: { id: updateData.saleTransactionId },
          select: { agentId: true },
        });

        if (!transaction) {
          return res.status(404).json({
            error: 'Sale transaction not found',
          });
        }

        const swap = await prisma.agentHistoricalSwap.findUnique({
          where: { id },
          select: { agentId: true },
        });

        if (swap && transaction.agentId !== swap.agentId) {
          return res.status(400).json({
            error: 'Sale transaction must belong to the same agent',
          });
        }
        data.saleTransaction = { connect: { id: updateData.saleTransactionId } };
      } else {
        data.saleTransaction = { disconnect: true };
      }
    }

    if (updateData.signalId !== undefined) {
      if (updateData.signalId !== null) {
        const parsedSignalId = typeof updateData.signalId === 'string' ? parseInt(updateData.signalId, 10) : updateData.signalId;
        if (typeof parsedSignalId !== 'number' || isNaN(parsedSignalId)) {
          return res.status(400).json({
            error: 'Signal ID must be a valid integer or null',
          });
        }

        // Verify signal exists
        const signal = await prisma.tradingSignal.findUnique({
          where: { id: parsedSignalId },
        });

        if (!signal) {
          return res.status(404).json({
            error: 'Trading signal not found',
          });
        }
        data.signal = { connect: { id: parsedSignalId } };
      } else {
        data.signal = { disconnect: true };
      }
    }

    if (updateData.closeReason !== undefined) {
      if (updateData.closeReason !== null) {
        const validReasons = ['manual', 'stop_loss', 'stale_trade', 'signal_replace', 'take_profit'];
        if (!validReasons.includes(updateData.closeReason)) {
          return res.status(400).json({
            error: `Close reason must be one of: ${validReasons.join(', ')}`,
          });
        }
      }
      data.closeReason = updateData.closeReason;
    }

    // Update swap
    const swap = await prisma.agentHistoricalSwap.update({
      where: { id },
      data,
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
    });

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
      closeReason: (swap.closeReason as 'manual' | 'stop_loss' | 'stale_trade' | null) || null,
      createdAt: swap.createdAt,
    };

    res.json(response);
  } catch (error) {
    console.error('Update agent historical swap error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

