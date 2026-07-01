import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHourlyBars } from "../lib/cycle-analysis.mjs";
import { analyzeDistribution } from "../lib/distribution.mjs";
import { HistoryStore } from "../lib/history-store.mjs";
import { buildMlFeatureVector, trainShadowModel } from "../lib/ml-model.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_ROOT = process.env.OSRS_FLIP_DATA_DIR || join(ROOT, "data");
const HISTORY_PATH = join(DATA_ROOT, "market-history.jsonl");
const CATALOG_PATH = join(DATA_ROOT, "item-catalog.json");
const TRAINING_PATH = join(DATA_ROOT, "ml-training.jsonl");
const MODEL_PATH = join(DATA_ROOT, "ml-model.json");
const HOUR_SECONDS = 60 * 60;
const ENTRY_HOURS = 6;
const EXIT_HOURS = 24;
const OBSERVATION_TOLERANCE_HOURS = 2;
const MAX_ROWS = 100_000;

function calculateTax(sellPrice) {
  return Math.min(Math.floor(sellPrice * 0.02), 5_000_000);
}

function minimumSellPrice(buyOffer, minimumProfit = 100, minimumRoi = 0.0025) {
  const desiredProfit = Math.max(minimumProfit, buyOffer * minimumRoi);
  let low = Math.ceil(buyOffer + desiredProfit);
  let high = Math.ceil(buyOffer + desiredProfit + 5_000_010);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const profit = middle - buyOffer - calculateTax(middle);
    if (profit >= desiredProfit) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function coveredWindow(bars, deadline, minimumBars) {
  if (bars.length < minimumBars) {
    return false;
  }
  return bars.at(-1).time >= deadline - OBSERVATION_TOLERANCE_HOURS * HOUR_SECONDS;
}

function historicalRows(itemId, samples) {
  const bars = buildHourlyBars(samples);
  if (bars.length < 72) {
    return [];
  }
  const rows = [];
  const lastTime = bars.at(-1).time;

  for (let index = 24; index < bars.length; index += 3) {
    const decision = bars[index];
    if (decision.time + (ENTRY_HOURS + EXIT_HOURS) * HOUR_SECONDS > lastTime) {
      break;
    }
    const training = bars
      .slice(0, index + 1)
      .filter((bar) => bar.time >= decision.time - 72 * HOUR_SECONDS)
      .map((bar) => bar.sample);
    const distribution = analyzeDistribution(training, {
      nowSeconds: decision.time,
      windowHours: 72,
      halfLifeHours: 24,
      minimumSamples: 24,
      entrySigma: 0.75,
      exitSigma: 0.75,
      adaptiveHorizon: true,
    });
    if (!distribution.available) {
      continue;
    }

    const buyOffer = distribution.buyTarget;
    const sellOffer = Math.max(
      distribution.sellTarget,
      minimumSellPrice(buyOffer),
    );
    const entryDeadline = decision.time + ENTRY_HOURS * HOUR_SECONDS;
    const entryWindow = bars.filter(
      (bar) => bar.time > decision.time && bar.time <= entryDeadline,
    );
    if (!coveredWindow(entryWindow, entryDeadline, 3)) {
      continue;
    }
    const entryBar = entryWindow.find((bar) => bar.low <= buyOffer);
    let exitWithin24h = null;
    let downsideBeforeExit = null;
    let entryWithin6h = 0;
    let labelReadyTime = entryDeadline;

    if (entryBar) {
      entryWithin6h = 1;
      exitWithin24h = 0;
      downsideBeforeExit = 0;
      const exitDeadline = entryBar.time + EXIT_HOURS * HOUR_SECONDS;
      const exitWindow = bars.filter(
        (bar) => bar.time > entryBar.time && bar.time <= exitDeadline,
      );
      if (!coveredWindow(exitWindow, exitDeadline, 8)) {
        continue;
      }
      for (const bar of exitWindow) {
        if (bar.low <= distribution.p10) {
          downsideBeforeExit = 1;
        }
        if (bar.high >= sellOffer) {
          exitWithin24h = 1;
          break;
        }
      }
      labelReadyTime = exitDeadline;
    }

    const timestamp = decision.time * 1000;
    const features = buildMlFeatureVector(
      {
        buyOffer,
        sellOffer,
        currentMid: decision.mid,
        hourlyRoundTrips: decision.sample[3],
        spreadRatio: decision.sample[2],
        distribution,
      },
      timestamp,
    );
    rows.push({
      id: `bootstrap:${itemId}:${decision.time}`,
      source: "historical-bootstrap",
      itemId,
      decisionAt: new Date(timestamp).toISOString(),
      labelReadyAt: new Date(labelReadyTime * 1000).toISOString(),
      buyOffer,
      sellOffer,
      reviewPrice: distribution.p10,
      features,
      labels: { entryWithin6h, exitWithin24h, downsideBeforeExit },
    });
  }
  return rows;
}

async function existingRows() {
  try {
    const content = await readFile(TRAINING_PATH, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

const historyStore = new HistoryStore(HISTORY_PATH, CATALOG_PATH);
await historyStore.init();
const retainedOnlineRows = (await existingRows()).filter(
  (row) => row.source !== "historical-bootstrap",
);
const byId = new Map(retainedOnlineRows.map((row) => [row.id, row]));
let eligibleItems = 0;
for (const itemId of historyStore.getTrackedItemIds()) {
  const rows = historicalRows(itemId, historyStore.getSamples(itemId));
  if (rows.length) {
    eligibleItems += 1;
  }
  for (const row of rows) {
    byId.set(row.id, row);
  }
}

const rows = [...byId.values()]
  .sort(
    (left, right) =>
      new Date(left.decisionAt).getTime() - new Date(right.decisionAt).getTime(),
  )
  .slice(-MAX_ROWS);
await writeFile(
  TRAINING_PATH,
  rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
  "utf8",
);

if (rows.length < 200) {
  console.log(
    `ML bootstrap collected ${rows.length} labeled rows from ${eligibleItems} items. More history is needed before training.`,
  );
  process.exit(0);
}

const model = {
  ...trainShadowModel(rows),
  trainingRows: rows.length,
  source: "historical-bootstrap",
};
await writeFile(MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`, "utf8");
const available = Object.values(model.targets).filter(
  (target) => target.available,
).length;
const trusted = Object.values(model.targets).filter(
  (target) => target.trusted,
).length;
console.log(
  `ML bootstrap wrote ${rows.length} labeled rows from ${eligibleItems} items. ${available}/3 shadow targets trained; ${trusted}/${available} beat baseline validation.`,
);
