function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function weightedQuantile(entries, probability) {
  if (!entries.length) {
    return null;
  }

  const sorted = [...entries].sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  const target = clamp(probability, 0, 1) * totalWeight;
  let cumulative = 0;

  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= target) {
      return entry.value;
    }
  }

  return sorted.at(-1).value;
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

const DRIFT_GAIN = 1;
const MIN_EFFECTIVE_HALF_LIFE = 4;
const TREND_THRESHOLD = 0.6;
const ASYMMETRY_BLEND_SAMPLES = 24;

function buildWeightedLogs(
  valid,
  nowSeconds,
  halfLifeHours,
  valueOf = (sample) => sample[1],
) {
  let representedSeconds = 0;
  const weightedLogs = valid.map((sample, index) => {
    const previousGap =
      index > 0 ? sample[0] - valid[index - 1][0] : Number.POSITIVE_INFINITY;
    const nextGap =
      index < valid.length - 1
        ? valid[index + 1][0] - sample[0]
        : Number.POSITIVE_INFINITY;
    const representativeInterval = clamp(
      Math.min(previousGap, nextGap),
      5 * 60,
      60 * 60,
    );
    representedSeconds += representativeInterval;

    return {
      time: sample[0],
      value: Math.log(Math.max(1, valueOf(sample))),
      weight:
        (representativeInterval / (5 * 60)) *
        Math.exp(
          (-Math.log(2) * Math.max(0, nowSeconds - sample[0])) /
            (halfLifeHours * 60 * 60),
        ),
    };
  });

  return { weightedLogs, representedSeconds };
}

function sampleBid(sample) {
  const mid = Number(sample[1]);
  const low = sample.length >= 6 ? Number(sample[5]) : NaN;
  if (Number.isFinite(low) && low > 0) {
    return low;
  }
  const spread = Number(sample[2]) || 0;
  return Math.max(1, mid * (1 - spread / 2));
}

function sampleAsk(sample) {
  const mid = Number(sample[1]);
  const high = sample.length >= 6 ? Number(sample[4]) : NaN;
  if (Number.isFinite(high) && high > 0) {
    return high;
  }
  const spread = Number(sample[2]) || 0;
  return Math.max(mid, mid * (1 + spread / 2));
}

function computeDispersion(weightedLogs, medianLog, medianSpread) {
  const q1Log = weightedQuantile(weightedLogs, 0.25);
  const q3Log = weightedQuantile(weightedLogs, 0.75);
  const p10Log = weightedQuantile(weightedLogs, 0.1);
  const p90Log = weightedQuantile(weightedLogs, 0.9);
  const deviations = weightedLogs.map((entry) => ({
    value: Math.abs(entry.value - medianLog),
    weight: entry.weight,
  }));
  const mad = weightedQuantile(deviations, 0.5) || 0;
  const iqrSigma = Math.max(0, (q3Log - q1Log) / 1.349);
  const madSigma = mad * 1.4826;
  const robustSigma = Math.max(madSigma, iqrSigma, medianSpread / 4, 0.0025);

  return { q1Log, q3Log, p10Log, p90Log, robustSigma };
}

function estimateDriftPerHour(weightedLogs) {
  if (weightedLogs.length < 8) {
    return 0;
  }

  const sorted = [...weightedLogs].sort((left, right) => left.time - right.time);
  const split = Math.floor(sorted.length / 2);
  const older = sorted.slice(0, split);
  const recent = sorted.slice(split);
  const olderMedian = weightedQuantile(older, 0.5);
  const recentMedian = weightedQuantile(recent, 0.5);

  if (olderMedian === null || recentMedian === null) {
    return 0;
  }

  const olderTime = median(older.map((entry) => entry.time));
  const recentTime = median(recent.map((entry) => entry.time));
  const deltaHours = (recentTime - olderTime) / 3600;

  if (deltaHours <= 0) {
    return 0;
  }

  return (recentMedian - olderMedian) / deltaHours;
}

