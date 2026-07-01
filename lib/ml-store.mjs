import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ML_TARGETS,
  buildMlFeatureVector,
  predictShadowModel,
  trainShadowModel,
} from "./ml-model.mjs";

const HOUR_MILLISECONDS = 60 * 60 * 1000;
const ENTRY_HORIZON_MILLISECONDS = 6 * HOUR_MILLISECONDS;
const EXIT_HORIZON_MILLISECONDS = 24 * HOUR_MILLISECONDS;
const OBSERVATION_TOLERANCE_MILLISECONDS = 2 * HOUR_MILLISECONDS;
const TRAINING_RETENTION_MILLISECONDS = 180 * 24 * HOUR_MILLISECONDS;
const ABANDONED_DECISION_MILLISECONDS = 14 * 24 * HOUR_MILLISECONDS;
const MAX_PENDING_DECISIONS = 20_000;
const MAX_TRAINING_ROWS = 100_000;

function sampleLow(sample) {
  const low = Number(sample?.[5]);
  if (low > 0) {
    return low;
  }
  const mid = Number(sample?.[1]) || 0;
  const spread = Number(sample?.[2]) || 0;
  return Math.max(1, mid * (1 - spread / 2));
}

function sampleHigh(sample) {
  const high = Number(sample?.[4]);
  if (high > 0) {
    return high;
  }
  const mid = Number(sample?.[1]) || 0;
  const spread = Number(sample?.[2]) || 0;
  return Math.max(1, mid * (1 + spread / 2));
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function atomicJsonWrite(path, value) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function atomicJsonLinesWrite(path, rows) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(
    temporaryPath,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
    "utf8",
  );
  await rename(temporaryPath, path);
}

function uniqueOpportunityArrays(ranked) {
  return [
    ranked.balanced,
    ranked.highVolume,
    ranked.highMargin,
    ranked.highValue,
    ranked.lowRisk,
    ranked.plan,
  ].filter(Array.isArray);
}

