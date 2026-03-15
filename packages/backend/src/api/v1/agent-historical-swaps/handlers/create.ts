/**
 * Create agent historical swap endpoint
 * 
 * POST /api/agent-historical-swaps
 * 
 * Creates a new agent historical swap record.
 * Requires authentication. Users can only create swaps for their own agents.
 */

import { Response } from 'express';
import { prisma } from '@/infrastructure/database/client.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import type { CreateAgentHistoricalSwapRequest, AgentHistoricalSwapResponse } from '../types.js';
import { Decimal } from '@prisma/client/runtime/library';
import { getDefaultWalletForAgent, validateWalletBelongsToAgent } from '../../wallets/helpers.js';

/**
 * Create a new agent historical swap
 * 
 * Body: { agentId, tokenAddress, tokenSymbol, amount, purchasePrice, salePrice, ... }
 * Returns: { id, agentId, tokenAddress, tokenSymbol, ... }
 */
export async function createAgentHistoricalSwap(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const {
      agentId,
      walletAddress,
      tokenAddress,
      tokenSymbol,
      amount,
      purchasePrice,
      salePrice,
      changePercent,
      profitLossUsd,
      profitLossSol,
      purchaseTime,
      saleTime,
      purchaseTransactionId,
      saleTransactionId,
      signalId,
      closeReason,
    }: CreateAgentHistoricalSwapRequest = req.body;

    // Validate required fields
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({
        error: 'Agent ID is required',
      });
    }

    // Verify agent belongs to the authenticated user
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { userId: true },
    });

    if (!agent) {
      return res.status(404).json({
        error: 'Agent not found',
      });
    }

    if (agent.userId !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden: You can only create swaps for your own agents',
      });
    }

    // Determine walletAddress - use provided one or get default based on agent's trading mode
    let finalWalletAddress: string | null = walletAddress || null;
    if (!finalWalletAddress) {
      finalWalletAddress = await getDefaultWalletForAgent(agentId);
    } else {
      // Validate that the provided walletAddress belongs to the agent
      const isValid = await validateWalletBelongsToAgent(finalWalletAddress, agentId);
      if (!isValid) {
        return res.status(400).json({
          error: 'Wallet does not belong to the specified agent',
        });
      }
    }

    // Validate required string fields
    if (!tokenAddress || typeof tokenAddress !== 'string' || tokenAddress.trim().length === 0) {
      return res.status(400).json({
        error: 'Token address is required',
      });
    }

    if (tokenAddress.length > 255) {
      return res.status(400).json({
        error: 'Token address must be 255 characters or less',
      });
    }

    if (!tokenSymbol || typeof tokenSymbol !== 'string' || tokenSymbol.trim().length === 0) {
      return res.status(400).json({
        error: 'Token symbol is required',
      });
    }

    if (tokenSymbol.length > 20) {
      return res.status(400).json({
        error: 'Token symbol must be 20 characters or less',
      });
    }

    // Validate decimal fields
    if (amount === undefined || amount === null) {
      return res.status(400).json({
        error: 'Amount is required',
      });
    }

    const amountDecimal = new Decimal(amount.toString());
    if (amountDecimal.lt(0)) {
      return res.status(400).json({
        error: 'Amount must be non-negative',
      });
    }

    if (purchasePrice === undefined || purchasePrice === null) {
      return res.status(400).json({
        error: 'Purchase price is required',
      });
    }

    const purchasePriceDecimal = new Decimal(purchasePrice.toString());
    if (purchasePriceDecimal.lte(0)) {
      return res.status(400).json({
        error: 'Purchase price must be positive',
      });
    }

    if (salePrice === undefined || salePrice === null) {
      return res.status(400).json({
        error: 'Sale price is required',
      });
    }

    const salePriceDecimal = new Decimal(salePrice.toString());
    if (salePriceDecimal.lte(0)) {
      return res.status(400).json({
        error: 'Sale price must be positive',
      });
    }

    if (changePercent === undefined || changePercent === null) {
      return res.status(400).json({
        error: 'Change percent is required',
      });
    }

    const changePercentDecimal = new Decimal(changePercent.toString());

    if (profitLossUsd === undefined || profitLossUsd === null) {
      return res.status(400).json({
        error: 'Profit/loss USD is required',
      });
    }

    const profitLossUsdDecimal = new Decimal(profitLossUsd.toString());

    if (profitLossSol === undefined || profitLossSol === null) {
      return res.status(400).json({
        error: 'Profit/loss SOL is required',
      });
    }

    const profitLossSolDecimal = new Decimal(profitLossSol.toString());

    // Validate time fields
    if (!purchaseTime) {
      return res.status(400).json({
        error: 'Purchase time is required',
      });
    }

    const purchaseTimeDate = new Date(purchaseTime);
    if (isNaN(purchaseTimeDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid purchase time format (use ISO date string)',
      });
    }

    if (!saleTime) {
      return res.status(400).json({
        error: 'Sale time is required',
      });
    }

    const saleTimeDate = new Date(saleTime);
    if (isNaN(saleTimeDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid sale time format (use ISO date string)',
      });
    }

    // Validate sale_time >= purchase_time
    if (saleTimeDate < purchaseTimeDate) {
      return res.status(400).json({
        error: 'Sale time must be greater than or equal to purchase time',
      });
    }

    // Validate transaction IDs if provided
    if (purchaseTransactionId !== undefined && purchaseTransactionId !== null) {
      if (typeof purchaseTransactionId !== 'string') {
        return res.status(400).json({
          error: 'Purchase transaction ID must be a string',
        });
      }

      // Verify transaction exists and belongs to the same agent
      const transaction = await prisma.agentTransaction.findUnique({
        where: { id: purchaseTransactionId },
        select: { agentId: true },
      });

      if (!transaction) {
        return res.status(404).json({
          error: 'Purchase transaction not found',
        });
      }

      if (transaction.agentId !== agentId) {
        return res.status(400).json({
          error: 'Purchase transaction must belong to the same agent',
        });
      }
    }

    if (saleTransactionId !== undefined && saleTransactionId !== null) {
      if (typeof saleTransactionId !== 'string') {
        return res.status(400).json({
          error: 'Sale transaction ID must be a string',
        });
      }

      // Verify transaction exists and belongs to the same agent
      const transaction = await prisma.agentTransaction.findUnique({
        where: { id: saleTransactionId },
        select: { agentId: true },
      });

      if (!transaction) {
        return res.status(404).json({
          error: 'Sale transaction not found',
        });
      }

      if (transaction.agentId !== agentId) {
        return res.status(400).json({
          error: 'Sale transaction must belong to the same agent',
        });
      }
    }

    // Validate signal ID if provided
    let parsedSignalId: number | null = null;
    if (signalId !== undefined && signalId !== null) {
      parsedSignalId = typeof signalId === 'string' ? parseInt(signalId, 10) : signalId;
      if (typeof parsedSignalId !== 'number' || isNaN(parsedSignalId)) {
        return res.status(400).json({
          error: 'Signal ID must be a valid integer',
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
    }

    // Validate closeReason if provided
    if (closeReason !== undefined && closeReason !== null) {
      const validReasons = ['manual', 'stop_loss', 'stale_trade', 'signal_replace', 'take_profit'];
      if (!validReasons.includes(closeReason)) {
        return res.status(400).json({
          error: `Close reason must be one of: ${validReasons.join(', ')}`,
        });
      }
    }

    // Create historical swap
    const swap = await prisma.agentHistoricalSwap.create({
      data: {
        agentId,
        walletAddress: finalWalletAddress,
        tokenAddress: tokenAddress.trim(),
        tokenSymbol: tokenSymbol.trim(),
        amount: amountDecimal,
        purchasePrice: purchasePriceDecimal,
        salePrice: salePriceDecimal,
        changePercent: changePercentDecimal,
        profitLossUsd: profitLossUsdDecimal,
        profitLossSol: profitLossSolDecimal,
        purchaseTime: purchaseTimeDate,
        saleTime: saleTimeDate,
        purchaseTransactionId: purchaseTransactionId || null,
        saleTransactionId: saleTransactionId || null,
        signalId: parsedSignalId,
        closeReason: closeReason || null,
      },
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
      signalId: swap.signalId?.toString() || null,
      closeReason: (swap.closeReason as 'manual' | 'stop_loss' | 'stale_trade' | null) || null,
      createdAt: swap.createdAt,
    };

    res.status(201).json(response);
  } catch (error) {
    console.error('Create agent historical swap error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

