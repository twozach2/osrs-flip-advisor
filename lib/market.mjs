import { analyzeDistribution } from "./distribution.mjs";
import { analyzeRisk } from "./risk.mjs";

export const GE_TAX_RATE = 0.02;
export const GE_TAX_CAP = 5_000_000;
export const EXCLUDED_ITEM_IDS = new Set([13190]);

export function isExcludedItem(item) {
  return (
    EXCLUDED_ITEM_IDS.has(Number(item?.id)) ||
    String(item?.name || "").trim().toLowerCase() === "old school bond"
  );
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Closed-form Student-t(df=5) CDF; df=5 keeps fatter-than-Gaussian tails against
// still-finite kurtosis, matching event-driven OSRS moves. Valid for z >= 0.
function studentTCdf(z) {
  const sqrt5 = Math.sqrt(5);
  const denom = Math.sqrt(5 + z * z);
  const sinTheta = z / denom;
  const cosTheta = sqrt5 / denom;
  const cosSquared = cosTheta * cosTheta;
  const theta = Math.atan(z / sqrt5);
  return (
    0.5 + (theta + sinTheta * cosTheta * (1 + (2 / 3) * cosSquared)) / Math.PI
  );
}

// One-sided survival P(T >= z). A Grand Exchange fill is a single-direction event
// (a buy fills only if the price falls to the bid; a sell only if it rises to the
// ask), so fill odds use the upper tail alone rather than two-tail mass, which
// would roughly double a one-sided fill chance.
function studentTOneTailSurvival(z) {
  if (z <= 0) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, 1 - studentTCdf(z)));
}

