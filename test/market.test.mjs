import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpportunity,
  calculateOffers,
  calculateTax,
  rankOpportunities,
} from "../lib/market.mjs";

test("calculates the current 2% tax with a 5m cap", () => {
  assert.equal(calculateTax(1_000_000), 20_000);
  assert.equal(calculateTax(300_000_000), 5_000_000);
  assert.equal(calculateTax(49), 0);
});

test("suggested offers improve both sides of the observed spread", () => {
  assert.deepEqual(calculateOffers(100, 200, 0.05), {
    buyOffer: 105,
    sellOffer: 195,
    tax: 3,
    profit: 87,
    roi: 87 / 105,
    rawSpread: 100,
  });
});

test("rejects stale markets", () => {
  const now = 1_000_000;
  const result = buildOpportunity(
    {
      item: { id: 1, name: "Test item", limit: 100, members: true },
      latest: {
        low: 1_000,
        high: 1_200,
        lowTime: now - 2_000,
        highTime: now - 2_000,
      },
      fiveMinute: { highPriceVolume: 100, lowPriceVolume: 100 },
      oneHour: { highPriceVolume: 1_000, lowPriceVolume: 1_000 },
    },
    {
      edgePercent: 0.05,
      maxAgeMinutes: 15,
      minProfit: 1,
      minRoi: 0,
      minHourlyVolume: 1,
      maxSpreadRatio: 1,
      cycleHours: 8,
      participationRate: 0.02,
      slotBudget: 1_000_000,
    },
    now,
  );

  assert.equal(result, null);
});

test("ranks liquid opportunities and respects per-slot capital", () => {
  const now = Math.floor(Date.now() / 1000);
  const records = [
    {
      item: { id: 1, name: "Liquid", limit: 10_000, members: true },
      latest: { low: 1_000, high: 1_100, lowTime: now, highTime: now },
      fiveMinute: { highPriceVolume: 5_000, lowPriceVolume: 5_000 },
      oneHour: { highPriceVolume: 50_000, lowPriceVolume: 50_000 },
    },
  ];

  const ranked = rankOpportunities(records, {
    capital: 1_000_000,
    slots: 1,
    reservePercent: 20,
    minProfit: 1,
    minRoi: 0,
    minHourlyVolume: 1,
    maxSpreadRatio: 1,
  });

  assert.equal(ranked.highVolume.length, 1);
  assert.equal(ranked.balanced.length, 1);
  assert.ok(ranked.highVolume[0].capitalRequired <= 800_000);
});

test("accepts zero-value optional filters", () => {
  const now = Math.floor(Date.now() / 1000);
  const records = [
    {
      item: { id: 1, name: "Small margin", limit: 100, members: true },
      latest: { low: 1_000, high: 1_030, lowTime: now, highTime: now },
      fiveMinute: { highPriceVolume: 100, lowPriceVolume: 100 },
      oneHour: { highPriceVolume: 100, lowPriceVolume: 100 },
    },
  ];

  const ranked = rankOpportunities(records, {
    capital: 1_000_000,
    slots: 1,
    reservePercent: 0,
    edgePercent: 0,
    minProfit: 0,
    minRoi: 0,
    minHourlyVolume: 0,
    maxSpreadRatio: 1,
  });

  assert.equal(ranked.settings.reservePercent, 0);
  assert.equal(ranked.settings.edgePercent, 0);
  assert.equal(ranked.balanced.length, 1);
});

test("weekly model never exceeds the four-hour buy limit", () => {
  const now = Math.floor(Date.now() / 1000);
  const result = buildOpportunity(
    {
      item: { id: 1, name: "Limited item", limit: 10, members: true },
      latest: { low: 1_000, high: 1_200, lowTime: now, highTime: now },
      fiveMinute: {
        avgHighPrice: 1_200,
        avgLowPrice: 1_000,
        highPriceVolume: 100,
        lowPriceVolume: 100,
      },
      oneHour: {
        avgHighPrice: 1_200,
        avgLowPrice: 1_000,
        highPriceVolume: 1_200,
        lowPriceVolume: 1_200,
      },
    },
    {
      edgePercent: 0.05,
      adaptiveOffers: false,
      maxAgeMinutes: 15,
      minProfit: 1,
      minRoi: 0,
      minHourlyVolume: 1,
      maxSpreadRatio: 1,
      cycleHours: 1,
      participationRate: 1,
      slotBudget: 1_000_000,
    },
    now,
  );

  assert.equal(result.weeklyUnits, 420);
  assert.equal(result.weeklyModel, result.profit * 420);
});
