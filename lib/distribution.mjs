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
      value: Math.log(sample[1]),
      weight:
        (representativeInterval / (5 * 60)) *
        Math.exp(
          (-Math.log(2) * Math.max(0, nowSeconds - sample[0])) /
            (halfLifeHours * 60 * 60),
        ),
    };
  });
  const medianLog = weightedQuantile(weightedLogs, 0.5);

  if (medianLog === null) {
    return {
      available: false,
      sampleCount: 0,
      windowHours,
      halfLifeHours,
    };
  }

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
  const medianSpread = median(
    valid
      .map((sample) => Number(sample[2]))
      .filter((spread) => Number.isFinite(spread) && spread > 0),
  );
  const robustSigma = Math.max(
    madSigma,
    iqrSigma,
    medianSpread / 4,
    0.0025,
  );
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
  const fairValue = Math.round(Math.exp(medianLog));
  const buyTarget = Math.max(
    1,
    Math.round(Math.exp(medianLog - entrySigma * robustSigma)),
  );
  const sellTarget = Math.max(
    buyTarget + 1,
    Math.round(Math.exp(medianLog + exitSigma * robustSigma)),
  );
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
    latestPrice,
    zScore,
    medianSpread,
  };
}
