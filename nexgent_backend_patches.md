# Nexgent Backend Patches

Changes to `nexgent-open-source-trading-engine` required for paper trading integration.

**Recommended order:** configure the UI first (no code changes), then apply backend patches
only if the UI feature is unavailable or a custom backend is being deployed.

1. Configure **Manual Stop Loss Levels** in agent dashboard (§ below) — ratchet SL (replaces B1+B2+B5)
2. Apply **B3 + B4** — position size multiplier (requires backend code change)
3. Apply **B6 + B7 + B8** — signal score storage + positions endpoint
4. Apply **B9** — capital-aware signal routing (position replacement)
5. Apply corresponding **Signal Engine changes** (§ below) — send `expectedMovePct` in payload
6. Configure agent via dashboard JSON (§ Nexgent Agent Configuration)

---

## Simulation Parity Gap Analysis

The table below maps every exit rule from `simulate_pnl.py` (canonical V7 config, +193 SOL
on 10 SOL capital) to its backend status. Rows marked ❌ are the missing features.

| # | Feature | Simulation behaviour | Backend status |
|---|---------|---------------------|----------------|
| 1 | **Cascade ratchet SL** | stop stays at −10% after TP1; lifts to +7% (TP1 price) after TP2; lifts to +15% (TP2 price) after TP3 | ✅ Use **Manual Stop Loss Levels** UI (see §Manual Stop Loss Levels below) |
| 2 | **Position size multiplier** | Capital scaled 0.5×–2× per signal via magnitude regressor | ❌ Field ignored — requires B3 + B4 |
| 3 | **Fixed (non-trailing) initial stop** | Hard stop sits exactly at entry × 0.90 until TP1 hits; never tightens | ⚠️ Verify `stopLoss.mode = "fixed"` truly does not trail before TP1 |
| 4 | **LOW wick trigger for initial hard stop** | Phase 0 stop fires when bar LOW ≤ stop price | ⚠️ Nexgent checks tick price (approximates LOW in live trading — acceptable for paper) |
| 5 | **CLOSE trigger for ratchet floors** | Phase 1+ ratchet fires only when bar CLOSE ≤ floor (not on wick) | ⚠️ Requires B1 to implement; verify backend uses close price not tick for floor checks |
| 6 | **Moonbag held indefinitely** | 25% residual after TP3 runs forever; only exits when TP2 floor (entry × 1.15) breached on CLOSE | ⚠️ Verify no time-based auto-close on moonbag positions in Nexgent |
| 7 | **TP triggered on HIGH wick** | TP fires when bar HIGH ≥ TP price | ✅ Tick-based price check approximates this correctly in live trading |
| 8 | **6h per-token cooldown** | No re-entry within 6h of a signal | ✅ Enforced in `NexgentClient._last_sent`; Nexgent 409 dedup is a second layer |
| 9 | **TP levels + sell fractions** | TP1=+7%/25%, TP2=+15%/25%, TP3=+25%/25%, moonbag=25% | ✅ Set in agent config |
| 10 | **`signalStrength` filtering** | quality_score 0–5 forwarded as `signalStrength`; engine filters via `minScore` | ✅ Agent config `signals.minScore = 4` |
| 11 | **Capital-aware signal routing** | New signal replaces weakest held position when capital is full | ❌ Requires B9 |

### Cascade Ratchet — Phase Details (n−1 rule)

```
Phase 0  (0 TPs hit)   : stop = entry × 0.90   | hard stop at −10%
Phase 1  (TP1 hit)     : stop = entry × 0.90   | still −10%, no ratchet yet
Phase 2  (TP2 hit)     : floor = entry × 1.07  | ratchets to TP1 price (+7%)
Phase 3  (TP3 hit)     : floor = entry × 1.15  | ratchets to TP2 price (+15%)
Moonbag  (after TP3)   : floor = entry × 1.15  | held indefinitely until floor breached
```

**N−1 rule:** when TP_n hits, the stop floor ratchets to TP_(n−1) price. TP1 is the
exception — no ratchet occurs at TP1; the initial hard stop holds until TP2 fires.

