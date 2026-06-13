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

test("insufficient history is explicit", () => {
  const result = analyzeDistribution(hourlySamples([100, 101, 102]), {
    nowSeconds: 2_000_000,
    minimumSamples: 24,
  });

  assert.equal(result.available, false);
  assert.equal(result.sampleCount, 3);
});
