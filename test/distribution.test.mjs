import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDistribution } from "../lib/distribution.mjs";

function hourlySamples(prices, now = 2_000_000) {
  return prices.map((price, index) => [
    now - (prices.length - index - 1) * 3600,
    price,
    0.02,
    1_000,
  ]);
}

function asymmetricSamples(now = 2_000_000, count = 48) {
  return Array.from({ length: count }, (_, index) => {
    const low = 1_000 + (index % 3);
    const high = 1_050 + Math.round(60 * Math.sin(index / 2));
    const mid = Math.round((high + low) / 2);
    const spread = (high - low) / mid;
    return [now - (count - index - 1) * 3600, mid, spread, 1_000, high, low, 1];
  });
}

test("robust price bands resist a single extreme outlier", () => {
  const normal = Array.from({ length: 48 }, (_, index) => 1_000 + (index % 5) * 2);
  const baseline = analyzeDistribution(hourlySamples(normal), {
    nowSeconds: 2_000_000,
    windowHours: 72,
    minimumSamples: 24,
  });
  const withOutlier = analyzeDistribution(hourlySamples([...normal, 10_000]), {
    nowSeconds: 2_000_000,
    windowHours: 72,
    minimumSamples: 24,
  });

  assert.equal(baseline.available, true);
  assert.ok(Math.abs(withOutlier.fairValue - baseline.fairValue) < 20);
  assert.ok(withOutlier.sellTarget < 1_100);
});

test("entry and exit sigma controls widen the target band", () => {
  const prices = Array.from({ length: 72 }, (_, index) =>
    Math.round(1_000 * (1 + 0.03 * Math.sin(index / 4))),
  );
  const narrow = analyzeDistribution(hourlySamples(prices), {
    nowSeconds: 2_000_000,
    entrySigma: 0.5,
    exitSigma: 0.5,
  });
  const wide = analyzeDistribution(hourlySamples(prices), {
    nowSeconds: 2_000_000,
    entrySigma: 1.5,
    exitSigma: 1.5,
  });

  assert.ok(wide.buyTarget < narrow.buyTarget);
  assert.ok(wide.sellTarget > narrow.sellTarget);
});

test("adaptive horizon shortens the effective window during a sustained trend", () => {
  const prices = Array.from({ length: 72 }, (_, index) =>
    Math.round(1_000 * Math.pow(1.01, index)),
  );
  const legacy = analyzeDistribution(hourlySamples(prices), {
    nowSeconds: 2_000_000,
    adaptiveHorizon: false,
  });
  const adaptive = analyzeDistribution(hourlySamples(prices), {
    nowSeconds: 2_000_000,
    adaptiveHorizon: true,
  });

  assert.equal(legacy.effectiveHalfLifeHours, legacy.halfLifeHours);
  assert.ok(adaptive.effectiveHalfLifeHours < adaptive.halfLifeHours);
  assert.ok(adaptive.trendStrength > 0);
  assert.ok(adaptive.fairValue > legacy.fairValue);
});

test("adaptive horizon stays fixed when there is no trend", () => {
  const prices = Array.from({ length: 72 }, (_, index) =>
    Math.round(1_000 * (1 + 0.03 * Math.sin(index / 4))),
  );
  const adaptive = analyzeDistribution(hourlySamples(prices), {
    nowSeconds: 2_000_000,
    adaptiveHorizon: true,
  });

  assert.equal(adaptive.effectiveHalfLifeHours, adaptive.halfLifeHours);
});

test("drift per hour is exposed with the correct sign", () => {
  const downtrend = Array.from({ length: 72 }, (_, index) =>
    Math.round(1_100 * Math.pow(0.99, index)),
  );
  const oscillating = Array.from({ length: 72 }, (_, index) =>
    Math.round(1_000 * (1 + 0.03 * Math.sin(index / 4))),
  );
  const falling = analyzeDistribution(hourlySamples(downtrend), {
    nowSeconds: 2_000_000,
    adaptiveHorizon: true,
  });
  const flat = analyzeDistribution(hourlySamples(oscillating), {
    nowSeconds: 2_000_000,
    adaptiveHorizon: true,
  });

  assert.ok(falling.driftPerHour < 0);
  assert.ok(falling.trendStrength > 0);
  assert.equal(flat.trendStrength, 0);
});

test("insufficient history is explicit", () => {
  const result = analyzeDistribution(hourlySamples([100, 101, 102]), {
    nowSeconds: 2_000_000,
    minimumSamples: 24,
  });

  assert.equal(result.available, false);
  assert.equal(result.sampleCount, 3);
});

test("asymmetric bid/ask volatility drives side-specific targets", () => {
  const result = analyzeDistribution(asymmetricSamples(), {
    nowSeconds: 2_000_000,
    windowHours: 72,
    minimumSamples: 24,
    entrySigma: 0.75,
    exitSigma: 0.75,
  });

  assert.equal(result.available, true);
  assert.ok(result.askSigma > result.bidSigma);
  assert.ok(result.buyTarget <= result.bidFair);
  assert.ok(result.sellTarget >= result.askFair);
  assert.ok(
    result.sellTarget - result.askFair > result.bidFair - result.buyTarget,
  );
  assert.ok(result.realizedSpread > 0);
  assert.equal(result.asymmetricSamples, 48);
  assert.equal(result.asymmetryWeight, 1);
});

test("missing asymmetric flag collapses bid/ask sigma toward mid-series sigma", () => {
  const result = analyzeDistribution(hourlySamples(
    Array.from({ length: 48 }, (_, index) => 1_000 + (index % 5) * 2),
  ), {
    nowSeconds: 2_000_000,
    windowHours: 72,
    minimumSamples: 24,
  });

  assert.equal(result.available, true);
  assert.equal(result.asymmetricSamples, 0);
  assert.equal(result.asymmetryWeight, 0);
  assert.equal(result.bidSigma, result.robustSigma);
  assert.equal(result.askSigma, result.robustSigma);
});
