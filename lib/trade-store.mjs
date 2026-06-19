import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BUY_STATES = new Set(["BUYING", "BOUGHT", "CANCELLED_BUY"]);
const SELL_STATES = new Set(["SELLING", "SOLD", "CANCELLED_SELL"]);
const OPEN_STATES = new Set(["BUYING", "SELLING"]);

function finiteInteger(value, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const integer = Math.floor(parsed);
  return integer >= minimum ? integer : null;
}

export class TradeStore {
  constructor(path) {
    this.path = path;
    this.state = {
      events: [],
      fills: [],
      lots: {},
      realized: [],
      seen: {},
      openOrders: {},
      fillSamples: [],
      lastEventAt: null,
    };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async ingest(payload) {
    const state = String(payload.state || "").toUpperCase();
    const side = BUY_STATES.has(state) ? "buy" : SELL_STATES.has(state) ? "sell" : null;
    const itemId = finiteInteger(payload.itemId, 1);
    const quantity = finiteInteger(payload.deltaQuantity, 1);
    const amount = finiteInteger(payload.deltaSpent, 1);
    const slot = finiteInteger(payload.slot, 0);
    const account = String(payload.account || "default").slice(0, 100);

    if (!side || !itemId || !quantity || !amount || slot === null || slot > 7) {
      throw new Error("Invalid Grand Exchange fill event.");
    }

    const timestamp = payload.timestamp
      ? new Date(payload.timestamp).toISOString()
      : new Date().toISOString();
    const eventId = String(
      payload.eventId ||
        [
          account,
          slot,
          itemId,
          state,
          payload.quantitySold,
          payload.totalSpent,
          timestamp,
        ].join(":"),
    ).slice(0, 300);

    if (this.state.seen[eventId]) {
      return { duplicate: true, eventId };
    }

    const fill = {
      id: eventId,
      account,
      slot,
      itemId,
      side,
      state,
      quantity,
      amount,
      unitPrice: amount / quantity,
      offerPrice: finiteInteger(payload.offerPrice, 0),
      timestamp,
    };

    this.state.seen[eventId] = timestamp;
    this.state.events.push({
      id: eventId,
      account,
      slot,
      itemId,
      state,
      timestamp,
    });
    this.state.fills.push(fill);
    this.state.lastEventAt = timestamp;
    const realized = side === "buy" ? this.addLot(fill) : this.matchSale(fill);
    this.trim();
    await this.persist();

    return { duplicate: false, eventId, fill, realized };
  }

  async ingestOffer(payload) {
    const state = String(payload.state || "").toUpperCase();
    const slot = finiteInteger(payload.slot, 0);
    const account = String(payload.account || "default").slice(0, 100);

    if (slot === null || slot > 7) {
      throw new Error("Invalid Grand Exchange offer event.");
    }

    if (!this.state.openOrders) {
      this.state.openOrders = {};
    }

    const key = `${account}:${slot}`;
    const timestamp = payload.timestamp
      ? new Date(payload.timestamp).toISOString()
      : new Date().toISOString();
    const side = BUY_STATES.has(state) ? "buy" : SELL_STATES.has(state) ? "sell" : null;
    const itemId = finiteInteger(payload.itemId, 1);
    const totalQuantity = finiteInteger(payload.totalQuantity, 0) ?? 0;
    const quantitySold = finiteInteger(payload.quantitySold, 0) ?? 0;
    const offerPrice = finiteInteger(payload.offerPrice, 0) ?? 0;
    const predictedFillHours = Number.isFinite(Number(payload.predictedFillHours))
      ? Number(payload.predictedFillHours)
      : null;
    const isOpen =
      OPEN_STATES.has(state) &&
      side !== null &&
      Boolean(itemId) &&
      totalQuantity > 0 &&
      quantitySold < totalQuantity;

    if (!isOpen) {
      const closing = this.state.openOrders[key];
      if (closing) {
        this.recordFillSample(closing, {
          state,
          quantitySold,
          totalQuantity,
          timestamp,
          side,
          itemId,
        });
        delete this.state.openOrders[key];
        this.state.lastEventAt = timestamp;
        this.trim();
        await this.persist();
        return { cleared: true, key };
      }
      return { cleared: false, key };
    }

    const identity = [account, slot, itemId, offerPrice, totalQuantity].join(":");
    const existing = this.state.openOrders[key];
    const firstSeenAt =
      existing && existing.identity === identity ? existing.firstSeenAt : timestamp;
    const carriedPrediction =
      existing && existing.identity === identity
        ? existing.predictedFillHours ?? null
        : null;

    this.state.openOrders[key] = {
      account,
      slot,
      itemId,
      side,
      state,
      offerPrice,
      quantitySold,
      totalQuantity,
      predictedFillHours: predictedFillHours ?? carriedPrediction,
      identity,
      firstSeenAt,
      updatedAt: timestamp,
    };
    this.state.lastEventAt = timestamp;
    this.trim();
    await this.persist();

    return { open: true, key, firstSeenAt };
  }

  // Records a realized-vs-predicted fill-time sample when a tracked offer reaches
  // a terminal state. Realized duration comes purely from open-order tracking
  // (firstSeenAt -> completion); the predicted hours are whatever the model
  // supplied at placement, so the two can be reconciled to validate the fill model.
  recordFillSample(order, { state, quantitySold, totalQuantity, timestamp, side, itemId }) {
    const firstSeenMs = new Date(order.firstSeenAt).getTime();
    const completedMs = new Date(timestamp).getTime();
    if (
      !Number.isFinite(firstSeenMs) ||
      !Number.isFinite(completedMs) ||
      completedMs < firstSeenMs
    ) {
      return;
    }

    const cancelled = state === "CANCELLED_BUY" || state === "CANCELLED_SELL";
    const filledQuantity = Math.max(order.quantitySold || 0, quantitySold || 0);
    const target = order.totalQuantity || totalQuantity || 0;
    const fullyFilled = !cancelled && target > 0 && filledQuantity >= target;
    const realizedFillHours = (completedMs - firstSeenMs) / 3_600_000;
    const predictedFillHours = Number.isFinite(order.predictedFillHours)
      ? order.predictedFillHours
      : null;

    if (!this.state.fillSamples) {
      this.state.fillSamples = [];
    }
    this.state.fillSamples.push({
      account: order.account,
      itemId: order.itemId ?? itemId ?? null,
      side: order.side ?? side ?? null,
      offerPrice: order.offerPrice ?? null,
      totalQuantity: target || null,
      filledQuantity,
      firstSeenAt: order.firstSeenAt,
      completedAt: timestamp,
      realizedFillHours,
      predictedFillHours,
      fillError:
        predictedFillHours === null ? null : realizedFillHours - predictedFillHours,
      cancelled,
      fullyFilled,
    });
  }

  getSummary() {
    const positions = [];

    for (const [key, lots] of Object.entries(this.state.lots)) {
      const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
      const cost = lots.reduce((sum, lot) => sum + lot.quantity * lot.unitPrice, 0);

      if (quantity > 0) {
        const [account, itemId] = key.split(":");
        positions.push({
          account,
          itemId: Number(itemId),
          quantity,
          cost,
          averageCost: cost / quantity,
        });
      }
    }

    return {
      lastEventAt: this.state.lastEventAt,
      fillCount: this.state.fills.length,
      realizedProfit: this.state.realized.reduce(
        (sum, trade) => sum + trade.profit,
        0,
      ),
      recentFills: this.state.fills.slice(-100).reverse(),
      recentRealized: this.state.realized.slice(-100).reverse(),
      positions: positions.sort((left, right) => right.cost - left.cost),
      openOrders: Object.values(this.state.openOrders || {}).sort(
        (left, right) =>
          new Date(left.firstSeenAt).getTime() - new Date(right.firstSeenAt).getTime(),
      ),
      recentFillSamples: (this.state.fillSamples || []).slice(-100).reverse(),
    };
  }

  addLot(fill) {
    const key = `${fill.account}:${fill.itemId}`;
    const lots = this.state.lots[key] || [];
    lots.push({
      quantity: fill.quantity,
      unitPrice: fill.unitPrice,
      timestamp: fill.timestamp,
    });
    this.state.lots[key] = lots;
    return [];
  }

  matchSale(fill) {
    const key = `${fill.account}:${fill.itemId}`;
    const lots = this.state.lots[key] || [];
    let remaining = fill.quantity;
    let cost = 0;

    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      const matched = Math.min(remaining, lot.quantity);
      cost += matched * lot.unitPrice;
      remaining -= matched;
      lot.quantity -= matched;
      if (lot.quantity === 0) {
        lots.shift();
      }
    }

    this.state.lots[key] = lots;
    const matchedQuantity = fill.quantity - remaining;
    const proceeds = fill.unitPrice * matchedQuantity;
    const realized = {
      id: fill.id,
      account: fill.account,
      itemId: fill.itemId,
      quantity: matchedQuantity,
      proceeds,
      cost,
      profit: proceeds - cost,
      unmatchedQuantity: remaining,
      timestamp: fill.timestamp,
    };

    if (matchedQuantity > 0 || remaining > 0) {
      this.state.realized.push(realized);
    }

    return [realized];
  }

  trim() {
    this.state.events = this.state.events.slice(-5_000);
    this.state.fills = this.state.fills.slice(-5_000);
    this.state.realized = this.state.realized.slice(-5_000);
    if (this.state.fillSamples) {
      this.state.fillSamples = this.state.fillSamples.slice(-5_000);
    }
    const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
    this.state.seen = Object.fromEntries(
      Object.entries(this.state.seen).filter(
        ([, timestamp]) => new Date(timestamp).getTime() >= cutoff,
      ),
    );
    if (this.state.openOrders) {
      const openCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      this.state.openOrders = Object.fromEntries(
        Object.entries(this.state.openOrders).filter(
          ([, order]) => new Date(order.updatedAt).getTime() >= openCutoff,
        ),
      );
    }
  }

  async persist() {
    this.writeChain = this.writeChain.then(async () => {
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    });
    await this.writeChain;
  }
}