export function analyzeDistribution(samples = [], options = {}) {
  const nowSeconds = Number(options.nowSeconds) || Date.now() / 1000;
  const windowHours = clamp(Number(options.windowHours) || 72, 6, 336);
  const halfLifeHours = clamp(
    Number(options.halfLifeHours) || Math.min(24, windowHours / 2),
    2,
    windowHours,
  );
  const entrySigma = clamp(Number(options.entrySigma) || 0.75, 0, 3);
  const exitSigma = clamp(Number(options.exitSigma) || 0.75, 0, 3);
  const minimumSamples = Math.max(8, Number(options.minimumSamples) || 24);
  const adaptiveHorizon = options.adaptiveHorizon !== false;
  const cutoff = nowSeconds - windowHours * 60 * 60;
  const valid = samples
    .filter(
      (sample) =>
        Array.isArray(sample) &&
        Number.isFinite(sample[0]) &&
        Number.isFinite(sample[1]) &&
        sample[0] >= cutoff &&
        sample[1] > 0,
    )
    .sort((left, right) => left[0] - right[0]);
  const medianSpread = median(
    valid
      .map((sample) => Number(sample[2]))
      .filter((spread) => Number.isFinite(spread) && spread > 0),
  );
  const base = buildWeightedLogs(valid, nowSeconds, halfLifeHours);
  let weightedLogs = base.weightedLogs;
  const representedSeconds = base.representedSeconds;
  let medianLog = weightedQuantile(weightedLogs, 0.5);

  if (medianLog === null) {
    return {
      available: false,
      sampleCount: 0,
      windowHours,
      halfLifeHours,
      effectiveHalfLifeHours: halfLifeHours,
      trendStrength: 0,
      driftPerHour: 0,
    };
  }

  let dispersion = computeDispersion(weightedLogs, medianLog, medianSpread);
  let effectiveHalfLifeHours = halfLifeHours;
  let finalHalfLife = halfLifeHours;
  let trendStrength = 0;
  let driftPerHour = 0;

  if (adaptiveHorizon) {
    driftPerHour = estimateDriftPerHour(weightedLogs);
    const rawStrength =
      (Math.abs(driftPerHour) * halfLifeHours) / dispersion.robustSigma;
    trendStrength = clamp(rawStrength - TREND_THRESHOLD, 0, 4);
    effectiveHalfLifeHours = clamp(
      halfLifeHours / (1 + DRIFT_GAIN * trendStrength),
      MIN_EFFECTIVE_HALF_LIFE,
      halfLifeHours,
    );

    if (effectiveHalfLifeHours < halfLifeHours - 0.01) {
      weightedLogs = buildWeightedLogs(
        valid,
        nowSeconds,
        effectiveHalfLifeHours,
      ).weightedLogs;
      medianLog = weightedQuantile(weightedLogs, 0.5);
      dispersion = computeDispersion(weightedLogs, medianLog, medianSpread);
      finalHalfLife = effectiveHalfLifeHours;
    }
  }

  const { q1Log, q3Log, p10Log, p90Log, robustSigma } = dispersion;
  const firstTimestamp = valid[0][0];
  const lastTimestamp = valid.at(-1)[0];
  const historyHours = (lastTimestamp - firstTimestamp) / 3600;
  const representedHours = representedSeconds / 3600;
  const coverage = clamp(
    representedHours / Math.max(1, Math.min(windowHours, historyHours + 1)),
    0,
    1,
  );
  const effectiveWeight = weightedLogs.reduce((sum, entry) => sum + entry.weight, 0);
  const available = valid.length >= minimumSamples && historyHours >= 4;
  const confidence = clamp(
    Math.min(valid.length / 96, 1) *
      Math.min(historyHours / 24, 1) *
      Math.max(0.35, coverage),
    0,
    1,
  );
  const bidLogs = buildWeightedLogs(valid, nowSeconds, finalHalfLife, sampleBid).weightedLogs;
  const askLogs = buildWeightedLogs(valid, nowSeconds, finalHalfLife, sampleAsk).weightedLogs;
  const bidMedianLog = weightedQuantile(bidLogs, 0.5);
  const askMedianLog = weightedQuantile(askLogs, 0.5);
  const rawBidSigma = computeDispersion(bidLogs, bidMedianLog, medianSpread).robustSigma;
  const rawAskSigma = computeDispersion(askLogs, askMedianLog, medianSpread).robustSigma;
  const asymmetricCount = valid.reduce(
    (count, sample) => count + (sample.length >= 7 && sample[6] ? 1 : 0),
    0,
  );
  const asymmetryWeight = Math.min(1, asymmetricCount / ASYMMETRY_BLEND_SAMPLES);
  const bidSigma = asymmetryWeight * rawBidSigma + (1 - asymmetryWeight) * robustSigma;
  const askSigma = asymmetryWeight * rawAskSigma + (1 - asymmetryWeight) * robustSigma;
  const bidFair = Math.round(Math.exp(bidMedianLog));
  const askFair = Math.round(Math.exp(askMedianLog));
  const fairValue = Math.round(Math.exp((bidMedianLog + askMedianLog) / 2));
  const buyTarget = Math.max(
    1,
    Math.round(Math.exp(bidMedianLog - entrySigma * bidSigma)),
  );
  const sellTarget = Math.max(
    buyTarget + 1,
    Math.round(Math.exp(askMedianLog + exitSigma * askSigma)),
  );
  const realizedSpread = askFair - bidFair;
  const latestPrice = valid.at(-1)[1];
  const zScore =
    robustSigma > 0 ? (Math.log(latestPrice) - medianLog) / robustSigma : 0;

  return {
    available,
    sampleCount: valid.length,
    effectiveSamples: effectiveWeight,
    historyHours,
    windowHours,
    halfLifeHours,
    effectiveHalfLifeHours,
    trendStrength,
    driftPerHour,
    coverage,
    confidence,
    fairValue,
    q1: Math.round(Math.exp(q1Log)),
    q3: Math.round(Math.exp(q3Log)),
    p10: Math.round(Math.exp(p10Log)),
    p90: Math.round(Math.exp(p90Log)),
    robustSigma,
    sigmaPercent: Math.exp(robustSigma) - 1,
    entrySigma,
    exitSigma,
    buyTarget,
    sellTarget,
    bidFair,
    askFair,
    bidSigma,
    askSigma,
    asymmetricSamples: asymmetricCount,
    asymmetryWeight,
    realizedSpread,
    latestPrice,
    zScore,
    medianSpread,
  };
}
