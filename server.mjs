import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryStore } from "./lib/history-store.mjs";
import {
  buildDistributionGuidance,
  calculateTax,
  rankOpportunities,
} from "./lib/market.mjs";
import { TradeStore } from "./lib/trade-store.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_ROOT = join(ROOT, "public");
const DATA_ROOT = process.env.OSRS_FLIP_DATA_DIR || join(ROOT, "data");
const PORT = Number(process.env.PORT) || 4173;
const API_ROOT = "https://prices.runescape.wiki/api/v1/osrs";
const USER_AGENT =
  process.env.OSRS_FLIP_USER_AGENT ||
  "osrs-flip-advisor/0.1 (local market research; set OSRS_FLIP_USER_AGENT for contact)";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const cache = new Map();
const backfillAttempts = new Map();
let lastBackfillBatchAt = 0;
const historyStore = new HistoryStore(
  join(DATA_ROOT, "market-history.jsonl"),
  join(DATA_ROOT, "item-catalog.json"),
);
const tradeStore = new TradeStore(join(DATA_ROOT, "trades.json"));

await Promise.all([historyStore.init(), tradeStore.init()]);
await mkdir(DATA_ROOT, { recursive: true });

const tokenPath = join(DATA_ROOT, "ingest-token.txt");
let ingestToken;
try {
  ingestToken = (await readFile(tokenPath, "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
  ingestToken = randomBytes(24).toString("hex");
  await writeFile(tokenPath, `${ingestToken}\n`, "utf8");
}

async function fetchJson(path, ttlMilliseconds) {
  const cached = cache.get(path);
  const now = Date.now();

  if (cached && now - cached.savedAt < ttlMilliseconds) {
    return cached.value;
  }

  const response = await fetch(`${API_ROOT}/${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`Price API returned ${response.status} for ${path}`);
  }

  const value = await response.json();
  cache.set(path, { savedAt: now, value });
  return value;
}

function objectEntries(data) {
  return Object.entries(data || {});
}

async function loadMarketRecords() {
  const [mapping, latest, fiveMinute, oneHour] = await Promise.all([
    fetchJson("mapping", 6 * 60 * 60 * 1000),
    fetchJson("latest", 15 * 1000),
    fetchJson("5m", 30 * 1000),
    fetchJson("1h", 60 * 1000),
  ]);

  const items = new Map(mapping.map((item) => [String(item.id), item]));
  const fiveMinuteData = fiveMinute.data || {};
  const oneHourData = oneHour.data || {};

  await historyStore.updateCatalog(mapping);
  const records = objectEntries(latest.data).flatMap(([id, price]) => {
    const item = items.get(id);
    if (!item) {
      return [];
    }

    return [
      {
        item,
        latest: price,
        fiveMinute: fiveMinuteData[id],
        oneHour: oneHourData[id],
      },
    ];
  });

  await historyStore.record(records);
  await backfillLiquidHistory(records);
  return records.map((record) => ({
    ...record,
    history: historyStore.getSamples(record.item.id),
    ...historyStore.getMetadata(record.item.id),
  }));
}

async function backfillLiquidHistory(records) {
  const now = Date.now();
  if (now - lastBackfillBatchAt < 6 * 60 * 60 * 1000) {
    return;
  }
  lastBackfillBatchAt = now;

  const candidates = [...records]
    .filter(
      (record) =>
        Number(record.latest?.high) > 0 &&
        Number(record.latest?.low) > 0 &&
        historyStore.getSamples(record.item.id).length < 24 &&
        now - (backfillAttempts.get(record.item.id) || 0) > 6 * 60 * 60 * 1000,
    )
    .sort((left, right) => historyCandidateScore(right) - historyCandidateScore(left))
    .slice(0, 24);

  for (let index = 0; index < candidates.length; index += 4) {
    const batch = candidates.slice(index, index + 4);
    await Promise.all(
      batch.map(async (record) => {
        backfillAttempts.set(record.item.id, now);
        try {
          const response = await fetchJson(
            `timeseries?timestep=1h&id=${record.item.id}`,
            6 * 60 * 60 * 1000,
          );
          await historyStore.importSeries(record.item.id, response.data);
        } catch (error) {
          console.error(
            `History backfill failed for item ${record.item.id}:`,
            error.message,
          );
        }
      }),
    );
  }
}

function historyCandidateScore(record) {
  const volume = Math.min(
    Number(record.oneHour?.highPriceVolume) || 0,
    Number(record.oneHour?.lowPriceVolume) || 0,
  );
  const high = Number(record.latest?.high) || 0;
  const low = Number(record.latest?.low) || 0;
  const netPerItem =
    high > low ? Math.max(0, high - low - calculateTax(high)) : 0;
  return (
    Math.log10(volume + 1) *
    Math.log10(netPerItem + 10) *
    Math.log10(Math.max(high, 10))
  );
}

function numberParameter(searchParams, name, fallback) {
  const raw = searchParams.get(name);
  if (raw === null || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function guidanceSettingsFromParams(searchParams) {
  return {
    distributionWindowHours: numberParameter(
      searchParams,
      "distributionWindowHours",
      72,
    ),
    distributionHalfLifeHours: numberParameter(
      searchParams,
      "distributionHalfLifeHours",
      24,
    ),
    entrySigma: numberParameter(searchParams, "entrySigma", 0.75),
    exitSigma: numberParameter(searchParams, "exitSigma", 0.75),
    maxExitSigma: numberParameter(searchParams, "maxExitSigma", 3),
    minimumDistributionSamples: numberParameter(
      searchParams,
      "minimumDistributionSamples",
      24,
    ),
  };
}

function searchScore(record, query, numericId) {
  if (numericId && record.item.id === numericId) {
    return 1000;
  }

  const name = String(record.item.name || "").toLowerCase();
  if (name === query) {
    return 900;
  }
  if (name.startsWith(query)) {
    return 700 - name.length / 100;
  }
  if (name.includes(query)) {
    return 500 - name.indexOf(query) - name.length / 100;
  }

  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length && tokens.every((token) => name.includes(token))) {
    return 300 - name.length / 100;
  }

  return 0;
}

async function serveOpportunities(requestUrl, response) {
  const records = await loadMarketRecords();
  const settings = {
    capital: numberParameter(requestUrl.searchParams, "capital", 100_000_000),
    slots: numberParameter(requestUrl.searchParams, "slots", 8),
    reservePercent: numberParameter(requestUrl.searchParams, "reservePercent", 20),
    edgePercent: numberParameter(requestUrl.searchParams, "edgePercent", 0.05),
    maxAgeMinutes: numberParameter(requestUrl.searchParams, "maxAgeMinutes", 15),
    minProfit: numberParameter(requestUrl.searchParams, "minProfit", 100),
    minRoi: numberParameter(requestUrl.searchParams, "minRoi", 0.0025),
    minHourlyVolume: numberParameter(requestUrl.searchParams, "minHourlyVolume", 25),
    maxSpreadRatio: numberParameter(requestUrl.searchParams, "maxSpreadRatio", 0.25),
    cycleHours: numberParameter(requestUrl.searchParams, "cycleHours", 8),
    participationRate: numberParameter(requestUrl.searchParams, "participationRate", 0.02),
    adaptiveOffers: requestUrl.searchParams.get("adaptiveOffers") !== "false",
    requireDistribution: requestUrl.searchParams.get("requireDistribution") !== "false",
    distributionWindowHours: numberParameter(
      requestUrl.searchParams,
      "distributionWindowHours",
      72,
    ),
    distributionHalfLifeHours: numberParameter(
      requestUrl.searchParams,
      "distributionHalfLifeHours",
      24,
    ),
    entrySigma: numberParameter(requestUrl.searchParams, "entrySigma", 0.75),
    exitSigma: numberParameter(requestUrl.searchParams, "exitSigma", 0.75),
    maxEntryFillHours: numberParameter(requestUrl.searchParams, "maxEntryFillHours", 6),
    maxExitSigma: numberParameter(requestUrl.searchParams, "maxExitSigma", 3),
    minimumDistributionSamples: numberParameter(
      requestUrl.searchParams,
      "minimumDistributionSamples",
      24,
    ),
    maxRiskScore: numberParameter(requestUrl.searchParams, "maxRiskScore", 65),
    maxLossPercent: numberParameter(requestUrl.searchParams, "maxLossPercent", 0.005),
    maxPositionPercent: numberParameter(
      requestUrl.searchParams,
      "maxPositionPercent",
      0.125,
    ),
  };
  const ranked = rankOpportunities(records, settings);

  response.writeHead(200, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  response.end(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "OSRS Wiki Real-time Prices API",
      taxModel: "Conservative 2% seller tax, floored, capped at 5m per item",
      historyStatus: historyStore.getStatus(),
      ...ranked,
    }),
  );
}

async function readJsonBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function itemNames() {
  const mapping = await fetchJson("mapping", 6 * 60 * 60 * 1000);
  return new Map(mapping.map((item) => [Number(item.id), item.name]));
}

async function serveTracking(response) {
  const [names, latest] = await Promise.all([
    itemNames().catch(() => new Map()),
    fetchJson("latest", 15 * 1000).catch(() => ({ data: {} })),
  ]);
  const summary = tradeStore.getSummary();
  const addName = (entry) => ({
    ...entry,
    name: names.get(Number(entry.itemId)) || `Item ${entry.itemId}`,
  });

  response.writeHead(200, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  const positions = summary.positions.map((entry) => {
    const price = latest.data?.[String(entry.itemId)];
    const quickExitPrice = Number(price?.low) || 0;
    const quickExitUnitValue = Math.max(0, quickExitPrice - calculateTax(quickExitPrice));
    const liquidationValue = quickExitUnitValue * entry.quantity;

    return {
      ...addName(entry),
      quickExitPrice,
      liquidationValue,
      unrealizedProfit: quickExitPrice > 0 ? liquidationValue - entry.cost : null,
    };
  });

  response.end(
    JSON.stringify({
      ingestEndpoint: `http://127.0.0.1:${PORT}/api/ge-events`,
      ingestToken,
      ...summary,
      recentFills: summary.recentFills.map(addName),
      recentRealized: summary.recentRealized.map(addName),
      positions,
      openOrders: summary.openOrders.map(addName),
      recentFillSamples: summary.recentFillSamples.map(addName),
    }),
  );
}

