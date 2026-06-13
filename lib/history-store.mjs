import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FIVE_MINUTES = 5 * 60;
const RETENTION_SECONDS = 14 * 24 * 60 * 60;
const MAX_ITEMS_PER_SNAPSHOT = 400;

function midpoint(record) {
  const fiveHigh = Number(record.fiveMinute?.avgHighPrice);
  const fiveLow = Number(record.fiveMinute?.avgLowPrice);

  if (fiveHigh > 0 && fiveLow > 0) {
    return Math.round((fiveHigh + fiveLow) / 2);
  }

  const latestHigh = Number(record.latest?.high);
  const latestLow = Number(record.latest?.low);
  return latestHigh > 0 && latestLow > 0
    ? Math.round((latestHigh + latestLow) / 2)
    : 0;
}

function hourlyVolume(record) {
  return Math.min(
    Number(record.oneHour?.highPriceVolume) || 0,
    Number(record.oneHour?.lowPriceVolume) || 0,
  );
}

export class HistoryStore {
  constructor(historyPath, catalogPath) {
    this.historyPath = historyPath;
    this.catalogPath = catalogPath;
    this.samples = new Map();
    this.catalog = { initializedAt: null, items: {} };
    this.lastBucket = 0;
    this.lastCompaction = 0;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.historyPath), { recursive: true });

    try {
      this.catalog = JSON.parse(await readFile(this.catalogPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const content = await readFile(this.historyPath, "utf8");
      const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;

      for (const line of content.split(/\r?\n/)) {
        if (!line) {
          continue;
        }

        try {
          const snapshot = JSON.parse(line);
          if (!Number.isFinite(snapshot.t) || snapshot.t < cutoff) {
            continue;
          }

          this.lastBucket = Math.max(this.lastBucket, snapshot.t);
          this.addSnapshot(snapshot);
        } catch {
          // Ignore an incomplete final line after an interrupted write.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async updateCatalog(items) {
    const now = new Date().toISOString();
    const initialCatalog = !this.catalog.initializedAt;
    let changed = false;

    if (initialCatalog) {
      this.catalog.initializedAt = now;
      changed = true;
    }

    for (const item of items) {
      const id = String(item.id);
      if (!this.catalog.items[id]) {
        this.catalog.items[id] = {
          firstSeen: now,
          baseline: initialCatalog,
        };
        changed = true;
      }
    }

    if (changed) {
      await this.writeCatalog();
    }
  }

  getMetadata(itemId) {
    const metadata = this.catalog.items[String(itemId)];
    if (!metadata) {
      return { catalogNew: true, firstSeen: null };
    }

    return {
      catalogNew: metadata.baseline === false,
      firstSeen: metadata.firstSeen,
    };
  }

  getSamples(itemId) {
    return this.samples.get(String(itemId)) || [];
  }

  async importSeries(itemId, points) {
    const id = String(itemId);
    const existing = new Set(this.getSamples(id).map((sample) => sample[0]));
    const snapshots = [];

    for (const point of points || []) {
      const timestamp = Number(point.timestamp);
      const high = Number(point.avgHighPrice);
      const low = Number(point.avgLowPrice);
      const highVolume = Number(point.highPriceVolume) || 0;
      const lowVolume = Number(point.lowPriceVolume) || 0;

      if (
        !Number.isFinite(timestamp) ||
        existing.has(timestamp) ||
        high <= 0 ||
        low <= 0
      ) {
        continue;
      }

      const mid = Math.round((high + low) / 2);
      const spread = Math.max(0, (high - low) / mid);
      const snapshot = {
        t: timestamp,
        d: [[Number(itemId), mid, Math.round(spread * 1_000_000), Math.min(highVolume, lowVolume)]],
      };
      snapshots.push(snapshot);
      existing.add(timestamp);
      this.addSnapshot(snapshot);
    }

    if (!snapshots.length) {
      return 0;
    }

    snapshots.sort((left, right) => left.t - right.t);
    this.writeChain = this.writeChain.then(() =>
      appendFile(
        this.historyPath,
        `${snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n")}\n`,
        "utf8",
      ),
    );
    await this.writeChain;
    return snapshots.length;
  }

  getStatus() {
    let totalSamples = 0;
    for (const samples of this.samples.values()) {
      totalSamples += samples.length;
    }

    return {
      trackedItems: this.samples.size,
      totalSamples,
      lastSnapshotAt: this.lastBucket
        ? new Date(this.lastBucket * 1000).toISOString()
        : null,
      retentionDays: RETENTION_SECONDS / (24 * 60 * 60),
    };
  }

  async record(records, nowSeconds = Math.floor(Date.now() / 1000)) {
    const bucket = Math.floor(nowSeconds / FIVE_MINUTES) * FIVE_MINUTES;
    if (bucket <= this.lastBucket) {
      return false;
    }

    const data = records
      .map((record) => {
        const mid = midpoint(record);
        const volume = hourlyVolume(record);
        const high = Number(record.latest?.high) || 0;
        const low = Number(record.latest?.low) || 0;
        const newestTrade = Math.max(
          Number(record.latest?.highTime) || 0,
          Number(record.latest?.lowTime) || 0,
        );

        return {
          id: record.item.id,
          mid,
          volume,
          spread: mid > 0 && high > low ? (high - low) / mid : 0,
          age: nowSeconds - newestTrade,
        };
      })
      .filter((entry) => entry.mid > 0 && entry.volume > 0 && entry.age <= 2 * 60 * 60)
      .sort((left, right) => right.volume - left.volume)
      .slice(0, MAX_ITEMS_PER_SNAPSHOT)
      .map((entry) => [
        entry.id,
        entry.mid,
        Math.round(entry.spread * 1_000_000),
        entry.volume,
      ]);

    const snapshot = { t: bucket, d: data };
    this.addSnapshot(snapshot);
    this.lastBucket = bucket;
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.historyPath, `${JSON.stringify(snapshot)}\n`, "utf8"),
    );
    await this.writeChain;

    if (bucket - this.lastCompaction >= 24 * 60 * 60) {
      this.lastCompaction = bucket;
      await this.compact(bucket - RETENTION_SECONDS);
    }

    return true;
  }

  addSnapshot(snapshot) {
    for (const entry of snapshot.d || []) {
      const id = String(entry[0]);
      const samples = this.samples.get(id) || [];
      samples.push([snapshot.t, Number(entry[1]), Number(entry[2]) / 1_000_000, entry[3]]);
      this.samples.set(id, samples);
    }
  }

  async compact(cutoff) {
    let content;
    try {
      content = await readFile(this.historyPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const retained = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      try {
        const snapshot = JSON.parse(line);
        if (snapshot.t >= cutoff) {
          retained.push(JSON.stringify(snapshot));
        }
      } catch {
        // Drop malformed lines during compaction.
      }
    }

    const temporaryPath = `${this.historyPath}.tmp`;
    await writeFile(
      temporaryPath,
      retained.length ? `${retained.join("\n")}\n` : "",
      "utf8",
    );
    await rename(temporaryPath, this.historyPath);

    for (const [id, samples] of this.samples) {
      const current = samples.filter((sample) => sample[0] >= cutoff);
      if (current.length) {
        this.samples.set(id, current);
      } else {
        this.samples.delete(id);
      }
    }
  }

  async writeCatalog() {
    const temporaryPath = `${this.catalogPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.catalog, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.catalogPath);
  }
}