Without a ratchet floor the moonbag has no protection and can give back 100% of
accumulated profit. The cascade ratchet accounts for +129.5 of the +130 SOL total
simulation P&L.

---

## Manual Stop Loss Levels (agent-level UI — replaces B1 + B2 + B5)

The Nexgent dashboard exposes a **Manual Stop Loss Levels** panel that implements the
n−1 ratchet without any code patches.  Each level defines: *"when price increases by
X%, set stop loss to lock in Y% profit"*.  Levels must be sorted **descending** by price
increase %.

### Values to enter

| Price Increase % | Stop Loss % | Meaning |
|-----------------|------------|---------|
| 25              | 15         | TP3 hit (+25%) → floor ratchets to TP2 price (+15%) |
| 15              | 7          | TP2 hit (+15%) → floor ratchets to TP1 price (+7%)  |

> **Delete any placeholder entries** (e.g. the default 20/10 example) before saving.

The initial stop loss (−10% hard stop in Phase 0/1) remains set via the agent's
`stopLoss.defaultPercentage: -10`.

### How this maps to the simulation phases

```
Nexgent initial SL (defaultPercentage: -10) → Phase 0/1: stop = entry × 0.90
Manual level  Price=15%, SL=7%              → Phase 2   : floor = entry × 1.07
Manual level  Price=25%, SL=15%             → Phase 3   : floor = entry × 1.15
```

B1, B2, and B5 are **not required** if the Manual Stop Loss Levels UI is available and
working.  Leave them in this document for reference in case a custom backend is deployed.

---

## B5 — Prisma schema: add `stopLossFloorPrice` to Position

**File:** `packages/backend/src/infrastructure/database/schema.prisma`

```diff
 model Position {
   id              String   @id @default(cuid())
   // ... existing fields ...
   stopLossPrice   Float?
+  stopLossFloorPrice Float?    // Cascade ratchet: SL cannot go below this floor
   // ... rest of fields ...
 }
```

After editing, run:
```bash
npx prisma migrate dev --name add_stop_loss_floor
```

---

## B1 — Stop-loss manager: add `setFloor()` method

**File:** `packages/backend/src/domain/trading/stop-loss-manager.service.ts`

Add the `setFloor()` method and update the SL evaluation to respect the floor:

```typescript
// Add this method to StopLossManagerService:

/**
 * Set a minimum stop-loss floor for a position.
 * The effective SL can never drop below this floor regardless of trailing logic.
 * Called after each TP level executes (cascade ratchet).
 */
async setFloor(positionId: string, floorPrice: number): Promise<void> {
  await this.prisma.position.update({
    where: { id: positionId },
    data:  { stopLossFloorPrice: floorPrice },
  });
  this.logger.log(
    `SL floor set for ${positionId}: ${floorPrice.toFixed(8)}`
  );
}

// In the existing SL evaluation logic (wherever currentPrice <= stopLossPrice
// is checked), replace the raw stopLossPrice with the floor-aware effective price:

private effectiveStopPrice(position: Position): number {
  const raw   = position.stopLossPrice ?? 0;
  const floor = position.stopLossFloorPrice ?? 0;
  return Math.max(raw, floor);
}
```

Update every place that reads `position.stopLossPrice` to call
`this.effectiveStopPrice(position)` instead.

> **Note on trigger price:** The simulation uses bar CLOSE (not tick/wick) for ratchet
> floor checks in phase 1+. If the backend evaluates SL on every price tick, consider
> adding a `closeOnly` flag or evaluating the floor against the last confirmed close
> candle to match simulation behaviour.

---

## B2 — Take-profit manager: call `setFloor()` after each TP executes

**File:** `packages/backend/src/domain/trading/take-profit-manager.service.ts`

After the existing TP execution block, add the ratchet call:

