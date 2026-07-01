export const ML_FEATURE_NAMES = [
  "logEntryPrice",
  "logHourlyVolume",
  "spreadRatio",
  "sigmaPercent",
  "zScore",
  "driftPerHour",
  "trendStrength",
  "distributionConfidence",
  "targetRoi",
  "entryGapPercent",
  "hourSin",
  "hourCos",
  "weekSin",
  "weekCos",
];

export const ML_TARGETS = [
  { key: "entryWithin6h", label: "Entry within 6h" },
  { key: "exitWithin24h", label: "Exit within 24h after entry" },
  { key: "downsideBeforeExit", label: "Downside before exit" },
];

const EMBARGO_MILLISECONDS = 30 * 60 * 60 * 1000;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function buildMlFeatureVector(opportunity, timestamp = Date.now()) {
  const distribution = opportunity?.distribution || {};
  const buyOffer = Math.max(1, finite(opportunity?.buyOffer, 1));
  const sellOffer = Math.max(buyOffer + 1, finite(opportunity?.sellOffer, buyOffer + 1));
  const currentMid = Math.max(1, finite(opportunity?.currentMid, buyOffer));
  const date = new Date(timestamp);
  const hourAngle = (2 * Math.PI * date.getUTCHours()) / 24;
  const weekHour = date.getUTCDay() * 24 + date.getUTCHours();
  const weekAngle = (2 * Math.PI * weekHour) / (7 * 24);

  return [
    Math.log1p(buyOffer),
    Math.log1p(Math.max(0, finite(opportunity?.hourlyRoundTrips))),
    clamp(finite(opportunity?.spreadRatio), 0, 2),
    clamp(finite(distribution.sigmaPercent), 0, 2),
    clamp(finite(distribution.zScore), -10, 10),
    clamp(finite(distribution.driftPerHour), -1, 1),
    clamp(finite(distribution.trendStrength), 0, 10),
    clamp(finite(distribution.confidence), 0, 1),
    clamp((sellOffer - buyOffer) / buyOffer, 0, 5),
    clamp((currentMid - buyOffer) / buyOffer, -1, 5),
    Math.sin(hourAngle),
    Math.cos(hourAngle),
    Math.sin(weekAngle),
    Math.cos(weekAngle),
  ];
}

function featureStats(examples) {
  const means = Array(ML_FEATURE_NAMES.length).fill(0);
  for (const example of examples) {
    for (let index = 0; index < means.length; index += 1) {
      means[index] += example.features[index];
    }
  }
  for (let index = 0; index < means.length; index += 1) {
    means[index] /= examples.length;
  }

  const scales = Array(ML_FEATURE_NAMES.length).fill(0);
  for (const example of examples) {
    for (let index = 0; index < scales.length; index += 1) {
      const difference = example.features[index] - means[index];
      scales[index] += difference * difference;
    }
  }
  for (let index = 0; index < scales.length; index += 1) {
    scales[index] = Math.max(Math.sqrt(scales[index] / examples.length), 1e-6);
  }
  return { means, scales };
}

function fittingSubset(examples, maximum = 12_000) {
  if (examples.length <= maximum) {
    return examples;
  }
  const step = examples.length / maximum;
  return Array.from(
    { length: maximum },
    (_, index) => examples[Math.floor(index * step)],
  );
}

function fitLogistic(examples, epochs = 180) {
  const { means, scales } = featureStats(examples);
  const fittingExamples = fittingSubset(examples);
  const weights = Array(ML_FEATURE_NAMES.length).fill(0);
  const prevalence = clamp(
    examples.reduce((sum, example) => sum + example.label, 0) / examples.length,
    0.001,
    0.999,
  );
  let bias = Math.log(prevalence / (1 - prevalence));
  const regularization = 0.002;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const example of fittingExamples) {
      let score = bias;
      for (let index = 0; index < weights.length; index += 1) {
        score +=
          weights[index] *
          ((example.features[index] - means[index]) / scales[index]);
      }
      const error = sigmoid(score) - example.label;
      biasGradient += error;
      for (let index = 0; index < weights.length; index += 1) {
        gradients[index] +=
          error * ((example.features[index] - means[index]) / scales[index]);
      }
    }

    const learningRate = 0.08 / Math.sqrt(1 + epoch / 40);
    bias -= learningRate * (biasGradient / fittingExamples.length);
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -=
        learningRate *
        (gradients[index] / fittingExamples.length + regularization * weights[index]);
    }
  }

  return { bias, weights, means, scales, prevalence };
}

