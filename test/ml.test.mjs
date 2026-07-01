import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ML_FEATURE_NAMES,
  predictShadowModel,
  trainShadowModel,
} from "../lib/ml-model.mjs";
import { MlShadowStore } from "../lib/ml-store.mjs";

function featureVector(signal) {
  const features = Array(ML_FEATURE_NAMES.length).fill(0);
  features[0] = signal;
  features[1] = signal * 0.5;
  return features;
}

test("shadow logistic models learn a chronologically validated signal", () => {
  const start = Date.UTC(2025, 0, 1);
  const rows = Array.from({ length: 600 }, (_, index) => {
    const signal = Math.sin(index / 5);
    const positive = signal > 0 ? 1 : 0;
    return {
      id: `row-${index}`,
      decisionAt: new Date(start + index * 60 * 60 * 1000).toISOString(),
      features: featureVector(signal),
      labels: {
        entryWithin6h: positive,
        exitWithin24h: positive,
        downsideBeforeExit: 1 - positive,
      },
    };
  });

  const model = trainShadowModel(rows, { minimumRows: 100 });
  assert.equal(model.targets.entryWithin6h.available, true);
  assert.equal(model.targets.entryWithin6h.trusted, true);

  const high = predictShadowModel(model, featureVector(0.9));
  const low = predictShadowModel(model, featureVector(-0.9));
  assert.ok(high.predictions.entryWithin6h > low.predictions.entryWithin6h);
  assert.ok(high.predictions.downsideBeforeExit < low.predictions.downsideBeforeExit);
});

function opportunity() {
  return {
    id: 42,
    modelSource: "distribution",
    buyOffer: 1_000,
    sellOffer: 1_200,
    reviewPrice: 900,
    currentMid: 1_100,
    hourlyRoundTrips: 100,
    spreadRatio: 0.1,
    distribution: {
      sigmaPercent: 0.05,
      zScore: 0,
      driftPerHour: 0,
      trendStrength: 0,
      confidence: 0.8,
    },
  };
}

function rankedPlan() {
  return {
    balanced: [],
    highVolume: [],
    highMargin: [],
    highValue: [],
    lowRisk: [],
    plan: [opportunity()],
  };
}

test("shadow labels wait for observed coverage and preserve event order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osrs-ml-"));
  try {
    const store = new MlShadowStore({
      pendingPath: join(directory, "pending.json"),
      trainingPath: join(directory, "training.jsonl"),
      modelPath: join(directory, "model.json"),
    });
    await store.init();
    const decisionTime = Date.UTC(2025, 5, 1, 0, 0, 0);
    let samples = [];
    const historyStore = { getSamples: () => samples };

    await store.process(rankedPlan(), historyStore, decisionTime);
    const withoutCoverage = await store.process(
      rankedPlan(),
      historyStore,
      decisionTime + 31 * 60 * 60 * 1000,
    );
    assert.equal(withoutCoverage.labeledRows, 0);
    assert.ok(withoutCoverage.pendingDecisions >= 1);

    const decisionSeconds = decisionTime / 1000;
    samples = Array.from({ length: 31 }, (_, index) => {
      const hours = index + 1;
      const low = hours === 1 ? 990 : hours === 2 ? 880 : 1_000;
      const high = hours === 5 ? 1_220 : 1_100;
      return [
        decisionSeconds + hours * 60 * 60,
        Math.round((high + low) / 2),
        (high - low) / ((high + low) / 2),
        100,
        high,
        low,
        1,
      ];
    });
    const withCoverage = await store.process(
      rankedPlan(),
      historyStore,
      decisionTime + 31 * 60 * 60 * 1000,
    );
    assert.equal(withCoverage.labeledRows, 1);
    assert.equal(withCoverage.affectsRanking, false);

    const row = JSON.parse((await readFile(join(directory, "training.jsonl"), "utf8")).trim());
    assert.deepEqual(row.labels, {
      entryWithin6h: 1,
      exitWithin24h: 1,
      downsideBeforeExit: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired training rows are compacted from disk during startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osrs-ml-retention-"));
  try {
    const trainingPath = join(directory, "training.jsonl");
    const oldRow = {
      id: "old",
      decisionAt: "2020-01-01T00:00:00.000Z",
      features: featureVector(0),
      labels: { entryWithin6h: 0 },
    };
    const currentRow = {
      id: "current",
      decisionAt: new Date().toISOString(),
      features: featureVector(0),
      labels: { entryWithin6h: 1 },
    };
    await writeFile(
      trainingPath,
      `${JSON.stringify(oldRow)}\n${JSON.stringify(currentRow)}\n`,
      "utf8",
    );
    const store = new MlShadowStore({
      pendingPath: join(directory, "pending.json"),
      trainingPath,
      modelPath: join(directory, "model.json"),
    });
    await store.init();

    assert.equal(store.getStatus().labeledRows, 1);
    const retained = (await readFile(trainingPath, "utf8")).trim().split(/\r?\n/);
    assert.equal(retained.length, 1);
    assert.equal(JSON.parse(retained[0]).id, "current");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
