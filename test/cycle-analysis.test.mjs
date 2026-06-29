import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHistoricalCycles } from "../lib/cycle-analysis.mjs";

function hourlySeries(priceAt, count = 14 * 24, now = 4_000_000) {
  return Array.from({ length: count }, (_, index) => {
    const mid = Math.round(priceAt(index));
    const low = Math.round(mid * 0.995);
    const high = Math.round(mid * 1.005);
    return [
      now - (count - index - 1) * 60 * 60,
      mid,
      (high - low) / mid,
      1_000,
      high,
      low,
      1,
    ];
  });
}

function fairValueTargets(distribution) {
  return {
    buyOffer: Math.round(distribution.fairValue * 0.97),
    sellOffer: Math.round(distribution.fairValue * 1.03),
    reviewPrice: Math.round(distribution.fairValue * 0.88),
  };
}

test("walk-forward cycles recognize a repeatable range", () => {
  const samples = hourlySeries(
    (index) => 1_000 * (1 + 0.08 * Math.sin((index * Math.PI) / 6)),
  );
  const result = analyzeHistoricalCycles(samples, {
    nowSeconds: 4_000_000,
    trainingWindowHours: 72,
    minimumSamples: 24,
    targetBuilder: fairValueTargets,
  });

  assert.ok(result.completedCycles >= 8);
  assert.ok(result.successRate >= 0.75);
  assert.ok(result.medianExitHours <= 12);
  assert.equal(result.status, "repeatable");
  assert.ok(result.rankingMultiplier > 1);
});

test("walk-forward cycles penalize a one-way decline", () => {
  const samples = hourlySeries((index) => 2_000 * Math.pow(0.997, index));
  const result = analyzeHistoricalCycles(samples, {
    nowSeconds: 4_000_000,
    trainingWindowHours: 72,
    minimumSamples: 24,
    targetBuilder: fairValueTargets,
  });

  assert.ok(result.completedCycles >= 1);
  assert.ok(result.successRate < 0.4);
  assert.ok(result.downsideFirstCycles + result.expiredCycles > 0);
  assert.ok(result.rankingMultiplier <= 1);
});

test("frequent downside-before-exit patterns cannot receive a ranking boost", () => {
  const samples = hourlySeries(
    (index) => 1_000 * (1 + 0.08 * Math.sin((index * Math.PI) / 6)),
  );
  const result = analyzeHistoricalCycles(samples, {
    nowSeconds: 4_000_000,
    trainingWindowHours: 72,
    minimumSamples: 24,
    targetBuilder(distribution) {
      return {
        buyOffer: Math.round(distribution.fairValue * 0.97),
        sellOffer: Math.round(distribution.fairValue * 1.03),
        reviewPrice: Math.round(distribution.fairValue * 0.99),
      };
    },
  });

  assert.ok(result.successRate >= 0.75);
  assert.ok(result.downsideFirstRate > 0.75);
  assert.ok(result.rankingMultiplier <= 1);
});

test("historical targets never use later prices", () => {
  const samples = hourlySeries((index) => (index < 72 ? 1_000 : 5_000), 144);
  const observedFairValues = [];

  analyzeHistoricalCycles(samples, {
    nowSeconds: 4_000_000,
    trainingWindowHours: 72,
    minimumSamples: 24,
    targetBuilder(distribution) {
      observedFairValues.push(distribution.fairValue);
      return {
        buyOffer: 1,
        sellOffer: 2,
        reviewPrice: 1,
      };
    },
  });

  assert.ok(observedFairValues.length > 0);
  assert.ok(observedFairValues[0] < 1_100);
});