async function serveGeEvent(request, response) {
  const payload = await readJsonBody(request);
  const suppliedToken =
    request.headers["x-advisor-token"] || request.headers.authorization || payload.token;

  if (
    suppliedToken !== ingestToken &&
    suppliedToken !== `Bearer ${ingestToken}`
  ) {
    response.writeHead(401, { "Content-Type": contentTypes[".json"] });
    response.end(JSON.stringify({ error: "Invalid ingest token." }));
    return;
  }

  const result =
    String(payload.kind || "").toLowerCase() === "offer"
      ? await tradeStore.ingestOffer(payload)
      : await tradeStore.ingest(payload);
  response.writeHead(200, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(result));
}

function serveHistory(requestUrl, response) {
  const itemId = Number(requestUrl.searchParams.get("id"));
  if (!Number.isInteger(itemId) || itemId <= 0) {
    response.writeHead(400, { "Content-Type": contentTypes[".json"] });
    response.end(JSON.stringify({ error: "A valid item id is required." }));
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  response.end(
    JSON.stringify({
      itemId,
      metadata: historyStore.getMetadata(itemId),
      samples: historyStore.getSamples(itemId),
    }),
  );
}

async function serveGuidance(requestUrl, response) {
  const ids = new Set(
    (requestUrl.searchParams.get("ids") || "")
      .split(",")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 8),
  );
  const records = await loadMarketRecords();
  const settings = guidanceSettingsFromParams(requestUrl.searchParams);
  const guidance = records
    .filter((record) => ids.has(record.item.id))
    .map((record) => buildDistributionGuidance(record, settings))
    .filter(Boolean);

  response.writeHead(200, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ generatedAt: new Date().toISOString(), guidance }));
}

