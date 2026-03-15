/**
 * Create trading signal endpoint
 * 
 * POST /api/trading-signals
 * 
 * Creates a new trading signal scoped to the authenticated user.
 * Requires authentication via API key (signals scope) or JWT.
 */

import { Response } from 'express';
import { prisma } from '@/infrastructure/database/client.js';
import { signalEventEmitter } from '@/domain/signals/signal-events.js';
import { idempotencyService } from '@/infrastructure/cache/idempotency-service.js';
import { REDIS_KEYS, REDIS_TTL } from '@/shared/constants/redis-keys.js';
import type { AuthenticatedRequest } from '@/middleware/auth.js';
import type { CreateTradingSignalRequest, TradingSignalResponse } from '../types.js';

/**
 * Create a new trading signal
 * 
 * Body: { tokenAddress: string, signalType: string, activationReason?: string, signalStrength: number }
 * Returns: { id, createdAt, updatedAt, tokenAddress, signalType, activationReason, signalStrength }
 */
export async function createTradingSignal(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const { tokenAddress, symbol, signalType, activationReason, signalStrength, source, positionSizeMultiplier, signalScore, scoreComponents }: CreateTradingSignalRequest = req.body;

    // Validate input
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

    if (!signalType || typeof signalType !== 'string' || signalType.trim().length === 0) {
      return res.status(400).json({
        error: 'Signal type is required',
      });
    }

    if (signalType.length > 50) {
      return res.status(400).json({
        error: 'Signal type must be 50 characters or less',
      });
    }

    if (typeof signalStrength !== 'number' || !Number.isInteger(signalStrength)) {
      return res.status(400).json({
        error: 'Signal strength must be an integer',
      });
    }

    if (signalStrength < 1 || signalStrength > 5) {
      return res.status(400).json({
        error: 'Signal strength must be between 1 and 5',
      });
    }

    // Validate symbol if provided
    if (symbol !== undefined && symbol !== null) {
      if (typeof symbol !== 'string') {
        return res.status(400).json({
          error: 'Symbol must be a string',
        });
      }
      if (symbol.length > 50) {
        return res.status(400).json({
          error: 'Symbol must be 50 characters or less',
        });
      }
    }

    // Validate activationReason if provided
    if (activationReason !== undefined && activationReason !== null) {
      if (typeof activationReason !== 'string') {
        return res.status(400).json({
          error: 'Activation reason must be a string',
        });
      }
    }

    // Validate source if provided
    if (source !== undefined && source !== null) {
      if (typeof source !== 'string') {
        return res.status(400).json({
          error: 'Source must be a string',
        });
      }
      if (source.length > 100) {
        return res.status(400).json({
          error: 'Source must be 100 characters or less',
        });
      }
    }

    // Validate positionSizeMultiplier if provided
    // Range [0, 1]: used as proportion in size = min + mult × (max - min)
    if (positionSizeMultiplier !== undefined && positionSizeMultiplier !== null) {
      if (typeof positionSizeMultiplier !== 'number' || !isFinite(positionSizeMultiplier)) {
        return res.status(400).json({ error: 'positionSizeMultiplier must be a number' });
      }
      if (positionSizeMultiplier < 0 || positionSizeMultiplier > 1.0) {
        return res.status(400).json({ error: 'positionSizeMultiplier must be between 0 and 1' });
      }
    }

    // Validate signalScore if provided (B6)
    if (signalScore !== undefined && signalScore !== null) {
      if (typeof signalScore !== 'number' || !isFinite(signalScore)) {
        return res.status(400).json({ error: 'signalScore must be a number' });
      }
      if (signalScore < 0 || signalScore > 1) {
        return res.status(400).json({ error: 'signalScore must be between 0 and 1' });
      }
    }

    // Extract expectedMovePct from scoreComponents (B6)
    let expectedMovePct: number | undefined;
    if (scoreComponents !== undefined && scoreComponents !== null) {
      if (typeof scoreComponents !== 'object' || Array.isArray(scoreComponents)) {
        return res.status(400).json({ error: 'scoreComponents must be an object' });
      }
      if (scoreComponents.expectedMovePct !== undefined) {
        if (typeof scoreComponents.expectedMovePct !== 'number' || !isFinite(scoreComponents.expectedMovePct)) {
          return res.status(400).json({ error: 'scoreComponents.expectedMovePct must be a number' });
        }
        expectedMovePct = scoreComponents.expectedMovePct;
      }
    }

    // Deduplicate: reject duplicate signals for same token+type+strength within a short window
    const normalizedToken = tokenAddress.trim();
    const dedupeKey = REDIS_KEYS.SIGNAL_CREATION_DEDUPE(req.user.id, normalizedToken, signalType.trim(), signalStrength);
    const canCreate = await idempotencyService.checkAndSet(dedupeKey, REDIS_TTL.SIGNAL_CREATION_DEDUPE);
    if (!canCreate) {
      return res.status(409).json({
        error: 'A signal for this token was already created recently. Please wait before sending another.',
        code: 'SIGNAL_DUPLICATE',
      });
    }

    // Create trading signal (scoped to the authenticated user)
    const signal = await prisma.tradingSignal.create({
      data: {
        tokenAddress: tokenAddress.trim(),
        symbol: symbol?.trim() || null,
        signalType: signalType.trim(),
        activationReason: activationReason?.trim() || null,
        signalStrength,
        source: source?.trim() || null,
        signalScore: signalScore ?? null,
        positionSizeMultiplier: positionSizeMultiplier ?? null,
        expectedMovePct: expectedMovePct ?? null,
        userId: req.user.id,
      },
    });

    // Emit signal created event for immediate processing
    // This triggers the signal processor to find eligible agents and execute trades
    console.log(`📡 Emitting signal_created event for signal ${signal.id} (${signal.tokenAddress}, type: ${signal.signalType}, strength: ${signal.signalStrength})`);
    signalEventEmitter.emitSignalCreated(signal);
    console.log(`✅ Signal ${signal.id} event emitted, processing should start immediately`);

    const response: TradingSignalResponse = {
      id: signal.id,
      createdAt: signal.createdAt,
      updatedAt: signal.updatedAt,
      tokenAddress: signal.tokenAddress,
      symbol: signal.symbol,
      signalType: signal.signalType,
      activationReason: signal.activationReason,
      signalStrength: signal.signalStrength,
      source: signal.source,
    };

    res.status(201).json(response);
  } catch (error) {
    console.error('Create trading signal error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}

