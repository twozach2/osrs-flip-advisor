import { analyzeRisk } from "./risk.mjs";

export const GE_TAX_RATE = 0.02;
export const GE_TAX_CAP = 5_000_000;

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function calculateTax(sellPrice) {
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    return 0;
  }

  return Math.min(Math.floor(sellPrice * GE_TAX_RATE), GE_TAX_CAP);
}

export function calculateOffers(
  lowPrice,
  highPrice,
  buyEdgePercent = 0.05,
  sellEdgePercent = buyEdgePercent,
) {
  if (
    !Number.isFinite(lowPrice) ||
    !Number.isFinite(highPrice) ||
    lowPrice <= 0 ||
    highPrice <= lowPrice
  ) {
    return null;
  }

  const rawSpread = highPrice - lowPrice;
  const buyImprovement = Math.max(
    1,
    Math.floor(rawSpread * clamp(buyEdgePercent, 0, 0.25)),
  );
  const sellImprovement = Math.max(
    1,
    Math.floor(rawSpread * clamp(sellEdgePercent, 0, 0.25)),
  );
  const buyOffer = lowPrice + buyImprovement;
  const sellOffer = highPrice - sellImprovement;

  if (sellOffer <= buyOffer) {
    return null;
  }

  const tax = calculateTax(sellOffer);
  const profit = sellOffer - buyOffer - tax;

  if (profit <= 0) {
    return null;
  }

  return {
    buyOffer,
    sellOffer,
    tax,
    profit,
    roi: profit / buyOffer,
    rawSpread,
  };
}

function getVolume(snapshot) {
  return {
    high: Number(snapshot?.highPriceVolume) || 0,
    low: Number(snapshot?.lowPriceVolume) || 0,
  };
}

function averageMidpoint(snapshot) {
  const high = Number(snapshot?.avgHighPrice);
  const low = Number(snapshot?.avgLowPrice);

  if (Number.isFinite(high) && Number.isFinite(low) && high > 0 && low > 0) {
    return (high + low) / 2;
  }

  return null;
}

function freshnessScore(ageMinutes, maximumAgeMinutes) {
  if (ageMinutes <= 1) {
    return 1;
  }

  return clamp(1 - ageMinutes / Math.max(maximumAgeMinutes, 1), 0, 1);
}

function liquidityScore(hourlyRoundTrips) {
  return clamp(Math.log10(hourlyRoundTrips + 1) / 4, 0, 1);
}

function spreadScore(spreadRatio) {
  if (spreadRatio <= 0.02) {
    return 1;
  }

  if (spreadRatio <= 0.08) {
    return 0.85;
  }

  if (spreadRatio <= 0.2) {
    return 0.55;
  }

  return 0.2;
}

