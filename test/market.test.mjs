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

test("old school bonds are excluded from recommendations and planning", () => {
  const now = Math.floor(Date.now() / 1000);
  const bond = {
    item: { id: 13190, name: "Old school bond", limit: 40, members: true },
    latest: { low: 12_000_000, high: 14_500_000, lowTime: now, highTime: now },
    fiveMinute: {
      avgHighPrice: 14_500_000,
      avgLowPrice: 12_000_000,
      highPriceVolume: 100,
      lowPriceVolume: 100,
    },
    oneHour: {
      avgHighPrice: 14_500_000,
      avgLowPrice: 12_000_000,
      highPriceVolume: 1_000,
      lowPriceVolume: 1_000,
    },
    history: Array.from({ length: 48 }, (_, index) => [
      now - (47 - index) * 3600,
      12_000_000 + (index % 5) * 500_000,
      0.1,
      1_000,
    ]),
  };
  const ranked = rankOpportunities([bond], {
    capital: 500_000_000,
    slots: 8,
    minProfit: 0,
    minRoi: 0,
    minHourlyVolume: 0,
    maxAgeMinutes: 240,
    maxSpreadRatio: 2,
    requireDistribution: true,
    maxRiskScore: 100,
    maxExitSigma: 6,
  });

  assert.equal(ranked.balanced.length, 0);
  assert.equal(ranked.plan.length, 0);
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
    requireDistribution: false,
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
    requireDistribution: false,
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

test("historical distribution targets remain stable when the live margin changes", () => {
  const now = Math.floor(Date.now() / 1000);
  const history = Array.from({ length: 48 }, (_, index) => [
    now - (47 - index) * 3600,
    900 + (index % 5) * 50,
    0.02,
    1_000,
  ]);
  const settings = {
    capital: 10_000_000,
    slotBudget: 1_000_000,
    maxPositionPercent: 1,
    maxLossPercent: 1,
    maxRiskScore: 100,
    edgePercent: 0.05,
    adaptiveOffers: true,
    requireDistribution: true,
    distributionWindowHours: 72,
    distributionHalfLifeHours: 24,
    minimumDistributionSamples: 24,
    entrySigma: 0.75,
    exitSigma: 0.75,
    maxAgeMinutes: 15,
    minProfit: 1,
    minRoi: 0,
    minHourlyVolume: 1,
    maxSpreadRatio: 1,
    cycleHours: 8,
    participationRate: 0.02,
  };
  const common = {
    item: { id: 1, name: "Stable history", limit: 1_000, members: true },
    history,
    fiveMinute: {
      avgHighPrice: 1_030,
      avgLowPrice: 990,
      highPriceVolume: 100,
      lowPriceVolume: 100,
    },
    oneHour: {
      avgHighPrice: 1_030,
      avgLowPrice: 990,
      highPriceVolume: 1_000,
      lowPriceVolume: 1_000,
    },
  };
  const wideLiveMargin = buildOpportunity(
    {
      ...common,
      latest: { low: 900, high: 1_200, lowTime: now, highTime: now },
    },
    settings,
    now,
  );
  const narrowLiveMargin = buildOpportunity(
    {
      ...common,
      latest: { low: 1_000, high: 1_020, lowTime: now, highTime: now },
    },
    settings,
    now,
  );

  assert.equal(wideLiveMargin.modelSource, "distribution");
  assert.equal(wideLiveMargin.buyOffer, narrowLiveMargin.buyOffer);
  assert.equal(wideLiveMargin.sellOffer, narrowLiveMargin.sellOffer);
});

test("portfolio planning widens exits enough to clear tax within its sigma cap", () => {
  const now = Math.floor(Date.now() / 1000);
  const records = Array.from({ length: 8 }, (_, itemIndex) => ({
    item: {
      id: itemIndex + 1,
      name: `Planned ${itemIndex + 1}`,
      limit: 1_000,
      members: true,
    },
    latest: { low: 990, high: 1_010, lowTime: now, highTime: now },
    fiveMinute: {
      avgHighPrice: 1_010,
      avgLowPrice: 990,
      highPriceVolume: 100,
      lowPriceVolume: 100,
    },
    oneHour: {
      avgHighPrice: 1_010,
      avgLowPrice: 990,
      highPriceVolume: 1_000,
      lowPriceVolume: 1_000,
    },
    history: Array.from({ length: 48 }, (_, index) => [
      now - (47 - index) * 3600,
      950 + (index % 5) * 25,
      0.02,
      1_000,
    ]),
  }));
  const ranked = rankOpportunities(records, {
    capital: 100_000_000,
    slots: 8,
    reservePercent: 20,
    minProfit: 100,
    minRoi: 0.0025,
    minHourlyVolume: 25,
    maxAgeMinutes: 15,
    maxSpreadRatio: 0.25,
    requireDistribution: true,
    entrySigma: 0.75,
    exitSigma: 0.75,
    maxExitSigma: 3,
    maxRiskScore: 100,
    maxLossPercent: 1,
    maxPositionPercent: 1,
  });

  assert.equal(ranked.plan.length, 8);
  assert.ok(ranked.plan.every((item) => item.profit >= 100));
  assert.ok(ranked.plan.every((item) => item.effectiveExitSigma <= 3));
});

function evSettings(overrides = {}) {
  return {
    capital: 100_000_000,
    slotBudget: 5_000_000,
    maxPositionPercent: 1,
    maxLossPercent: 1,
    maxRiskScore: 100,
    edgePercent: 0.05,
    adaptiveOffers: false,
    requireDistribution: true,
    distributionWindowHours: 72,
    distributionHalfLifeHours: 24,
    minimumDistributionSamples: 24,
    entrySigma: 0.75,
    exitSigma: 0.75,
    maxExitSigma: 3,
    maxAgeMinutes: 15,
    minProfit: 1,
    minRoi: 0,
    minHourlyVolume: 1,
    maxSpreadRatio: 1,
    cycleHours: 8,
    participationRate: 0.02,
    ...overrides,
  };
}

function evRecord(now, latest) {
  return {
    item: { id: 1, name: "EV item", limit: 1_000, members: true },
    latest,
    fiveMinute: {
      avgHighPrice: 1_010,
      avgLowPrice: 990,
      highPriceVolume: 100,
      lowPriceVolume: 100,
    },
    oneHour: {
      avgHighPrice: 1_010,
      avgLowPrice: 990,
      highPriceVolume: 1_000,
      lowPriceVolume: 1_000,
    },
    history: Array.from({ length: 48 }, (_, index) => [
      now - (47 - index) * 3600,
      950 + (index % 5) * 25,
      0.02,
      1_000,
    ]),
  };
}

test("expected profit discounts the optimistic exit target", () => {
  const now = Math.floor(Date.now() / 1000);
  const opp = buildOpportunity(
    evRecord(now, { low: 990, high: 1_010, lowTime: now, highTime: now }),
    evSettings(),
    now,
  );

  assert.ok(opp);
  assert.ok(opp.exitFillProbability > 0 && opp.exitFillProbability < 1);
  assert.ok(opp.evPerUnit < opp.profit);
  assert.ok(opp.expectedWeeklyProfit < opp.weeklyModel);
});

test("a wider exit target lowers the modeled exit-fill probability", () => {
  const now = Math.floor(Date.now() / 1000);
  const narrow = buildOpportunity(
    evRecord(now, { low: 990, high: 1_010, lowTime: now, highTime: now }),
    evSettings({ exitSigma: 0.75 }),
    now,
  );
  const wide = buildOpportunity(
    evRecord(now, { low: 990, high: 1_010, lowTime: now, highTime: now }),
    evSettings({ exitSigma: 2 }),
    now,
  );

  assert.ok(narrow && wide);
  assert.ok(wide.effectiveExitSigma > narrow.effectiveExitSigma);
  assert.ok(wide.exitFillProbability < narrow.exitFillProbability);
});

test("rejects buying into a crash where the realistic exit is below entry", () => {
  const now = Math.floor(Date.now() / 1000);
  const healthy = buildOpportunity(
    evRecord(now, { low: 990, high: 1_010, lowTime: now, highTime: now }),
    evSettings(),
    now,
  );
  const crashed = buildOpportunity(
    evRecord(now, { low: 850, high: 860, lowTime: now, highTime: now }),
    evSettings(),
    now,
  );

  assert.ok(healthy);
  assert.equal(crashed, null);
});

function flowRecord(now, latest, history, sellerVolume, buyerVolume) {
  return {
    item: { id: 1, name: "Flow item", limit: 1_000, members: true },
    latest,
    fiveMinute: {
      avgHighPrice: latest.high,
      avgLowPrice: latest.low,
      highPriceVolume: Math.round(buyerVolume / 10),
      lowPriceVolume: Math.round(sellerVolume / 10),
    },
    oneHour: {
      avgHighPrice: latest.high,
      avgLowPrice: latest.low,
      highPriceVolume: buyerVolume,
      lowPriceVolume: sellerVolume,
    },
    history,
  };
}

const oscillatingHistory = (now) =>
  Array.from({ length: 48 }, (_, index) => [
    now - (47 - index) * 3600,
    950 + (index % 5) * 25,
    0.02,
    1_000,
  ]);

test("adaptive entry tightens the buy offer to meet the fill-time target", () => {
  const now = Math.floor(Date.now() / 1000);
  const latest = { low: 990, high: 1_010, lowTime: now, highTime: now };
  const history = oscillatingHistory(now);
  const legacy = buildOpportunity(
    flowRecord(now, latest, history, 500, 1_000),
    evSettings({ adaptiveEntry: false }),
    now,
  );
  const adaptive = buildOpportunity(
    flowRecord(now, latest, history, 500, 1_000),
    evSettings({ adaptiveEntry: true, maxEntryFillHours: 6 }),
    now,
  );

  assert.ok(legacy && adaptive);
  assert.ok(adaptive.buyOffer > legacy.buyOffer);
  assert.ok(adaptive.entryDepth < legacy.entryDepth);
  assert.ok(adaptive.entryFillHours <= 6 + 1e-6);
});

test("adaptive entry rejects an entry that cannot fill in time", () => {
  const now = Math.floor(Date.now() / 1000);
  const latest = { low: 990, high: 1_010, lowTime: now, highTime: now };
  const history = oscillatingHistory(now);
  const legacy = buildOpportunity(
    flowRecord(now, latest, history, 300, 1_000),
    evSettings({ adaptiveEntry: false }),
    now,
  );
  const adaptive = buildOpportunity(
    flowRecord(now, latest, history, 300, 1_000),
    evSettings({ adaptiveEntry: true, maxEntryFillHours: 6 }),
    now,
  );

  assert.ok(legacy);
  assert.equal(adaptive, null);
});

test("drift-aware EV discounts a downtrend", () => {
  const now = Math.floor(Date.now() / 1000);
  const latest = { low: 680, high: 695, lowTime: now, highTime: now };
  const history = Array.from({ length: 48 }, (_, index) => [
    now - (47 - index) * 3600,
    Math.round(1_100 * Math.pow(0.99, index)),
    0.02,
    1_000,
  ]);
  const driftOff = buildOpportunity(
    flowRecord(now, latest, history, 5_000, 5_000),
    evSettings({ driftAware: false }),
    now,
  );
  const driftOn = buildOpportunity(
    flowRecord(now, latest, history, 5_000, 5_000),
    evSettings({ driftAware: true }),
    now,
  );

  assert.ok(driftOff && driftOn);
  assert.ok(driftOff.trendStrength > 0);
  assert.ok(driftOff.driftPerHour < 0);
  assert.ok(driftOn.evPerUnit < driftOff.evPerUnit);
  assert.ok(driftOn.exitFillProbability < driftOff.exitFillProbability);
  assert.ok(driftOn.projectedFairExit <= driftOff.projectedFairExit);
});