function modelProbability(model, features) {
  let score = model.bias;
  for (let index = 0; index < model.weights.length; index += 1) {
    score +=
      model.weights[index] *
      ((features[index] - model.means[index]) / model.scales[index]);
  }
  return sigmoid(score);
}

function validationMetrics(model, validation, baselineProbability) {
  if (!validation.length) {
    return null;
  }
  let brier = 0;
  let logLoss = 0;
  let baselineBrier = 0;
  for (const example of validation) {
    const probability = clamp(modelProbability(model, example.features), 1e-6, 1 - 1e-6);
    const baseline = clamp(baselineProbability, 1e-6, 1 - 1e-6);
    brier += (probability - example.label) ** 2;
    baselineBrier += (baseline - example.label) ** 2;
    logLoss -=
      example.label * Math.log(probability) +
      (1 - example.label) * Math.log(1 - probability);
  }
  return {
    rows: validation.length,
    brier: brier / validation.length,
    baselineBrier: baselineBrier / validation.length,
    logLoss: logLoss / validation.length,
  };
}

function targetExamples(rows, targetKey) {
  return rows
    .filter(
      (row) =>
        Array.isArray(row.features) &&
        row.features.length === ML_FEATURE_NAMES.length &&
        row.features.every(Number.isFinite) &&
        [0, 1].includes(row.labels?.[targetKey]),
    )
    .map((row) => ({
      decisionAt: new Date(row.decisionAt).getTime(),
      features: row.features,
      label: row.labels[targetKey],
    }))
    .filter((row) => Number.isFinite(row.decisionAt))
    .sort((left, right) => left.decisionAt - right.decisionAt);
}

function trainTarget(rows, targetKey, minimumRows) {
  const examples = targetExamples(rows, targetKey);
  const positives = examples.reduce((sum, example) => sum + example.label, 0);
  const negatives = examples.length - positives;
  if (examples.length < minimumRows || positives < 15 || negatives < 15) {
    return {
      available: false,
      rows: examples.length,
      positives,
      negatives,
      minimumRows,
    };
  }

  const splitIndex = Math.floor(examples.length * 0.8);
  const splitTime = examples[splitIndex].decisionAt;
  const training = examples.filter(
    (example) => example.decisionAt < splitTime - EMBARGO_MILLISECONDS,
  );
  const validation = examples.filter(
    (example) => example.decisionAt >= splitTime,
  );
  const trainPositives = training.reduce((sum, example) => sum + example.label, 0);
  if (
    training.length < Math.floor(minimumRows * 0.6) ||
    trainPositives < 10 ||
    training.length - trainPositives < 10 ||
    validation.length < 20
  ) {
    return {
      available: false,
      rows: examples.length,
      positives,
      negatives,
      minimumRows,
      reason: "Not enough chronologically separated training and validation rows",
    };
  }

  const validationModel = fitLogistic(training);
  const metrics = validationMetrics(
    validationModel,
    validation,
    validationModel.prevalence,
  );
  const finalModel = fitLogistic(examples);
  return {
    available: true,
    rows: examples.length,
    positives,
    negatives,
    trusted:
      metrics.rows >= 20 && metrics.brier <= metrics.baselineBrier,
    validation: metrics,
    ...finalModel,
  };
}

export function trainShadowModel(rows, options = {}) {
  const minimumRows = Math.max(100, Number(options.minimumRows) || 200);
  const targets = Object.fromEntries(
    ML_TARGETS.map(({ key }) => [key, trainTarget(rows, key, minimumRows)]),
  );
  return {
    version: 1,
    mode: "shadow",
    trainedAt: new Date().toISOString(),
    featureNames: ML_FEATURE_NAMES,
    minimumRows,
    targets,
  };
}

export function predictShadowModel(model, features) {
  if (
    !model ||
    !Array.isArray(features) ||
    features.length !== ML_FEATURE_NAMES.length
  ) {
    return null;
  }

  const predictions = {};
  let available = false;
  for (const { key } of ML_TARGETS) {
    const target = model.targets?.[key];
    if (!target?.available) {
      predictions[key] = null;
      continue;
    }
    predictions[key] = modelProbability(target, features);
    available = true;
  }
  return available
    ? {
        mode: "shadow",
        modelVersion: model.version,
        trainedAt: model.trainedAt,
        predictions,
        trusted: Object.fromEntries(
          ML_TARGETS.map(({ key }) => [key, Boolean(model.targets?.[key]?.trusted)]),
        ),
      }
    : null;
}