```typescript
// After TP level N executes (inside executeTakeProfitSale or equivalent).
//
// N−1 rule: when TP_n hits, ratchet floor to TP_(n-1) price.
// TP1 (levelIndex 0) is the exception — no ratchet; initial hard stop holds.

if (levelIndex === 1) {
  // TP2 hit → raise SL floor to TP1 price (+7% from entry)  [n−1 rule]
  const tp1Level  = levels[0]; // TP1 config
  const tp1Price  = position.purchasePrice * (1 + tp1Level.targetPercent / 100);
  await this.stopLossManager.setFloor(position.id, tp1Price);
}
if (levelIndex === 2) {
  // TP3 hit → raise SL floor to TP2 price (+15% from entry) [n−1 rule]
  const tp2Level  = levels[1]; // TP2 config
  const tp2Price  = position.purchasePrice * (1 + tp2Level.targetPercent / 100);
  await this.stopLossManager.setFloor(position.id, tp2Price);
}
// TP3+ (moonbag): floor stays at TP2 price — held indefinitely until floor is breached.
```

This implements the simulation n−1 rule:
- Phase 0 (no TPs hit):  hard stop at entry × 0.90
- Phase 1 (TP1 hit):     stop stays at entry × 0.90  — no ratchet
- Phase 2 (TP2 hit):     SL floor lifts to entry × 1.07  (TP1 price)
- Phase 3 (TP3 hit):     SL floor lifts to entry × 1.15  (TP2 price)
- Moonbag:               floor stays at entry × 1.15 with no time-based close

---

## B3 — Signal schema: add `positionSizeMultiplier`

**File:** `packages/backend/src/api/v1/trading-signals.ts`

Extend the Zod schema with an optional multiplier field:

```typescript
// In the signal Zod schema (where tokenAddress, signalType, etc. are defined):

positionSizeMultiplier: z.number().min(0.25).max(4.0).optional(),
```

---

## B4 — Trading executor: apply the multiplier in `executePurchase`

**File:** `packages/backend/src/domain/trading/trading-executor.service.ts`

After the base `purchaseAmount` is calculated (before executing the swap):

```typescript
// Apply magnitude-based position sizing if provided in the signal
if (
  signal.positionSizeMultiplier !== undefined &&
  signal.positionSizeMultiplier !== 1.0
) {
  purchaseAmount = Math.min(
    purchaseAmount * signal.positionSizeMultiplier,
    config.purchaseLimits.maxPurchasePerToken,
  );
  this.logger.log(
    `Position size scaled by ${signal.positionSizeMultiplier}× → ${purchaseAmount} SOL`,
  );
}
```

---

## B6 — Accept + validate `signalScore` in signal intake (TypeScript)

**File:** wherever `POST /api/v1/trading-signals` Zod schema is defined.

Add optional fields to the Zod schema:

```typescript
signalScore: z.number().min(0).max(1).optional(),
scoreComponents: z.object({
  s1Pct:          z.number().min(0).max(1),
  s2Slope:        z.number(),
  qualityTier:    z.number().int().min(0).max(5),
  expectedMovePct: z.number().optional(),  // raw magnitude regressor output in %
                                           // e.g. 18.5 means model predicts +18.5% move
}).optional(),
```

> **Note:** `expectedMovePct` is the raw predicted move percentage from the magnitude
> regressor (e.g. `18.5` = model predicts a +18.5% move). It is distinct from
> `positionSizeMultiplier` which is a derived capital-scaling factor. Both are sent
> by the signal engine; `expectedMovePct` is needed by B9 to compute magnitude consumed
> without requiring the backend to know any signal engine constants.

---

## B7 — Persist `signalScore` and `expectedMovePct` on Position (TypeScript)

**File:** `prisma/schema.prisma` — add to the `Position` (or `Signal`) model:

```prisma
signalScore      Float?   // composite quality score [0, 1] from signal engine
expectedMovePct  Float?   // magnitude regressor prediction in % (e.g. 18.5 = +18.5%)
                          // null for positions opened before this patch
```

Run: `npx prisma migrate dev --name add_signal_score_and_expected_move`

**File:** the handler that creates a position from a signal — store both values:

```typescript
signalScore:     body.signalScore                         ?? null,
expectedMovePct: body.scoreComponents?.expectedMovePct    ?? null,
```

---

## B8 — `GET /api/v1/positions?status=active` endpoint (TypeScript)

Create (or extend) an endpoint that returns all active positions with live P&L,
the stored `signalScore`, and `expectedMovePct`. These fields are consumed by B9
to compute remaining value for position replacement decisions.

**Auth:** same `x-api-key` header as the signal intake endpoint.

**Response shape per position:**

```typescript
{
  id:               string;        // position ID
  tokenAddress:     string;
  symbol:           string;
  entryPrice:       number;
  currentPrice:     number;        // latest price from price feed or last known
  unrealizedPnlPct: number;        // ((currentPrice - entryPrice) / entryPrice) * 100
  openedAt:         string;        // ISO 8601
  stopLoss:         number;        // absolute price level
  tp1:              number;        // absolute TP1 price (entry × 1.07)
  tp2:              number;        // absolute TP2 price (entry × 1.15)
  tp3:              number;        // absolute TP3 price (entry × 1.25)
  signalScore:      number | null; // null for positions opened before B7
  expectedMovePct:  number | null; // null for positions opened before B7
}
```

**Handler skeleton:**

```typescript
router.get("/positions", requireApiKey, async (req, res) => {
  const status = req.query.status ?? "active";
  const positions = await prisma.position.findMany({
    where: { status: status as string },
    orderBy: { openedAt: "desc" },
  });

  const enriched = await Promise.all(
    positions.map(async (p) => {
      const currentPrice = await getLatestPrice(p.tokenAddress); // use your price feed
      const unrealizedPnlPct =
        ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
      return {
        id:               p.id,
        tokenAddress:     p.tokenAddress,
        symbol:           p.symbol,
        entryPrice:       p.entryPrice,
        currentPrice,
        unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
        openedAt:         p.openedAt.toISOString(),
        stopLoss:         p.stopLoss,
        tp1:              p.tp1,
        tp2:              p.tp2,
        tp3:              p.tp3,
        signalScore:      p.signalScore     ?? null,
        expectedMovePct:  p.expectedMovePct ?? null,
      };
    })
  );

  res.json(enriched);
});
```

---

## B9 — Capital-aware signal routing (position replacement)

When the agent has no free capital and a new signal arrives, the backend decides
whether the incoming signal is strong enough to replace the weakest currently held
position. This keeps the portfolio fully deployed in the highest-conviction trades
rather than missing opportunities due to capital lock.

**Decision is made entirely on the backend** — the signal engine's only
responsibility is to send an accurate `signalScore` and `expectedMovePct`. The
backend has atomic access to all position state and can close + open in one flow
without race conditions.

### Config flags (add to agent config or env)

```typescript
const REPLACEMENT_MARGIN        = 0.10;   // new signal must beat weakest by this margin
const REPLACEMENT_REQUIRE_SCORE = true;   // set false after legacy positions have cleared
```

`REPLACEMENT_MARGIN` prevents churn — a marginal improvement is not enough to
justify closing a position and paying swap fees.

`REPLACEMENT_REQUIRE_SCORE` is a transition flag for backward compatibility
(see §Legacy Positions below).

### Remaining value function

Computes how much residual value a currently held position has, on a [0, 1] scale.
Three factors degrade the entry score over time:

- **Time decay:** onset signal degrades linearly to zero over 6 hours
- **Magnitude consumed:** as unrealized P&L approaches the predicted move, upside shrinks
- **Entry score:** positions entered on a weaker signal start with a lower ceiling