export function buildOpportunity(record, settings, nowSeconds = Date.now() / 1000) {
  const { item, latest, fiveMinute, oneHour } = record;

  const highAgeMinutes = Math.max(0, (nowSeconds - Number(latest.highTime || 0)) / 60);
  const lowAgeMinutes = Math.max(0, (nowSeconds - Number(latest.lowTime || 0)) / 60);
  const ageMinutes = Math.max(highAgeMinutes, lowAgeMinutes);
  const hourly = getVolume(oneHour);
  const five = getVolume(fiveMinute);
  const hourlyRoundTrips = Math.min(hourly.high, hourly.low);
  const fiveMinuteRoundTrips = Math.min(five.high, five.low);
  const expectedFiveMinuteVolume = Math.max(hourlyRoundTrips / 12, 1);
  const recentActivityRatio = fiveMinuteRoundTrips / expectedFiveMinuteVolume;
  const fiveMinuteMidpoint = averageMidpoint(fiveMinute);
  const oneHourMidpoint = averageMidpoint(oneHour);
  const momentum =
    fiveMinuteMidpoint && oneHourMidpoint
      ? (fiveMinuteMidpoint - oneHourMidpoint) / oneHourMidpoint
      : 0;
  const totalFiveMinuteVolume = five.high + five.low;
  const buyPressure =
    totalFiveMinuteVolume > 0 ? (five.high - five.low) / totalFiveMinuteVolume : 0;
  const activityAdjustment = clamp(
    Math.log2(Math.max(recentActivityRatio, 0.25)) * 0.01,
    -0.02,
    0.04,
  );
  const pressureAdjustment = clamp(buyPressure * 0.03, -0.025, 0.025);
  const buyEdgePercent = settings.adaptiveOffers
    ? clamp(settings.edgePercent + activityAdjustment + pressureAdjustment, 0, 0.25)
    : settings.edgePercent;
  const sellEdgePercent = settings.adaptiveOffers
    ? clamp(settings.edgePercent + activityAdjustment - pressureAdjustment, 0, 0.25)
    : settings.edgePercent;
  const offers = calculateOffers(
    latest?.low,
    latest?.high,
    buyEdgePercent,
    sellEdgePercent,
  );

  if (!offers || !item?.limit) {
    return null;
  }

  const spreadRatio = offers.rawSpread / offers.buyOffer;

  if (
    ageMinutes > settings.maxAgeMinutes ||
    offers.profit < settings.minProfit ||
    offers.roi < settings.minRoi ||
    hourlyRoundTrips < settings.minHourlyVolume ||
    spreadRatio > settings.maxSpreadRatio
  ) {
    return null;
  }

  const freshness = freshnessScore(ageMinutes, settings.maxAgeMinutes);
  const liquidity = liquidityScore(hourlyRoundTrips);
  const spreadQuality = spreadScore(spreadRatio);
  const activityQuality = clamp(recentActivityRatio / 2, 0, 1);
  const trendStability = clamp(1 - Math.abs(momentum) / 0.03, 0, 1);
  const confidence = Math.round(
    100 *
      (0.25 * freshness +
        0.3 * liquidity +
        0.15 * spreadQuality +
        0.15 * activityQuality +
        0.15 * trendStability),
  );
  const fillEstimate = clamp(
    0.15 + 0.35 * freshness + 0.25 * liquidity + 0.25 * activityQuality,
    0.1,
    0.95,
  );

  const liquidityQuantity = Math.max(
    1,
    Math.floor(hourlyRoundTrips * settings.cycleHours * settings.participationRate),
  );
  const positionBudget = Math.min(
    settings.slotBudget,
    finiteOr(settings.capital, settings.slotBudget) *
      finiteOr(settings.maxPositionPercent, 1),
  );
  const slotQuantity = Math.floor(positionBudget / offers.buyOffer);
  const baseQuantity = Math.min(item.limit, liquidityQuantity, slotQuantity);

  if (baseQuantity < 1) {
    return null;
  }

  const currentMid = (offers.buyOffer + offers.sellOffer) / 2;
  const risk = analyzeRisk(record.history, {
    nowSeconds,
    currentMid,
    buyOffer: offers.buyOffer,
    quantity: baseQuantity,
    hourlyRoundTrips,
    spreadRatio,
    momentum,
    catalogNew: record.catalogNew,
  });

  if (risk.score > finiteOr(settings.maxRiskScore, 100)) {
    return null;
  }

  const maximumLoss =
    finiteOr(settings.capital, settings.slotBudget) *
    finiteOr(settings.maxLossPercent, 1);
  const riskBudgetQuantity = Math.floor(
    maximumLoss / Math.max(offers.buyOffer * risk.estimatedDownside, 1),
  );
  const riskScale = clamp(1 - Math.max(0, risk.score - 20) / 100, 0.25, 1);
  const scaledQuantity = Math.max(1, Math.floor(baseQuantity * riskScale));
  const quantity = Math.min(baseQuantity, scaledQuantity, riskBudgetQuantity);

  if (quantity < 1) {
    return null;
  }

  const cycleProfit = offers.profit * quantity;
  const cyclesPerWeek = 168 / settings.cycleHours;
  const cycleUnitsPerWeek = quantity * cyclesPerWeek;
  const buyLimitUnitsPerWeek = item.limit * 42;
  const weeklyUnits = Math.min(cycleUnitsPerWeek, buyLimitUnitsPerWeek);
  const weeklyModel = Math.floor(offers.profit * weeklyUnits);
  const expectedWeeklyProfit = Math.floor(weeklyModel * fillEstimate);
  const capitalRequired = offers.buyOffer * quantity;
  const estimatedPositionLoss = Math.floor(
    capitalRequired * risk.estimatedDownside,
  );
  const reviewPrice = Math.max(
    1,
    Math.floor(offers.buyOffer * (1 - risk.estimatedDownside)),
  );
  const velocity = hourlyRoundTrips / Math.max(item.limit, 1);
  const riskQuality = clamp(1 - risk.score / 100, 0.05, 1);
  const volumeScore =
    Math.log10(hourlyRoundTrips + 1) *
    Math.log10(cycleProfit + 10) *
    (confidence / 100) *
    riskQuality;
  const marginScore =
    Math.log10(offers.profit + 10) *
    Math.log10(weeklyModel + 10) *
    (confidence / 100) *
    riskQuality;
  const balancedScore =
    Math.log10(expectedWeeklyProfit + 10) *
    Math.log10(hourlyRoundTrips + 10) *
    (confidence / 100) *
    riskQuality;

  return {
    id: item.id,
    name: item.name,
    members: item.members,
    limit: item.limit,
    ...offers,
    quantity,
    capitalRequired,
    estimatedPositionLoss,
    reviewPrice,
    cycleProfit,
    weeklyModel,
    expectedWeeklyProfit,
    weeklyUnits: Math.floor(weeklyUnits),
    fillEstimate,
    confidence,
    ageMinutes,
    hourlyHighVolume: hourly.high,
    hourlyLowVolume: hourly.low,
    hourlyRoundTrips,
    fiveMinuteRoundTrips,
    recentActivityRatio,
    momentum,
    buyPressure,
    buyEdgePercent,
    sellEdgePercent,
    spreadRatio,
    velocity,
    volumeScore,
    marginScore,
    balancedScore,
    risk,
  };
}

