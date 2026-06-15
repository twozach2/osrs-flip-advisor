import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryStore } from "../lib/history-store.mjs";
import { TradeStore } from "../lib/trade-store.mjs";

test("history snapshots persist and distinguish later catalog additions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osrs-history-"));

  try {
    const historyPath = join(directory, "history.jsonl");
    const catalogPath = join(directory, "catalog.json");
    const store = new HistoryStore(historyPath, catalogPath);
    const now = Math.floor(Date.now() / 1000);
    await store.init();
    await store.updateCatalog([{ id: 1 }]);
    await store.updateCatalog([{ id: 1 }, { id: 2 }]);
    await store.record(
      [
        {
          item: { id: 1 },
          latest: { high: 110, low: 100, highTime: now, lowTime: now },
          fiveMinute: {
            avgHighPrice: 110,
            avgLowPrice: 100,
          },
          oneHour: { highPriceVolume: 100, lowPriceVolume: 100 },
        },
      ],
      now,
    );

    assert.equal(store.getSamples(1).length, 1);
    assert.equal(store.getMetadata(1).catalogNew, false);
    assert.equal(store.getMetadata(2).catalogNew, true);
    assert.match(await readFile(historyPath, "utf8"), /"d":\[\[1,105/);
    const imported = await store.importSeries(1, [
      {
        timestamp: now - 3600,
        avgHighPrice: 120,
        avgLowPrice: 100,
        highPriceVolume: 50,
        lowPriceVolume: 40,
      },
    ]);
    assert.equal(imported, 1);

    const reloaded = new HistoryStore(historyPath, catalogPath);
    await reloaded.init();
    assert.equal(reloaded.getSamples(1).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fill events persist and calculate FIFO realized profit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osrs-trades-"));

  try {
    const path = join(directory, "trades.json");
    const store = new TradeStore(path);
    await store.init();
    await store.ingest({
      eventId: "buy-1",
      account: "test",
      slot: 0,
      itemId: 100,
      state: "BUYING",
      deltaQuantity: 10,
      deltaSpent: 1_000,
    });
    await store.ingest({
      eventId: "sell-1",
      account: "test",
      slot: 1,
      itemId: 100,
      state: "SELLING",
      deltaQuantity: 6,
      deltaSpent: 900,
    });
    const duplicate = await store.ingest({
      eventId: "sell-1",
      account: "test",
      slot: 1,
      itemId: 100,
      state: "SELLING",
      deltaQuantity: 6,
      deltaSpent: 900,
    });
    const summary = store.getSummary();

    assert.equal(duplicate.duplicate, true);
    assert.equal(summary.realizedProfit, 300);
    assert.equal(summary.positions[0].quantity, 4);

    const reloaded = new TradeStore(path);
    await reloaded.init();
    assert.equal(reloaded.getSummary().realizedProfit, 300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("open offers upsert, preserve first-seen, reset on re-price, and clear on terminal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osrs-open-"));

  try {
    const path = join(directory, "trades.json");
    const store = new TradeStore(path);
    await store.init();

    const hour = 60 * 60 * 1000;
    const placedAt = new Date(Date.now() - 3 * hour).toISOString();
    const partialAt = new Date(Date.now() - 2 * hour).toISOString();
    const repricedAt = new Date(Date.now() - 1 * hour).toISOString();

    await store.ingestOffer({
      kind: "offer",
      account: "test",
      slot: 2,
      itemId: 555,
      state: "BUYING",
      quantitySold: 0,
      totalQuantity: 100,
      offerPrice: 1_000,
      timestamp: placedAt,
    });
    await store.ingestOffer({
      kind: "offer",
      account: "test",
      slot: 2,
      itemId: 555,
      state: "BUYING",
      quantitySold: 30,
      totalQuantity: 100,
      offerPrice: 1_000,
      timestamp: partialAt,
    });

    let open = store.getSummary().openOrders;
    assert.equal(open.length, 1);
    assert.equal(open[0].side, "buy");
    assert.equal(open[0].firstSeenAt, placedAt);
    assert.equal(open[0].updatedAt, partialAt);
    assert.equal(open[0].quantitySold, 30);

    await store.ingestOffer({
      kind: "offer",
      account: "test",
      slot: 2,
      itemId: 555,
      state: "BUYING",
      quantitySold: 0,
      totalQuantity: 100,
      offerPrice: 1_010,
      timestamp: repricedAt,
    });

    open = store.getSummary().openOrders;
    assert.equal(open.length, 1);
    assert.equal(open[0].firstSeenAt, repricedAt);

    const reloaded = new TradeStore(path);
    await reloaded.init();
    assert.equal(reloaded.getSummary().openOrders.length, 1);

    await reloaded.ingestOffer({
      kind: "offer",
      account: "test",
      slot: 2,
      itemId: 555,
      state: "BOUGHT",
      quantitySold: 100,
      totalQuantity: 100,
      offerPrice: 1_010,
      timestamp: new Date().toISOString(),
    });
    assert.equal(reloaded.getSummary().openOrders.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
