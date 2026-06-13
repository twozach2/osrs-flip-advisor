import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BUY_STATES = new Set(["BUYING", "BOUGHT", "CANCELLED_BUY"]);
const SELL_STATES = new Set(["SELLING", "SOLD", "CANCELLED_SELL"]);

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
    const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
    this.state.seen = Object.fromEntries(
      Object.entries(this.state.seen).filter(
        ([, timestamp]) => new Date(timestamp).getTime() >= cutoff,
      ),
    );
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