```typescript
function remainingValue(position: ActivePosition, now: Date): number {
  // --- Legacy position guard (see §Legacy Positions) ---
  if (REPLACEMENT_REQUIRE_SCORE && position.signalScore == null) {
    return 1.0; // treat as maximum value — never the weakest candidate
  }

  const entryScore = position.signalScore ?? 0.5; // neutral fallback if flag is off

  // Time decay: signal degrades to 0 at 6 hours open
  const hoursOpen  = (now.getTime() - new Date(position.openedAt).getTime()) / 3_600_000;
  const timeFactor = Math.max(0.0, 1.0 - hoursOpen / 6.0);

  // Magnitude consumed: how much of the predicted move has already been captured?
  // expectedMovePct fallback: back-calculate from TP3 price (always available).
  // TP3 = entry × 1.25, so tp3TargetPct ≈ 25% — a reliable proxy for the full
  // expected move even for positions that pre-date B7.
  const expectedMovePct =
    position.expectedMovePct ??
    ((position.tp3 - position.entryPrice) / position.entryPrice) * 100;

  const consumed = Math.min(
    Math.max(position.unrealizedPnlPct / expectedMovePct, 0.0),
    1.0,
  );

  return entryScore * timeFactor * (1.0 - consumed);
}
```

### Integration point — signal intake handler

Insert this block in the `POST /api/v1/trading-signals` handler, **after** signal
validation and **before** `executePurchase` is called:

```typescript
// Capital-aware routing: replace weakest position if capital is full
const capitalAvailable = await isCapitalAvailable(agentConfig); // use existing method

if (!capitalAvailable) {
  const activePositions = await getActivePositionsWithPnl(); // same query as B8
  const now = new Date();

  const scored = activePositions.map((p) => ({
    position: p,
    rv: remainingValue(p, now),
  }));
  const weakest = scored.sort((a, b) => a.rv - b.rv)[0];

  const incomingScore = body.signalScore ?? 0.0;

  if (incomingScore > weakest.rv + REPLACEMENT_MARGIN) {
    this.logger.log(
      `Capital full: replacing ${weakest.position.symbol} ` +
      `(rv=${weakest.rv.toFixed(3)}) with ${body.symbol} ` +
      `(score=${incomingScore.toFixed(3)})`,
    );
    await closePosition(weakest.position.id, "replaced_by_higher_score_signal");
    // fall through — executePurchase opens the new position normally
  } else {
    this.logger.log(
      `Signal suppressed: ${body.symbol} score=${incomingScore.toFixed(3)} ` +
      `does not beat weakest rv=${weakest.rv.toFixed(3)} + margin=${REPLACEMENT_MARGIN}`,
    );
    return res.status(200).json({
      status: "suppressed",
      reason: "capital_locked_score_insufficient",
      weakestSymbol:    weakest.position.symbol,
      weakestRv:        Math.round(weakest.rv * 10000) / 10000,
      incomingScore,
    });
  }
}
```

> **Note:** `closePosition(id, reason)` should trigger a market sell of the full
> remaining position size and mark it `status = "closed"` in the DB. Implement using
> whatever position-close flow already exists in the trading executor.

### Legacy positions — backward compatibility

Positions opened **before B7 is deployed** will have `signalScore = null` and
`expectedMovePct = null`.

| Field | Fallback used |
|---|---|
| `expectedMovePct` | Back-calculated from TP3 price: `((tp3 - entryPrice) / entryPrice) * 100`. Always available — no data gap. |
| `signalScore` | Controlled by `REPLACEMENT_REQUIRE_SCORE` flag (see below). |

**`REPLACEMENT_REQUIRE_SCORE = true` (default — ship this first)**
Legacy positions (`signalScore = null`) return `remainingValue = 1.0` and are
never candidates for replacement. This is the safe default during the transition
period: you cannot accidentally close a position you have no score context for.

**`REPLACEMENT_REQUIRE_SCORE = false` (flip once legacy positions have cleared)**
Legacy positions use `signalScore = 0.5` (neutral). They become eligible for
replacement based purely on time decay and magnitude consumed. Flip this flag once
you are confident all pre-B7 positions have closed through normal TP/SL execution —
at that point, every active position will have a real score.

---

## Signal Engine Changes Required

These changes must be applied to `nexgent-signal-live` alongside the backend patches.
They are listed here so the agent applying backend patches is aware of the full contract.

### 1. `signal_engine/output/nexgent.py` — add `expected_move_pct` to payload

