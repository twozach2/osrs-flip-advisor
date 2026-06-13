import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRisk } from "../lib/risk.mjs";

function samplesFromPrices(prices, start = 1_000_000) {
  return prices.map((price, index) => [start + index * 300, price, 0.02, 100]);
}

test("stable history scores below volatile falling history", () => {
  const stable = analyzeRisk(
    samplesFromPrices([100, 101, 100, 101, 102, 102, 103, 103]),
    {
      currentMid: 103,
      hourlyRoundTrips: 1_000,
      quantity: 100,
      spreadRatio: 0.02,
      nowSeconds: 1_000_000 + 7 * 300,
    },
  );
  const volatile = analyzeRisk(
    samplesFromPrices([100, 125, 85, 120, 70, 90, 60, 55]),
    {
      currentMid: 55,
      hourlyRoundTrips: 20,
      quantity: 100,
      spreadRatio: 0.18,
      momentum: -0.08,
      nowSeconds: 1_000_000 + 7 * 300,
    },
  );

  assert.ok(stable.score < volatile.score);
  assert.ok(volatile.estimatedDownside > stable.estimatedDownside);
});

test("newly observed items receive an explicit risk penalty", () => {
  const samples = samplesFromPrices([100, 101, 102, 103]);
  const established = analyzeRisk(samples, {
    currentMid: 103,
    hourlyRoundTrips: 1_000,
    quantity: 10,
    spreadRatio: 0.02,
    nowSeconds: 1_000_900,
  });
  const newItem = analyzeRisk(samples, {
    currentMid: 103,
    hourlyRoundTrips: 1_000,
    quantity: 10,
    spreadRatio: 0.02,
    catalogNew: true,
    nowSeconds: 1_000_900,
  });

  assert.ok(newItem.score > established.score);
  assert.ok(newItem.reasons.includes("Newly observed item"));
});
