import { analyzeDistribution } from "./distribution.mjs";

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const DEFAULT_HORIZONS = [6, 12, 24, 48];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

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

export function buildHourlyBars(samples) {
  const buckets = new Map();

  for (const sample of samples || []) {
    const time = Number(sample?.[0]);
    const mid = Number(sample?.[1]);
    if (!Number.isFinite(time) || !Number.isFinite(mid) || mid <= 0) {
      continue;
    }

    const bucket = Math.floor(time / HOUR_SECONDS) * HOUR_SECONDS;
    const entries = buckets.get(bucket) || [];
    entries.push(sample);
    buckets.set(bucket, entries);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([bucket, entries]) => {
      const mids = entries.map((sample) => Number(sample[1]));
      const lows = entries.map(sampleLow).filter((value) => value > 0);
      const highs = entries.map(sampleHigh).filter((value) => value > 0);
      const representativeMid = median(mids);
      const representativeLow = median(lows);
      const representativeHigh = median(highs);
      const eventLow = Math.min(...lows);
      const eventHigh = Math.max(...highs);
      const spread =
        representativeMid > 0
          ? Math.max(0, (representativeHigh - representativeLow) / representativeMid)
          : 0;
      const volume = Math.max(
        ...entries.map((sample) => Number(sample[3]) || 0),
      );

      return {
        time: bucket + HOUR_SECONDS - 1,
        mid: representativeMid,
        low: eventLow,
        high: eventHigh,
        sample: [
          bucket + HOUR_SECONDS - 1,
          representativeMid,
          spread,
          volume,
          representativeHigh,
          representativeLow,
          1,
        ],
      };
    });
}

function regimeMetrics(bars, distribution) {
  if (bars.length < 12 || !distribution?.available) {
    return { regimeShift: false, regimeShiftSigma: 0, fairShiftPercent: 0 };
  }

  const latestTime = bars.at(-1).time;
  const recent = bars
    .filter((bar) => bar.time > latestTime - DAY_SECONDS)
    .map((bar) => bar.mid);
  const prior = bars
    .filter(
      (bar) =>
        bar.time <= latestTime - DAY_SECONDS &&
        bar.time > latestTime - 2 * DAY_SECONDS,
    )
    .map((bar) => bar.mid);
  if (recent.length < 4 || prior.length < 4) {
    return { regimeShift: false, regimeShiftSigma: 0, fairShiftPercent: 0 };
  }

  const recentFair = median(recent);
  const priorFair = median(prior);
  const logShift = Math.log(recentFair / priorFair);
  const fairShiftPercent = Math.exp(logShift) - 1;
  const regimeShiftSigma =
    Math.abs(logShift) / Math.max(Number(distribution.robustSigma) || 0, 0.0025);

  return {
    regimeShift:
      Math.abs(fairShiftPercent) >= 0.03 && regimeShiftSigma >= 2.5,
    regimeShiftSigma,
    fairShiftPercent,
  };
}