function survivalProbability(sigmaDistance) {
  if (!Number.isFinite(sigmaDistance)) {
    return 0.02;
  }

  return clamp(studentTOneTailSurvival(Math.max(0, sigmaDistance)), 0.02, 0.9);
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

function calculateTargetOffers(buyOffer, sellOffer) {
  if (
    !Number.isFinite(buyOffer) ||
    !Number.isFinite(sellOffer) ||
    buyOffer <= 0 ||
    sellOffer <= buyOffer
  ) {
    return null;
  }

  const tax = calculateTax(sellOffer);
  const profit = sellOffer - buyOffer - tax;
  if (profit <= 0) {
    return null;
  }

  return {
    buyOffer: Math.round(buyOffer),
    sellOffer: Math.round(sellOffer),
    tax,
    profit,
    roi: profit / buyOffer,
    rawSpread: sellOffer - buyOffer,
  };
}

function minimumSellPrice(buyOffer, minimumProfit, minimumRoi) {
  const desiredProfit = Math.max(
    Number(minimumProfit) || 0,
    buyOffer * (Number(minimumRoi) || 0),
  );
  let low = Math.ceil(buyOffer + desiredProfit);
  let high = Math.ceil(buyOffer + desiredProfit + GE_TAX_CAP + 10);

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

function expectedFillHours(depthSigma, flowPerHour, quantity, capture) {
  const reachProbability = survivalProbability(Math.max(0, depthSigma));
  const filledPerHour = Math.max(0, flowPerHour) * reachProbability * capture;
  if (filledPerHour <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return quantity / filledPerHour;
}

function solveEntryDepth(entrySigma, flowPerHour, quantity, capture, maxHours) {
  if (expectedFillHours(entrySigma, flowPerHour, quantity, capture) <= maxHours) {
    return entrySigma;
  }

  if (expectedFillHours(0, flowPerHour, quantity, capture) > maxHours) {
    return null;
  }

  let low = 0;
  let high = entrySigma;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const mid = (low + high) / 2;
    if (expectedFillHours(mid, flowPerHour, quantity, capture) <= maxHours) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

function calculateDistributionOffers(
  distribution,
  settings,
  buyPrice = distribution.buyTarget,
) {
  if (!distribution.available) {
    return null;
  }

  const requiredSell = minimumSellPrice(
    buyPrice,
    settings.minProfit,
    settings.minRoi,
  );
  const sellTarget = Math.max(distribution.sellTarget, requiredSell);
  const askFair = distribution.askFair || distribution.fairValue;
  const askSigma =
    distribution.askSigma > 0 ? distribution.askSigma : distribution.robustSigma;
  const effectiveExitSigma =
    askSigma > 0
      ? Math.max(0, Math.log(sellTarget / askFair) / askSigma)
      : Number.POSITIVE_INFINITY;

  if (effectiveExitSigma > settings.maxExitSigma) {
    return null;
  }

  const offers = calculateTargetOffers(buyPrice, sellTarget);
  return offers
    ? {
        ...offers,
        effectiveExitSigma,
        taxAdjustedExit: sellTarget > distribution.sellTarget,
      }
    : null;
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

export function buildDistributionGuidance(
  record,
  rawSettings = {},
  nowSeconds = Date.now() / 1000,
) {
  if (isExcludedItem(record.item)) {
    return null;
  }

  const distribution = analyzeDistribution(record.history, {
    nowSeconds,
    windowHours: finiteOr(rawSettings.distributionWindowHours, 72),
    halfLifeHours: finiteOr(rawSettings.distributionHalfLifeHours, 24),
    entrySigma: finiteOr(rawSettings.entrySigma, 0.75),
    exitSigma: finiteOr(rawSettings.exitSigma, 0.75),
    minimumSamples: finiteOr(rawSettings.minimumDistributionSamples, 24),
    adaptiveHorizon: rawSettings.adaptiveHorizon !== false,
  });
  const high = Number(record.latest?.high) || 0;
  const low = Number(record.latest?.low) || 0;
  const currentMid =
    high > 0 && low > 0
      ? (high + low) / 2
      : distribution.latestPrice || distribution.fairValue || 0;

  return {
    id: record.item.id,
    name: record.item.name,
    currentMid,
    latestHigh: high,
    latestLow: low,
    distribution,
    buyTarget: distribution.buyTarget || null,
    sellTarget: distribution.sellTarget || null,
    reviewPrice: distribution.p10 || null,
    updatedAt: new Date(nowSeconds * 1000).toISOString(),
  };
}

export function buildOpportunity(record, settings, nowSeconds = Date.now() / 1000) {
  const { item, latest, fiveMinute, oneHour } = record;

  if (isExcludedItem(item)) {
    return null;
  }

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
  const liveOffers = calculateOffers(
    latest?.low,
    latest?.high,
    buyEdgePercent,
    sellEdgePercent,
  );
  const distribution = analyzeDistribution(record.history, {
    nowSeconds,
    windowHours: settings.distributionWindowHours,
    halfLifeHours: settings.distributionHalfLifeHours,
    entrySigma: settings.entrySigma,
    exitSigma: settings.exitSigma,
    minimumSamples: settings.minimumDistributionSamples,
    adaptiveHorizon: settings.adaptiveHorizon,
  });
  const adaptiveEntry = settings.adaptiveEntry !== false;
  const maxEntryFillHours = clamp(finiteOr(settings.maxEntryFillHours, 6), 0.5, 72);
  const entryFillCapture = clamp(finiteOr(settings.entryFillCapture, 0.5), 0.01, 1);
  const reviewHours = clamp(finiteOr(settings.reviewHours, 1), 0, 72);
  const sellerFlowPerHour = Math.max(hourly.low, 0);
  const buyerFlowPerHour = Math.max(hourly.high, 0);
  const currentMid =
    Number(latest?.high) > 0 && Number(latest?.low) > 0
      ? (Number(latest.high) + Number(latest.low)) / 2
      : distribution.latestPrice || distribution.fairValue || 0;

  // Pass 1: size the position against the untightened (entry-sigma) offers so
  // the entry-fill solve below works on the quantity we will actually hold,
  // rather than a budget-implied maximum that overstates how long fills take.
  const provisionalOffers = calculateDistributionOffers(distribution, settings);
  const sizingOffers = provisionalOffers || liveOffers;

  if (
    !sizingOffers ||
    !item?.limit ||
    (settings.requireDistribution === true && !provisionalOffers)
  ) {
    return null;
  }

  const sizingSpreadRatio = sizingOffers.rawSpread / sizingOffers.buyOffer;
  const liquidityQuantity = Math.max(
    1,
    Math.floor(hourlyRoundTrips * settings.cycleHours * settings.participationRate),
  );
  const positionBudget = Math.min(
    settings.slotBudget,
    finiteOr(settings.capital, settings.slotBudget) *
      finiteOr(settings.maxPositionPercent, 1),
  );
  const slotQuantity = Math.floor(positionBudget / sizingOffers.buyOffer);
  const baseQuantity = Math.min(item.limit, liquidityQuantity, slotQuantity);

  if (baseQuantity < 1) {
    return null;
  }

  const risk = analyzeRisk(record.history, {
    nowSeconds,
    currentMid,
    buyOffer: sizingOffers.buyOffer,
    quantity: baseQuantity,
    hourlyRoundTrips,
    spreadRatio: sizingSpreadRatio,
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
    maximumLoss / Math.max(sizingOffers.buyOffer * risk.estimatedDownside, 1),
  );
  const riskScale = clamp(1 - Math.max(0, risk.score - 20) / 100, 0.25, 1);
  const scaledQuantity = Math.max(1, Math.floor(baseQuantity * riskScale));
  const quantity = Math.min(baseQuantity, scaledQuantity, riskBudgetQuantity);

  if (quantity < 1) {
    return null;
  }

  // Pass 2: resolve the entry depth/price against the final quantity. The
  // physical entry-fill time always reflects that quantity; when adaptive entry
  // cannot fill it within the time budget even at the bid, reject the trade.
  let entryDepth = settings.entrySigma;
  let entryBuyPrice;
  let entryFillHours = 0;
  if (distribution.available) {
    if (adaptiveEntry) {
      const solvedDepth = solveEntryDepth(
        settings.entrySigma,
        sellerFlowPerHour,
        quantity,
        entryFillCapture,
        maxEntryFillHours,
      );
      if (solvedDepth === null) {
        return null;
      }
      entryDepth = solvedDepth;
      if (solvedDepth < settings.entrySigma - 1e-9) {
        const bidFair = distribution.bidFair || distribution.fairValue;
        const bidSigma =
          distribution.bidSigma > 0
            ? distribution.bidSigma
            : distribution.robustSigma;
        entryBuyPrice = Math.max(
          1,
          Math.round(bidFair * Math.exp(-solvedDepth * bidSigma)),
        );
      }
    }
    entryFillHours = expectedFillHours(
      entryDepth,
      sellerFlowPerHour,
      quantity,
      entryFillCapture,
    );
  }

  const distributionOffers = calculateDistributionOffers(
    distribution,
    settings,
    entryBuyPrice,
  );
  const offers = distributionOffers || liveOffers;
  const modelSource = distributionOffers ? "distribution" : "live-fallback";

  if (!offers || (settings.requireDistribution === true && !distributionOffers)) {
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
  const distanceAboveEntry = Math.max(0, currentMid / offers.buyOffer - 1);
  const entryReadiness = clamp(
    1 - distanceAboveEntry / Math.max(distribution.sigmaPercent || 0.02, 0.02),
    0.05,
    1,
  );
  const fillEstimate = clamp(
    0.15 + 0.35 * freshness + 0.25 * liquidity + 0.25 * activityQuality,
    0.1,
    0.95,
  ) * entryReadiness;

  const driftAware = settings.driftAware !== false;
  const trendAgreement = Number.isFinite(distribution.trendAgreement)
    ? distribution.trendAgreement
    : 1;
  const driftLog =
    driftAware && distribution.trendStrength > 0
      ? (Number(distribution.driftPerHour) || 0) * trendAgreement
      : 0;
  const fairExit =
    distribution.available && distribution.fairValue
      ? distribution.fairValue
      : currentMid;
  let exitFillHours = 0;
  let projectedFairExit = fairExit;
  if (distributionOffers) {
    const rawExitHours = expectedFillHours(
      distributionOffers.effectiveExitSigma,
      buyerFlowPerHour,
      quantity,
      entryFillCapture,
    );
    exitFillHours = Number.isFinite(rawExitHours) ? Math.min(rawExitHours, 168) : 168;
    const horizonHours = clamp(
      (Number.isFinite(entryFillHours) ? entryFillHours : 168) + exitFillHours,
      0,
      168,
    );
    projectedFairExit = fairExit * Math.exp(driftLog * horizonHours);
  }
  const exitDistanceSigma = distributionOffers
    ? Math.max(
        0,
        Math.log(offers.sellOffer / Math.max(projectedFairExit, 1)) /
          Math.max(
            distribution.askSigma > 0
              ? distribution.askSigma
              : distribution.robustSigma,
            1e-9,
          ),
      )
    : null;
  const exitFillProbability = distributionOffers
    ? survivalProbability(
        exitDistanceSigma !== null
          ? exitDistanceSigma
          : distributionOffers.effectiveExitSigma,
      )
    : clamp(0.2 + 0.5 * liquidity, 0.05, 0.9);
  const fallbackExitPrice = Math.max(
    1,
    Math.round(Math.min(projectedFairExit, currentMid)),
  );
  const fallbackNet =
    fallbackExitPrice - offers.buyOffer - calculateTax(fallbackExitPrice);
  const evPerUnit =
    exitFillProbability * offers.profit + (1 - exitFillProbability) * fallbackNet;

  if (evPerUnit <= 0) {
    return null;
  }

  // Occupancy-discounted weekly throughput: a slot is tied up for the time it
  // takes to fill the entry, fill the exit, then be reviewed, so weekly cycles
  // follow the physical hold time instead of a flat cycle constant. Without a
  // distribution model there are no physical fill times, so fall back to the
  // configured cycle length.
  const cycleOccupancyHours = distributionOffers
    ? Math.max(
        (Number.isFinite(entryFillHours) ? entryFillHours : maxEntryFillHours) +
          (Number.isFinite(exitFillHours) ? exitFillHours : 168) +
          reviewHours,
        0.5,
      )
    : settings.cycleHours;
  const cyclesPerWeek = 168 / cycleOccupancyHours;
  const cycleProfit = offers.profit * quantity;
  const expectedCycleProfit = Math.floor(evPerUnit * quantity * fillEstimate);
  const cycleUnitsPerWeek = quantity * cyclesPerWeek;
  const buyLimitUnitsPerWeek = item.limit * 42;
  const weeklyUnits = Math.min(cycleUnitsPerWeek, buyLimitUnitsPerWeek);
  const weeklyModel = Math.floor(offers.profit * weeklyUnits);
  const expectedWeeklyProfit = Math.floor(evPerUnit * weeklyUnits * fillEstimate);
  const capitalRequired = offers.buyOffer * quantity;
  const estimatedPositionLoss = Math.floor(
    capitalRequired * risk.estimatedDownside,
  );
  const downsideReviewPrice = Math.max(
    1,
    Math.floor(offers.buyOffer * (1 - risk.estimatedDownside)),
  );
  const reviewPrice = distribution.available
    ? Math.max(downsideReviewPrice, distribution.p10)
    : downsideReviewPrice;
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
    expectedCycleProfit,
    weeklyModel,
    expectedWeeklyProfit,
    weeklyUnits: Math.floor(weeklyUnits),
    fillEstimate,
    exitFillProbability,
    evPerUnit,
    fallbackExitPrice,
    projectedFairExit: Math.round(projectedFairExit),
    entryDepth,
    entryFillHours: Number.isFinite(entryFillHours) ? entryFillHours : null,
    exitFillHours: Number.isFinite(exitFillHours) ? exitFillHours : null,
    driftPerHour: distribution.driftPerHour || 0,
    trendStrength: distribution.trendStrength || 0,
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
    distribution,
    modelSource,
    effectiveExitSigma:
      distributionOffers?.effectiveExitSigma || distribution.exitSigma || null,
    taxAdjustedExit: distributionOffers?.taxAdjustedExit || false,
    currentMid,
    entryReadiness,
    entryReady: currentMid <= offers.buyOffer * 1.01,
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
    requireDistribution: rawSettings.requireDistribution !== false,
    distributionWindowHours: clamp(
      finiteOr(rawSettings.distributionWindowHours, 72),
      6,
      336,
    ),
    distributionHalfLifeHours: clamp(
      finiteOr(rawSettings.distributionHalfLifeHours, 24),
      2,
      336,
    ),
    entrySigma: clamp(finiteOr(rawSettings.entrySigma, 0.75), 0, 3),
    exitSigma: clamp(finiteOr(rawSettings.exitSigma, 0.75), 0, 3),
    adaptiveHorizon: rawSettings.adaptiveHorizon !== false,
    adaptiveEntry: rawSettings.adaptiveEntry !== false,
    driftAware: rawSettings.driftAware !== false,
    maxEntryFillHours: clamp(finiteOr(rawSettings.maxEntryFillHours, 6), 0.5, 72),
    entryFillCapture: clamp(finiteOr(rawSettings.entryFillCapture, 0.5), 0.01, 1),
    reviewHours: clamp(finiteOr(rawSettings.reviewHours, 1), 0, 72),
    maxExitSigma: clamp(finiteOr(rawSettings.maxExitSigma, 3), 0.25, 6),
    minimumDistributionSamples: clamp(
      Math.floor(finiteOr(rawSettings.minimumDistributionSamples, 24)),
      8,
      500,
    ),
    maxRiskScore: clamp(finiteOr(rawSettings.maxRiskScore, 65), 0, 100),
    maxLossPercent: clamp(finiteOr(rawSettings.maxLossPercent, 0.005), 0.0001, 0.1),
    maxPositionPercent: clamp(
      finiteOr(rawSettings.maxPositionPercent, 0.125),
      0.005,
      1,
    ),
  };

  const eligibleRecords = records.filter((record) => !isExcludedItem(record.item));
  const opportunities = eligibleRecords
    .map((record) => buildOpportunity(record, settings))
    .filter(Boolean);
  const planSettings = {
    ...settings,
    maxAgeMinutes: Math.max(settings.maxAgeMinutes, 240),
    minHourlyVolume: Math.min(settings.minHourlyVolume, 10),
    maxSpreadRatio: Math.max(settings.maxSpreadRatio, 1),
    requireDistribution: true,
  };
  const plan = eligibleRecords
    .map((record) => buildOpportunity(record, planSettings))
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.balancedScore - left.balancedScore ||
        left.effectiveExitSigma - right.effectiveExitSigma,
    )
    .slice(0, 100);

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
    plan,
  };
}