async function serveItemSearch(requestUrl, response) {
  const rawQuery = String(requestUrl.searchParams.get("q") || "").trim();
  const query = rawQuery.toLowerCase();
  const numericId = /^\d+$/.test(rawQuery) ? Number(rawQuery) : null;

  if (!numericId && query.length < 2) {
    response.writeHead(400, { "Content-Type": contentTypes[".json"] });
    response.end(JSON.stringify({ error: "Enter at least two letters or an item id." }));
    return;
  }

  const records = await loadMarketRecords();
  const settings = guidanceSettingsFromParams(requestUrl.searchParams);
  const matches = records
    .map((record) => ({ record, score: searchScore(record, query, numericId) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(left.record.item.name).localeCompare(String(right.record.item.name)),
    )
    .slice(0, 10)
    .map(({ record, score }) => ({
      score,
      guidance: buildDistributionGuidance(record, settings),
    }))
    .filter((entry) => entry.guidance);

  response.writeHead(200, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
  });
  response.end(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      query: rawQuery,
      matches,
    }),
  );
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const absolutePath = join(PUBLIC_ROOT, safePath);

  if (!absolutePath.startsWith(PUBLIC_ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(absolutePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(absolutePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/opportunities") {
      await serveOpportunities(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/tracking" && request.method === "GET") {
      await serveTracking(response);
      return;
    }

    if (requestUrl.pathname === "/api/ge-events" && request.method === "POST") {
      await serveGeEvent(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/history" && request.method === "GET") {
      serveHistory(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/guidance" && request.method === "GET") {
      await serveGuidance(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/item-search" && request.method === "GET") {
      await serveItemSearch(requestUrl, response);
      return;
    }

    await serveStatic(requestUrl.pathname, response);
  } catch (error) {
    console.error(error);
    response.writeHead(502, {
      "Content-Type": contentTypes[".json"],
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        error: "Could not load current market data.",
        detail: error.message,
      }),
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`OSRS Flip Advisor: http://127.0.0.1:${PORT}`);
});

const historyTimer = setInterval(() => {
  loadMarketRecords().catch((error) => {
    console.error("Background market snapshot failed:", error.message);
  });
}, 5 * 60 * 1000);
historyTimer.unref();

loadMarketRecords().catch((error) => {
  console.error("Initial market snapshot failed:", error.message);
});