export function analyzeHistoricalCycles(samples = [], options = {}) {
  const bars = buildHourlyBars(samples);
  const trainingWindowHours = clamp(
    Number(options.trainingWindowHours) || 72,
    24,
    336,
  );
  const minimumSamples = Math.max(8, Number(options.minimumSamples) || 24);
  const horizons = [...new Set(options.horizons || DEFAULT_HORIZONS)]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const maximumHorizonHours = horizons.at(-1) || 48;
  const targetBuilder =
    options.targetBuilder ||
    ((distribution) => ({
      buyOffer: distribution.buyTarget,
      sellOffer: distribution.sellTarget,
      reviewPrice: distribution.p10,
    }));
  const taxCalculator = options.taxCalculator || (() => 0);
  const nowSeconds = Number(options.nowSeconds) || bars.at(-1)?.time || Date.now() / 1000;
  const currentDistribution = analyzeDistribution(
    bars.map((bar) => bar.sample),
    {
      nowSeconds,
      windowHours: trainingWindowHours,
      halfLifeHours: options.halfLifeHours,
      entrySigma: options.entrySigma,
      exitSigma: options.exitSigma,
      minimumSamples,
      adaptiveHorizon: options.adaptiveHorizon,
    },
  );

  let completedCycles = 0;
  let successfulCycles = 0;
  let downsideFirstCycles = 0;
  let expiredCycles = 0;
  let totalProfitPerUnit = 0;
  const exitHours = [];
  const successesByHorizon = Object.fromEntries(
    horizons.map((hours) => [String(hours), 0]),
  );

  for (let index = 0; index < bars.length; index += 1) {
    const entryBar = bars[index];
    const trainingCutoff = entryBar.time - trainingWindowHours * HOUR_SECONDS;
    const training = bars
      .slice(0, index)
      .filter((bar) => bar.time >= trainingCutoff)
      .map((bar) => bar.sample);
    const distribution = analyzeDistribution(training, {
      nowSeconds: entryBar.time,
      windowHours: trainingWindowHours,
      halfLifeHours: options.halfLifeHours,
      entrySigma: options.entrySigma,
      exitSigma: options.exitSigma,
      minimumSamples,
      adaptiveHorizon: options.adaptiveHorizon,
    });
    if (!distribution.available) {
      continue;
    }

    const targets = targetBuilder(distribution);
    const buyOffer = Number(targets?.buyOffer);
    const sellOffer = Number(targets?.sellOffer);
    const reviewPrice = Number(targets?.reviewPrice) || distribution.p10;
    if (
      !Number.isFinite(buyOffer) ||
      !Number.isFinite(sellOffer) ||
      sellOffer <= buyOffer ||
      entryBar.low > buyOffer
    ) {
      continue;
    }

    const deadline = entryBar.time + maximumHorizonHours * HOUR_SECONDS;
    if (deadline > bars.at(-1).time) {
      break;
    }

    let outcome = "expired";
    let downsideSeen = false;
    let outcomeIndex = index;
    let outcomePrice = buyOffer;
    let elapsedHours = maximumHorizonHours;

    for (let forward = index + 1; forward < bars.length; forward += 1) {
      const bar = bars[forward];
      if (bar.time > deadline) {
        break;
      }
      outcomeIndex = forward;
      outcomePrice = bar.low;
      elapsedHours = (bar.time - entryBar.time) / HOUR_SECONDS;

      // Hourly bars do not reveal event order, so a bar touching both levels
      // records downside-first even when the exit is eventually reached.
      if (!downsideSeen && bar.low <= reviewPrice) {
        downsideSeen = true;
      }
      if (bar.high >= sellOffer) {
        outcome = "success";
        outcomePrice = sellOffer;
        break;
      }
    }

    completedCycles += 1;
    if (downsideSeen) {
      downsideFirstCycles += 1;
    }
    if (outcome === "success") {
      successfulCycles += 1;
      exitHours.push(elapsedHours);
      for (const horizon of horizons) {
        if (elapsedHours <= horizon) {
          successesByHorizon[String(horizon)] += 1;
        }
      }
    } else {
      expiredCycles += 1;
    }

    totalProfitPerUnit +=
      outcomePrice - buyOffer - Number(taxCalculator(outcomePrice) || 0);
    index = Math.max(index, outcomeIndex);
  }

  const successRate =
    completedCycles > 0 ? successfulCycles / completedCycles : null;
  const downsideFirstRate =
    completedCycles > 0 ? downsideFirstCycles / completedCycles : null;
  const expiredRate = completedCycles > 0 ? expiredCycles / completedCycles : null;
  const averageProfitPerUnit =
    completedCycles > 0 ? totalProfitPerUnit / completedCycles : null;
  const observationDays =
    bars.length > 1
      ? (bars.at(-1).time - bars[0].time) / DAY_SECONDS
      : 0;
  const confidence = clamp(
    Math.min(completedCycles / 12, 1) * Math.min(observationDays / 7, 1),
    0,
    1,
  );
  const regime = regimeMetrics(bars, currentDistribution);
  let repeatabilityScore =
    completedCycles > 0
      ? clamp(
          0.55 * successRate +
            0.2 * (1 - downsideFirstRate) +
            0.15 * (1 - expiredRate) +
            0.1 * (averageProfitPerUnit > 0 ? 1 : 0) -
            (regime.regimeShift ? 0.2 : 0),
          0,
          1,
        )
      : null;
  if (repeatabilityScore !== null && downsideFirstRate > 0.75) {
    repeatabilityScore = Math.min(repeatabilityScore, 0.5);
  }
  const rankingMultiplier =
    repeatabilityScore === null
      ? 1
      : clamp(1 + confidence * (repeatabilityScore - 0.5) * 0.5, 0.75, 1.25);
  const status =
    completedCycles < 3
      ? "insufficient"
      : regime.regimeShift
        ? "shifting"
        : successRate >= 0.65 && downsideFirstRate <= 0.6
          ? "repeatable"
          : successRate >= 0.4
            ? "mixed"
            : "weak";

  return {
    available: completedCycles >= 3,
    status,
    hourlyBars: bars.length,
    observationDays,
    completedCycles,
    successfulCycles,
    downsideFirstCycles,
    expiredCycles,
    successRate,
    downsideFirstRate,
    expiredRate,
    successByHorizon: Object.fromEntries(
      horizons.map((hours) => [
        String(hours),
        completedCycles > 0
          ? successesByHorizon[String(hours)] / completedCycles
          : null,
      ]),
    ),
    medianExitHours: median(exitHours),
    averageProfitPerUnit,
    cyclesPerWeek:
      observationDays > 0 ? (completedCycles / observationDays) * 7 : 0,
    confidence,
    repeatabilityScore,
    rankingMultiplier,
    ...regime,
  };
}