Add `expected_move_pct: float = 0.0` parameter to `NexgentClient.send()` and
include it in `scoreComponents`:

```python
# In NexgentClient.send() signature:
expected_move_pct: float = 0.0,

# In the payload dict, update scoreComponents:
"scoreComponents": {
    "s1Pct":          round(s1_score, 4),
    "s2Slope":        round(s2_slope, 6),
    "qualityTier":    signal_strength,
    "expectedMovePct": round(expected_move_pct, 2),
},
```

### 2. `live/live_signal_runner.py` — pass `mag_pred` to `nexgent.send()`

In `run_s2_cycle()`, `mag_pred` is already computed as
`window.size_multiplier * MAG_BASELINE_PCT`. Pass it through:

```python
nexgent.send(
    token_address     = mint,
    symbol            = symbol,
    s1_score          = window.s1_pct_score,
    s2_slope          = slope,
    signal_strength   = window.quality_score,
    size_multiplier   = window.size_multiplier,
    signal_score      = signal_score,
    expected_move_pct = mag_pred,   # <-- add this
    reason            = reason,
    dry_run           = dry_run,
)
```

---

## Nexgent Agent Configuration (set once via dashboard/API)

```json
{
  "takeProfit": {
    "enabled": true,
    "mode": "custom",
    "levels": [
      { "targetPercent": 7,  "sellPercent": 25 },
      { "targetPercent": 15, "sellPercent": 25 },
      { "targetPercent": 25, "sellPercent": 25 }
    ],
    "moonBag": {
      "enabled": true,
      "triggerPercent": 25,
      "retainPercent": 25
    }
  },
  "stopLoss": {
    "enabled": true,
    "defaultPercentage": -10,
    "mode": "fixed"
  },
  "purchaseLimits": {
    "maxPurchasePerToken": 4.0,
    "maxPriceImpact": 0.03,
    "minimumAgentBalance": 0.5
  },
  "signals": {
    "minScore": 4,
    "allowedSignalTypes": ["ONSET_DETECTED"],
    "tokenFilterMode": "none"
  }
}
```

> **Verify:** `stopLoss.mode = "fixed"` must mean the stop sits exactly at
> `entry × 0.90` and does not tighten before TP1 hits. If Nexgent trails
> the stop upward as price rises, positions will be exited prematurely and
> the moonbag/ratchet logic will never engage.

> **Verify:** Confirm there is no maximum hold duration on moonbag positions.
> The simulation holds the 25% residual indefinitely until the TP2 ratchet
> floor (entry × 1.15) is breached. Any time-based auto-close would diverge
> from the simulation baseline.

---

## Build Order

1. Apply B5 (schema) → `npx prisma migrate dev --name add_stop_loss_floor`
2. Apply B1 (`setFloor` method + `effectiveStopPrice`) → restart backend
3. Apply B2 (ratchet trigger after each TP) → restart backend
4. Apply B3 + B4 (signal multiplier schema + executor) → restart backend
5. Apply B6 (extend scoreComponents schema with `expectedMovePct`)
6. Apply B7 (persist `signalScore` + `expectedMovePct`) → `npx prisma migrate dev --name add_signal_score_and_expected_move` → restart backend
7. Apply B8 (positions endpoint, return `expectedMovePct`) → restart backend
8. Apply B9 (capital-aware routing, `remainingValue`, replacement logic) → restart backend
9. Apply Signal Engine changes (`nexgent.py` + `live_signal_runner.py`) → redeploy signal engine
10. Configure agent via dashboard with JSON above
11. Set `NEXGENT_API_KEY` + `NEXGENT_API_URL` in `.env`
12. `python live/live_signal_runner.py --dry-run` — verify `expectedMovePct` appears in payload logs
13. `python live/live_signal_runner.py` — enable live posting
14. Monitor `data/live/signal_log.csv` and backend logs for replacement events
15. Once all pre-B7 positions have closed, flip `REPLACEMENT_REQUIRE_SCORE = false` in B9