export function rankOpportunities(records, rawSettings = {}) {
  const capital = finiteOr(rawSettings.capital, 100_000_000);
  const slots = clamp(Math.floor(finiteOr(rawSettings.slots, 8)), 1, 8);
  const reservePercent = clamp(finiteOr(rawSettings.reservePercent, 20), 0, 80);
  const investableCapital = capital * (1 - reservePercent / 100);
  const settings = {
    capital,
    slots,
    reservePercent,
    slotBudget: investableCapital / slots,
    edgePercent: clamp(finiteOr(rawSettings.edgePercent, 0.05), 0, 0.25),
    maxAgeMinutes: clamp(finiteOr(rawSettings.maxAgeMinutes, 15), 1, 240),
    minProfit: Math.max(0, finiteOr(rawSettings.minProfit, 100)),
    minRoi: Math.max(0, finiteOr(rawSettings.minRoi, 0.0025)),
    minHourlyVolume: Math.max(0, finiteOr(rawSettings.minHourlyVolume, 25)),
    maxSpreadRatio: clamp(finiteOr(rawSettings.maxSpreadRatio, 0.25), 0.01, 2),
    cycleHours: clamp(finiteOr(rawSettings.cycleHours, 8), 1, 48),
    participationRate: clamp(
      finiteOr(rawSettings.participationRate, 0.02),
      0.001,
      0.25,
    ),
    adaptiveOffers: rawSettings.adaptiveOffers !== false,
    maxRiskScore: clamp(finiteOr(rawSettings.maxRiskScore, 65), 0, 100),
    maxLossPercent: clamp(finiteOr(rawSettings.maxLossPercent, 0.005), 0.0001, 0.1),
    maxPositionPercent: clamp(
      finiteOr(rawSettings.maxPositionPercent, 0.125),
      0.005,
      1,
    ),
  };

  const opportunities = records
    .map((record) => buildOpportunity(record, settings))
    .filter(Boolean);

  const highVolume = [...opportunities]
    .sort((left, right) => right.volumeScore - left.volumeScore)
    .slice(0, 100);
  const highMargin = [...opportunities]
    .sort(
      (left, right) =>
        right.expectedWeeklyProfit - left.expectedWeeklyProfit ||
        right.marginScore - left.marginScore,
    )
    .slice(0, 100);
  const balanced = [...opportunities]
    .sort((left, right) => right.balancedScore - left.balancedScore)
    .slice(0, 100);
  const lowRisk = [...opportunities]
    .sort(
      (left, right) =>
        left.risk.score - right.risk.score ||
        right.expectedWeeklyProfit - left.expectedWeeklyProfit,
    )
    .slice(0, 100);

  return {
    settings,
    balanced,
    highVolume,
    highMargin,
    lowRisk,
  };
}