export class MlShadowStore {
  constructor({ pendingPath, trainingPath, modelPath }) {
    this.pendingPath = pendingPath;
    this.trainingPath = trainingPath;
    this.modelPath = modelPath;
    this.pending = new Map();
    this.rows = [];
    this.labeledIds = new Set();
    this.model = null;
    this.lastTrainAttempt = 0;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.pendingPath), { recursive: true });
    const pending = await readJson(this.pendingPath, []);
    this.pending = new Map(
      (Array.isArray(pending) ? pending : []).map((decision) => [
        decision.id,
        decision,
      ]),
    );

    let content = "";
    try {
      content = await readFile(this.trainingPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const cutoff = Date.now() - TRAINING_RETENTION_MILLISECONDS;
    const rawLines = content.split(/\r?\n/).filter(Boolean);
    const parsedRows = rawLines
      .flatMap((line) => {
        try {
          const row = JSON.parse(line);
          return new Date(row.decisionAt).getTime() >= cutoff ? [row] : [];
        } catch {
          return [];
        }
      });
    this.rows = parsedRows.slice(-MAX_TRAINING_ROWS);
    if (this.rows.length !== rawLines.length) {
      await atomicJsonLinesWrite(this.trainingPath, this.rows);
    }
    this.labeledIds = new Set(this.rows.map((row) => row.id));
    this.model = await readJson(this.modelPath, null);
  }

  async process(ranked, historyStore, nowMilliseconds = Date.now()) {
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await this.resolvePending(historyStore, nowMilliseconds);
        await this.recordDecisions(ranked.plan || [], nowMilliseconds);
        await this.maybeTrain(nowMilliseconds);
      });
    await this.writeChain;
    this.decorate(ranked);
    return this.getStatus();
  }

  async resolvePending(historyStore, nowMilliseconds) {
    const completed = [];
    let changed = false;

    for (const [id, decision] of this.pending) {
      const decisionTime = new Date(decision.decisionAt).getTime();
      if (!Number.isFinite(decisionTime)) {
        this.pending.delete(id);
        changed = true;
        continue;
      }
      if (nowMilliseconds - decisionTime > ABANDONED_DECISION_MILLISECONDS) {
        this.pending.delete(id);
        changed = true;
        continue;
      }
      if (nowMilliseconds < decisionTime + ENTRY_HORIZON_MILLISECONDS) {
        continue;
      }

      const samples = historyStore
        .getSamples(decision.itemId)
        .filter((sample) => Number(sample?.[0]) * 1000 > decisionTime)
        .sort((left, right) => Number(left[0]) - Number(right[0]));
      const entryDeadline = decisionTime + ENTRY_HORIZON_MILLISECONDS;
      const entryWindow = samples.filter(
        (sample) => Number(sample[0]) * 1000 <= entryDeadline,
      );
      const entryCoverage = Math.max(
        0,
        ...entryWindow.map((sample) => Number(sample[0]) * 1000),
      );
      if (
        entryWindow.length < 3 ||
        entryCoverage < entryDeadline - OBSERVATION_TOLERANCE_MILLISECONDS
      ) {
        continue;
      }
      const entrySample = entryWindow.find(
        (sample) =>
          sampleLow(sample) <= decision.buyOffer,
      );

      if (!entrySample) {
        completed.push({
          ...decision,
          labelReadyAt: new Date(nowMilliseconds).toISOString(),
          labels: {
            entryWithin6h: 0,
            exitWithin24h: null,
            downsideBeforeExit: null,
          },
        });
        this.pending.delete(id);
        changed = true;
        continue;
      }

      const entryTime = Number(entrySample[0]) * 1000;
      const exitDeadline = entryTime + EXIT_HORIZON_MILLISECONDS;
      if (nowMilliseconds < exitDeadline) {
        continue;
      }
      const exitWindow = samples.filter((sample) => {
        const sampleTime = Number(sample[0]) * 1000;
        return sampleTime > entryTime && sampleTime <= exitDeadline;
      });
      const exitCoverage = Math.max(
        0,
        ...exitWindow.map((sample) => Number(sample[0]) * 1000),
      );
      if (
        exitWindow.length < 8 ||
        exitCoverage < exitDeadline - OBSERVATION_TOLERANCE_MILLISECONDS
      ) {
        continue;
      }

      let exitWithin24h = 0;
      let downsideBeforeExit = 0;
      for (const sample of exitWindow) {
        if (sampleLow(sample) <= decision.reviewPrice) {
          downsideBeforeExit = 1;
        }
        if (sampleHigh(sample) >= decision.sellOffer) {
          exitWithin24h = 1;
          break;
        }
      }

      completed.push({
        ...decision,
        entryAt: new Date(entryTime).toISOString(),
        labelReadyAt: new Date(nowMilliseconds).toISOString(),
        labels: {
          entryWithin6h: 1,
          exitWithin24h,
          downsideBeforeExit,
        },
      });
      this.pending.delete(id);
      changed = true;
    }

    if (completed.length) {
      const combined = [...this.rows, ...completed];
      const cutoff = nowMilliseconds - TRAINING_RETENTION_MILLISECONDS;
      const retained = combined
        .filter((row) => new Date(row.decisionAt).getTime() >= cutoff)
        .slice(-MAX_TRAINING_ROWS);
      if (retained.length !== combined.length) {
        await atomicJsonLinesWrite(this.trainingPath, retained);
      } else {
        await appendFile(
          this.trainingPath,
          `${completed.map((row) => JSON.stringify(row)).join("\n")}\n`,
          "utf8",
        );
      }
      this.rows = retained;
      for (const row of completed) {
        this.labeledIds.add(row.id);
      }
    }
    if (changed) {
      await atomicJsonWrite(this.pendingPath, [...this.pending.values()]);
    }
  }

  async recordDecisions(opportunities, nowMilliseconds) {
    const hourBucket = Math.floor(nowMilliseconds / HOUR_MILLISECONDS);
    let changed = false;
    for (const opportunity of opportunities.slice(0, 100)) {
      if (opportunity.modelSource !== "distribution") {
        continue;
      }
      const id = `${opportunity.id}:${hourBucket}`;
      if (this.pending.has(id) || this.labeledIds.has(id)) {
        continue;
      }
      const features = buildMlFeatureVector(opportunity, nowMilliseconds);
      if (!features.every(Number.isFinite)) {
        continue;
      }
      this.pending.set(id, {
        id,
        itemId: opportunity.id,
        decisionAt: new Date(nowMilliseconds).toISOString(),
        buyOffer: opportunity.buyOffer,
        sellOffer: opportunity.sellOffer,
        reviewPrice: opportunity.reviewPrice,
        features,
      });
      changed = true;
    }

    if (this.pending.size > MAX_PENDING_DECISIONS) {
      const retained = [...this.pending.values()]
        .sort(
          (left, right) =>
            new Date(left.decisionAt).getTime() - new Date(right.decisionAt).getTime(),
        )
        .slice(-MAX_PENDING_DECISIONS);
      this.pending = new Map(retained.map((decision) => [decision.id, decision]));
      changed = true;
    }
    if (changed) {
      await atomicJsonWrite(this.pendingPath, [...this.pending.values()]);
    }
  }

  async maybeTrain(nowMilliseconds, force = false) {
    const previousRows = Number(this.model?.trainingRows) || 0;
    const enoughNewRows = this.rows.length >= previousRows + 50;
    const dayElapsed =
      nowMilliseconds - this.lastTrainAttempt >= 24 * HOUR_MILLISECONDS;
    if (!force && (!dayElapsed || !enoughNewRows)) {
      return false;
    }
    if (this.rows.length < 200) {
      return false;
    }

    this.lastTrainAttempt = nowMilliseconds;
    this.model = {
      ...trainShadowModel(this.rows),
      trainingRows: this.rows.length,
    };
    await atomicJsonWrite(this.modelPath, this.model);
    return true;
  }

  decorate(ranked) {
    for (const opportunities of uniqueOpportunityArrays(ranked)) {
      for (const opportunity of opportunities) {
        const prediction = predictShadowModel(
          this.model,
          buildMlFeatureVector(opportunity),
        );
        if (prediction) {
          opportunity.mlShadow = prediction;
        }
      }
    }
  }

  getStatus() {
    return {
      mode: "shadow",
      affectsRanking: false,
      pendingDecisions: this.pending.size,
      labeledRows: this.rows.length,
      modelLoaded: Boolean(this.model),
      trainedAt: this.model?.trainedAt || null,
      minimumRows: this.model?.minimumRows || 200,
      targets: Object.fromEntries(
        ML_TARGETS.map(({ key, label }) => {
          const target = this.model?.targets?.[key];
          return [
            key,
            {
              label,
              available: Boolean(target?.available),
              trusted: Boolean(target?.trusted),
              rows: Number(target?.rows) || 0,
              validation: target?.validation || null,
            },
          ];
        }),
      ),
    };
  }
}
