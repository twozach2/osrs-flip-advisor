function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function calculateMaxDrawdown(values) {
  let peak = 0;
  let maximumDrawdown = 0;

  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) {
      maximumDrawdown = Math.max(maximumDrawdown, (peak - value) / peak);
    }
  }

  return maximumDrawdown;
}

function findPriceNear(samples, targetTimestamp) {
  let closest = null;

  for (const sample of samples) {
    if (sample[0] > targetTimestamp) {
      break;
    }
    closest = sample;
  }

  return closest?.[1] || null;
}

export function analyzeRisk(samples = [], context = {}) {
  const now = Number(context.nowSeconds) || Date.now() / 1000;
  const validSamples = samples
    .filter(
      (sample) =>
        Array.isArray(sample) &&
        Number.isFinite(sample[0]) &&
        Number.isFinite(sample[1]) &&
        sample[1] > 0,
    )
    .sort((left, right) => left[0] - right[0]);
  const prices = validSamples.map((sample) => sample[1]);
  const returns = [];

  for (let index = 1; index < validSamples.length; index += 1) {
    const previous = validSamples[index - 1];
    const current = validSamples[index];
    const elapsedMinutes = (current[0] - previous[0]) / 60;

    if (elapsedMinutes <= 0 || elapsedMinutes > 120) {
      continue;
    }

    const observedReturn = current[1] / previous[1] - 1;
    returns.push(observedReturn / Math.sqrt(elapsedMinutes / 5));
  }

  const historyHours =
    validSamples.length > 1
      ? (validSamples.at(-1)[0] - validSamples[0][0]) / 3600
      : 0;
  const expectedSamples = Math.max(1, Math.min(historyHours * 12, 7 * 24 * 12));
  const sampleCoverage = clamp(validSamples.length / expectedSamples, 0, 1);
  const historyConfidence = clamp(
    Math.min(historyHours / (7 * 24), 1) * sampleCoverage,
    0,
    1,
  );
  const fiveMinuteVolatility = standardDeviation(returns);
  const hourlyVolatility = fiveMinuteVolatility * Math.sqrt(12);
  const maxDrawdown = calculateMaxDrawdown(prices);
  const worstMove = Math.abs(Math.min(0, ...returns));
  const currentMid =
    Number(context.currentMid) || prices.at(-1) || Number(context.buyOffer) || 0;
  const price24HoursAgo = findPriceNear(validSamples, now - 24 * 60 * 60);
  const trend24h =
    price24HoursAgo && currentMid > 0 ? currentMid / price24HoursAgo - 1 : 0;
  const liquidationHours =
    Number(context.hourlyRoundTrips) > 0
      ? Number(context.quantity || 0) / Number(context.hourlyRoundTrips)
      : 24;
  const spreadRatio = Math.max(0, Number(context.spreadRatio) || 0);
  const liveMomentum = Number(context.momentum) || 0;
  const catalogNew = Boolean(context.catalogNew);

  const volatilityRisk = clamp(hourlyVolatility / 0.04, 0, 1) * 22;
  const drawdownRisk = clamp(maxDrawdown / 0.2, 0, 1) * 22;
  const shockRisk = clamp(worstMove / 0.06, 0, 1) * 12;
  const trendRisk =
    clamp(Math.abs(Math.min(0, trend24h, liveMomentum)) / 0.12, 0, 1) * 12;
  const liquidityRisk = clamp(liquidationHours / 6, 0, 1) * 10;
  const spreadRisk = clamp(spreadRatio / 0.2, 0, 1) * 7;
  const historyRisk = (1 - historyConfidence) * 10;
  const newItemRisk = catalogNew ? 15 : 0;
  const score = Math.round(
    clamp(
      volatilityRisk +
        drawdownRisk +
        shockRisk +
        trendRisk +
        liquidityRisk +
        spreadRisk +
        historyRisk +
        newItemRisk,
      0,
      100,
    ),
  );
  const estimatedDownside = clamp(
    Math.max(
      0.02,
      hourlyVolatility * 2.5,
      worstMove * 1.5,
      maxDrawdown * 0.35,
      Math.abs(Math.min(0, liveMomentum)) * 2,
      catalogNew ? 0.12 : 0,
      historyConfidence < 0.25 ? 0.08 : 0,
    ),
    0.02,
    0.5,
  );
  const reasons = [];

  if (catalogNew) {
    reasons.push("Newly observed item");
  }
  if (historyConfidence < 0.25) {
    reasons.push("Limited local history");
  }
  if (hourlyVolatility >= 0.04) {
    reasons.push("High short-term volatility");
  }
  if (maxDrawdown >= 0.1) {
    reasons.push("Large historical drawdown");
  }
  if (trend24h <= -0.05 || liveMomentum <= -0.03) {
    reasons.push("Negative price trend");
  }
  if (liquidationHours >= 2) {
    reasons.push("Slow modeled exit");
  }
  if (spreadRatio >= 0.1) {
    reasons.push("Wide observed spread");
  }

  return {
    score,
    band: score < 30 ? "Low" : score < 50 ? "Medium" : score < 70 ? "High" : "Extreme",
    reasons,
    historyHours,
    historyConfidence,
    sampleCount: validSamples.length,
    hourlyVolatility,
    maxDrawdown,
    worstMove,
    trend24h,
    liquidationHours,
    estimatedDownside,
    catalogNew,
  };
}
