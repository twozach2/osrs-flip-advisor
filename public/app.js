const EXCLUDED_ITEM_IDS = new Set([13190]);

const state = {
  data: null,
  activeStrategy: "balanced",
  watchlist: new Set(JSON.parse(localStorage.getItem("osrs-flip-watchlist") || "[]")),
  plan: loadPlan(),
  guidance: new Map(),
  tracking: null,
  timer: null,
  roundFriendly: localStorage.getItem("osrs-flip-round-friendly") === "1",
};

const elements = {
  form: document.querySelector("#settingsForm"),
  rows: document.querySelector("#opportunityRows"),
  refreshButton: document.querySelector("#refreshButton"),
  liveLabel: document.querySelector("#liveLabel"),
  errorBanner: document.querySelector("#errorBanner"),
  weeklyProfit: document.querySelector("#weeklyProfit"),
  targetCoverage: document.querySelector("#targetCoverage"),
  targetGap: document.querySelector("#targetGap"),
  marketCount: document.querySelector("#marketCount"),
  historySamples: document.querySelector("#historySamples"),
  historyStatus: document.querySelector("#historyStatus"),
  realizedProfit: document.querySelector("#realizedProfit"),
  trackingStatus: document.querySelector("#trackingStatus"),
  ingestEndpoint: document.querySelector("#ingestEndpoint"),
  ingestToken: document.querySelector("#ingestToken"),
  trackedPositions: document.querySelector("#trackedPositions"),
  openOrders: document.querySelector("#openOrders"),
  recentFills: document.querySelector("#recentFills"),
  refreshTrackingButton: document.querySelector("#refreshTrackingButton"),
  slotPlan: document.querySelector("#slotPlan"),
  buildPlanButton: document.querySelector("#buildPlanButton"),
  clearPlanButton: document.querySelector("#clearPlanButton"),
  roundFriendlyToggle: document.querySelector("#roundFriendlyToggle"),
};

function loadPlan() {
  try {
    const stored = JSON.parse(localStorage.getItem("osrs-flip-slot-plan") || "[]");
    const plan = Array.from({ length: 8 }, (_, index) => stored[index] || null);
    const cleaned = plan.map((slot) =>
      slot && EXCLUDED_ITEM_IDS.has(Number(slot.id)) ? null : slot,
    );
    if (cleaned.some((slot, index) => slot !== plan[index])) {
      localStorage.setItem("osrs-flip-slot-plan", JSON.stringify(cleaned));
    }
    return cleaned;
  } catch {
    return Array(8).fill(null);
  }
}

function parseCoins(value) {
  const normalized = String(value).trim().toLowerCase().replaceAll(",", "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!match) {
    return Number.NaN;
  }

  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  return Number(match[1]) * (multipliers[match[2]] || 1);
}

function formatCoins(value, compact = false) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  if (!compact) {
    return Math.round(value).toLocaleString("en-US");
  }

  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(3)}b`;
  }
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return Math.round(value).toLocaleString("en-US");
}

// Snap to a "type-friendly" 1/2/5 series step near the value, so the player
// has fewer keystrokes to enter into the OSRS client (which does not accept
// paste). Step is at most ~1.5% of the value, keeping the deviation small.
function typeFriendlySnap(value, mode = "nearest") {
  const v = Math.round(value);
  if (!Number.isFinite(v) || v <= 0) {
    return v;
  }

  const targetStep = Math.max(1, v * 0.015);
  const exponent = Math.floor(Math.log10(targetStep));
  const base = Math.pow(10, exponent);
  let step = 1;
  for (const candidate of [1, 2, 5, 10]) {
    if (candidate * base <= targetStep) {
      step = candidate * base;
    }
  }

  const rounder =
    mode === "floor" ? Math.floor : mode === "ceil" ? Math.ceil : Math.round;
  return rounder(v / step) * step;
}

// Margin-preserving direction: buys snap DOWN, sells snap UP, quantities snap
// DOWN. This way rounding can only widen the model's spread (and never deploy
// more capital than the model allocated), so a profitable trade stays at least
// as profitable after the OSRS 2% sale tax.
function snapMode(side) {
  if (side === "sell") {
    return "ceil";
  }
  return "floor";
}

function snapValue(value, side) {
  if (!Number.isFinite(value)) {
    return value;
  }
  if (!state.roundFriendly) {
    return Math.round(value);
  }
  return typeFriendlySnap(value, snapMode(side));
}

// Mirror of lib/market.mjs#calculateTax: Math.min(Math.floor(s * 0.02), 5_000_000).
const CLIENT_TAX_RATE = 0.02;
const CLIENT_TAX_CAP = 5_000_000;
function clientTax(sellPrice) {
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    return 0;
  }
  return Math.min(Math.floor(sellPrice * CLIENT_TAX_RATE), CLIENT_TAX_CAP);
}

// Snap a paired buy/sell trade and guarantee post-tax profit per unit is still
// strictly positive. The margin-preserving direction makes this an invariant
// when the model already passes; the defensive check below covers degenerate
// inputs (e.g. a one-step trade where the model itself was marginal).
function snapTradePair(buy, sell) {
  const exactBuy = Math.round(buy);
  const exactSell = Math.round(sell);
  if (!state.roundFriendly) {
    return { buy: exactBuy, sell: exactSell, fellBack: false };
  }
  const snappedBuy = snapValue(buy, "buy");
  const snappedSell = snapValue(sell, "sell");
  if (snappedSell - clientTax(snappedSell) <= snappedBuy) {
    return { buy: exactBuy, sell: exactSell, fellBack: true };
  }
  return { buy: snappedBuy, sell: snappedSell, fellBack: false };
}

// Renders a value the player needs to type. Optionally annotates with the
// exact model value when the snap moved it.
function renderTypeable(displayed, exact) {
  if (!Number.isFinite(displayed)) {
    return "--";
  }
  const primary = displayed.toLocaleString("en-US");
  if (!state.roundFriendly || !Number.isFinite(exact)) {
    return primary;
  }
  const exactRounded = Math.round(exact);
  if (exactRounded === displayed) {
    return primary;
  }
  return `${primary}<span class="type-hint">${exactRounded.toLocaleString("en-US")}</span>`;
}

// Convenience wrapper for the single-value, non-paired cases (e.g. quantities,
// or the slot card's "current exit" cell where there is no concurrent buy).
function renderTypeableSide(value, side) {
  const snapped = snapValue(value, side);
  return renderTypeable(snapped, value);
}

// Plain-text version (no markup) for use inside string titles like
// `BUY 100 at 12,400`.
function formatTypeable(value, side) {
  const snapped = snapValue(value, side);
  if (!Number.isFinite(snapped)) {
    return "--";
  }
  return snapped.toLocaleString("en-US");
}

// Visible only when snapTradePair's post-tax guarantee declined to apply and
// fell back to the exact model values. In normal use this never appears.
function snapFallbackMarker() {
  return `<span class="snap-fallback" title="Type-friendly snap declined for this trade: the rounded numbers would not stay profitable after the 2% sale tax, so the exact model values are shown instead.">↺</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getSettings() {
  const formData = new FormData(elements.form);
  const capital = parseCoins(formData.get("capital"));
  const minProfit = parseCoins(formData.get("minProfit"));

  if (!Number.isFinite(capital) || capital <= 0) {
    throw new Error("Enter a valid cash stack, such as 500m or 1.2b.");
  }
  if (!Number.isFinite(minProfit) || minProfit < 0) {
    throw new Error("Enter a valid minimum profit.");
  }

  return {
    capital,
    minProfit,
    slots: Number(formData.get("slots")),
    reservePercent: Number(formData.get("reservePercent")),
    cycleHours: Number(formData.get("cycleHours")),
    minRoi: Number(formData.get("minRoi")) / 100,
    minHourlyVolume: Number(formData.get("minHourlyVolume")),
    maxAgeMinutes: Number(formData.get("maxAgeMinutes")),
    edgePercent: 0.05,
    maxSpreadRatio: Number(formData.get("maxSpreadRatio")) / 100,
    participationRate: 0.02,
    adaptiveOffers: true,
    requireDistribution: formData.get("requireDistribution") === "on",
    distributionWindowHours: Number(formData.get("distributionWindowHours")),
    distributionHalfLifeHours: Number(formData.get("distributionHalfLifeHours")),
    minimumDistributionSamples: Number(formData.get("minimumDistributionSamples")),
    entrySigma: Number(formData.get("entrySigma")),
    exitSigma: Number(formData.get("exitSigma")),
    maxExitSigma: Number(formData.get("maxExitSigma")),
    maxRiskScore: Number(formData.get("maxRiskScore")),
    maxLossPercent: Number(formData.get("maxLossPercent")) / 100,
    maxPositionPercent: Number(formData.get("maxPositionPercent")) / 100,
  };
}

function confidenceClass(confidence) {
  if (confidence >= 75) {
    return "good";
  }
  if (confidence >= 50) {
    return "fair";
  }
  return "low";
}

function riskClass(score) {
  if (score < 30) {
    return "good";
  }
  if (score < 50) {
    return "fair";
  }
  return "low";
}

function formatHours(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (value < 1) {
    return "<1h";
  }
  return `${value.toFixed(1)}h`;
}

function bidAskSnapshot(distribution) {
  if (!distribution || !distribution.available) {
    return null;
  }
  const bidFair = Number(distribution.bidFair) || 0;
  const askFair = Number(distribution.askFair) || 0;
  if (bidFair <= 0 || askFair <= 0) {
    return null;
  }
  return {
    bidFair,
    askFair,
    bidSigma: Number(distribution.bidSigma) || 0,
    askSigma: Number(distribution.askSigma) || 0,
    realizedSpread: Number(distribution.realizedSpread) || 0,
    asymmetricSamples: Number(distribution.asymmetricSamples) || 0,
    asymmetryWeight: Number(distribution.asymmetryWeight) || 0,
  };
}

function bidAskDetail(distribution) {
  const snap = bidAskSnapshot(distribution);
  if (!snap) {
    return "";
  }
  const fairValue = Number(distribution.fairValue) || 0;
  const realizedPct =
    fairValue > 0 ? (snap.realizedSpread / fairValue) * 100 : 0;
  const asymPct = Math.round(snap.asymmetryWeight * 100);
  const tooltip =
    `bid fair ${formatCoins(snap.bidFair)} (sigma ${snap.bidSigma.toFixed(3)}), ` +
    `ask fair ${formatCoins(snap.askFair)} (sigma ${snap.askSigma.toFixed(3)}), ` +
    `realized spread ${formatCoins(snap.realizedSpread)} (${realizedPct.toFixed(2)}%), ` +
    `asymmetric data weight ${asymPct}% (${snap.asymmetricSamples} samples)`;
  return `<span class="bid-ask-detail" title="${tooltip}">B/A ${formatCoins(snap.bidFair)}/${formatCoins(snap.askFair)}</span>`;
}

function trendBadge(opportunity) {
  const strength = Number(opportunity.trendStrength) || 0;
  if (strength <= 0) {
    return "";
  }

  const drift = Number(opportunity.driftPerHour) || 0;
  const direction = drift < 0 ? "down" : "up";
  const halfLife = Number(opportunity.distribution?.effectiveHalfLifeHours) || 0;
  const label = `${drift >= 0 ? "+" : ""}${(drift * 100).toFixed(1)}%/h`;
  const title = `Trending ${direction}: ${label} drift, strength ${strength.toFixed(
    2,
  )}, effective half-life ${halfLife.toFixed(1)}h`;
  return `<span class="trend-badge ${direction}" title="${title}">${label}</span>`;
}

function rowHtml(opportunity) {
  const watched = state.watchlist.has(opportunity.id);
  const age =
    opportunity.ageMinutes < 1 ? "<1m" : `${Math.round(opportunity.ageMinutes)}m`;
  const riskReasons = opportunity.risk.reasons.length
    ? opportunity.risk.reasons.join("; ")
    : "No major downside flags";
  const historyLabel =
    opportunity.risk.historyConfidence < 0.25
      ? " - limited history"
      : opportunity.risk.catalogNew
        ? " - newly observed"
        : "";
  const bandLabel = opportunity.distribution.available
    ? `Q1 ${formatCoins(opportunity.distribution.q1)} - Q3 ${formatCoins(opportunity.distribution.q3)}`
    : "Live fallback";
  const pair = snapTradePair(opportunity.buyOffer, opportunity.sellOffer);

  return `
    <tr>
      <td>
        <div class="item-cell">
          <button
            class="watch-button ${watched ? "watched" : ""}"
            data-action="watch"
            data-id="${opportunity.id}"
            aria-label="${watched ? "Remove from" : "Add to"} watchlist"
            title="${watched ? "Remove from" : "Add to"} watchlist"
          >${watched ? "*" : "+"}</button>
          <div>
            <strong>${escapeHtml(opportunity.name)}</strong>
            <span>${bandLabel} - ${formatCoins(opportunity.capitalRequired, true)} allocated${historyLabel}</span>
            ${bidAskDetail(opportunity.distribution)}
            ${trendBadge(opportunity)}
          </div>
        </div>
      </td>
      <td class="price buy-price" title="Current model z-score: ${opportunity.distribution.zScore?.toFixed(2) || "--"}; est. fill ${formatHours(opportunity.entryFillHours)} at entry depth ${(Number(opportunity.entryDepth) || 0).toFixed(2)} sigma">
        ${renderTypeable(pair.buy, opportunity.buyOffer)}${pair.fellBack ? snapFallbackMarker() : ""}
      </td>
      <td class="price sell-price">
        ${renderTypeable(pair.sell, opportunity.sellOffer)}
      </td>
      <td class="qty-cell">${renderTypeableSide(opportunity.quantity, "qty")}</td>
      <td>${formatCoins(opportunity.profit)}</td>
      <td>${(opportunity.roi * 100).toFixed(2)}%</td>
      <td title="${opportunity.recentActivityRatio.toFixed(1)}x normal recent activity; ${(opportunity.buyPressure * 100).toFixed(0)}% buy pressure">${formatCoins(opportunity.hourlyRoundTrips, true)}</td>
      <td>${age}</td>
      <td title="${escapeHtml(riskReasons)}">
        <span class="confidence ${riskClass(opportunity.risk.score)}">
          ${opportunity.risk.score}
        </span>
      </td>
      <td title="Modeled position loss: ${formatCoins(opportunity.estimatedPositionLoss)}">${formatCoins(opportunity.reviewPrice)}</td>
      <td title="Best-case model: ${formatCoins(opportunity.weeklyModel, true)}; entry fill ${(opportunity.fillEstimate * 100).toFixed(0)}% (~${formatHours(opportunity.entryFillHours)}), exit fill ${(opportunity.exitFillProbability * 100).toFixed(0)}% (~${formatHours(opportunity.exitFillHours)}); expected value ${formatCoins(opportunity.evPerUnit, true)}/unit${opportunity.trendStrength > 0 ? `; drift-adjusted exit ${formatCoins(opportunity.projectedFairExit)}` : ""}">${formatCoins(opportunity.expectedWeeklyProfit, true)}</td>
      <td>
        <span class="confidence ${confidenceClass(opportunity.confidence)}">
          ${opportunity.confidence}%
        </span>
      </td>
      <td>
        <button class="queue-button" data-action="pin" data-id="${opportunity.id}" type="button">
          Pin
        </button>
      </td>
    </tr>
  `;
}

function visibleOpportunities() {
  if (!state.data) {
    return [];
  }

  if (state.activeStrategy === "watchlist") {
    const combined = [
      ...state.data.balanced,
      ...state.data.highVolume,
      ...state.data.highMargin,
      ...state.data.lowRisk,
    ];
    const unique = new Map(combined.map((item) => [item.id, item]));
    return [...unique.values()].filter((item) => state.watchlist.has(item.id));
  }

  return state.data[state.activeStrategy] || [];
}

function renderTable() {
  const opportunities = visibleOpportunities();
  elements.rows.innerHTML = opportunities.length
    ? opportunities.slice(0, 40).map(rowHtml).join("")
    : `<tr><td colspan="13" class="empty-state">No markets match these settings.</td></tr>`;
}

function renderSummary() {
  if (!state.data) {
    return;
  }

  const pinned = state.plan.filter(Boolean);
  const portfolio = pinned.length
    ? pinned
    : state.data.balanced.slice(0, state.data.settings.slots);
  const weeklyProfit = portfolio.reduce(
    (total, item) => total + (item.expectedWeeklyProfit || 0),
    0,
  );
  const coverage = weeklyProfit / 1_000_000_000;
  const gap = Math.max(0, 1_000_000_000 - weeklyProfit);

  elements.weeklyProfit.textContent = formatCoins(weeklyProfit, true);
  elements.targetCoverage.textContent = `${(coverage * 100).toFixed(1)}%`;
  elements.targetGap.textContent =
    gap > 0 ? `${formatCoins(gap, true)} below target` : "Model clears the target";
  elements.marketCount.textContent = formatCoins(
    new Set([...state.data.highVolume, ...state.data.highMargin].map((item) => item.id))
      .size,
  );
  elements.historySamples.textContent = formatCoins(
    state.data.historyStatus?.totalSamples || 0,
    true,
  );
  elements.historyStatus.textContent = state.data.historyStatus?.lastSnapshotAt
    ? `${state.data.historyStatus.trackedItems} items, ${state.data.historyStatus.retentionDays}-day retention`
    : "First snapshot is being collected";
}

function savePlan() {
  localStorage.setItem("osrs-flip-slot-plan", JSON.stringify(state.plan));
}

function snapshotOpportunity(opportunity) {
  return {
    id: opportunity.id,
    name: opportunity.name,
    buyOffer: opportunity.buyOffer,
    sellOffer: opportunity.sellOffer,
    quantity: opportunity.quantity,
    reviewPrice: opportunity.reviewPrice,
    expectedWeeklyProfit: opportunity.expectedWeeklyProfit,
    fairValue: opportunity.distribution.fairValue,
    q1: opportunity.distribution.q1,
    q3: opportunity.distribution.q3,
    p10: opportunity.distribution.p10,
    sigmaPercent: opportunity.distribution.sigmaPercent,
    bidAsk: bidAskSnapshot(opportunity.distribution),
    effectiveExitSigma: opportunity.effectiveExitSigma,
    taxAdjustedExit: opportunity.taxAdjustedExit,
    riskScore: opportunity.risk.score,
    modelSource: opportunity.modelSource,
    currentMid: opportunity.currentMid,
    status: "Buying",
    pinnedAt: new Date().toISOString(),
  };
}

function calculateBreakEvenSell(unitCost) {
  let low = Math.max(1, Math.floor(unitCost));
  let high = Math.ceil(unitCost / 0.98 + 5_000_001);

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const tax = Math.min(Math.floor(middle * 0.02), 5_000_000);
    if (middle - tax >= unitCost) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function planGuidance(slot) {
  const current = findOpportunity(slot.id);
  const modelGuidance = state.guidance.get(slot.id);
  const position = state.tracking?.positions.find(
    (candidate) => candidate.itemId === slot.id,
  );
  const holding = position && position.quantity > 0;
  const status = holding && ["Buying", "Planned"].includes(slot.status)
    ? "Holding"
    : slot.status;

  if (["Holding", "Selling"].includes(status)) {
    const quantity = position?.quantity || slot.quantity;
    const averageCost = position?.averageCost || slot.buyOffer;
    const breakEven = calculateBreakEvenSell(averageCost);
    const currentModelExit =
      current?.sellOffer || modelGuidance?.sellTarget || slot.sellOffer;
    const target = Math.max(slot.sellOffer, breakEven);
    const weakened = currentModelExit < breakEven;
    const currentMid =
      current?.currentMid || modelGuidance?.currentMid || slot.currentMid;
    const currentReview =
      current?.reviewPrice || modelGuidance?.reviewPrice || slot.reviewPrice;
    const belowReview =
      currentMid > 0 && currentMid < Math.max(slot.reviewPrice, currentReview);

    const sellPair = snapTradePair(averageCost, target);
    return {
      status,
      title: `SELL ${formatTypeable(quantity, "qty")} at ${sellPair.sell.toLocaleString("en-US")}`,
      detail: belowReview
        ? `Price is below the review band. Current model exit ${formatCoins(currentModelExit)}; break-even ${formatCoins(breakEven)}. Reassess rather than chasing the old margin.`
        : weakened
          ? `Current model exit is below break-even ${formatCoins(breakEven)}. Keep the frozen target visible, but consider time-to-recovery and slot cost.`
          : `Frozen target ${formatCoins(slot.sellOffer)}; current model ${formatCoins(currentModelExit)}; break-even ${formatCoins(breakEven)}.`,
      fellBack: sellPair.fellBack,
    };
  }

  if (status === "Complete") {
    return {
      status,
      title: "Slot complete",
      detail: "Remove or replace this plan when you are ready.",
      fellBack: false,
    };
  }

  const currentMid =
    current?.currentMid || modelGuidance?.currentMid || slot.currentMid;
  const distance = currentMid > 0 ? currentMid / slot.buyOffer - 1 : 0;
  const buyPair = snapTradePair(slot.buyOffer, slot.sellOffer);
  return {
    status,
    title: `BUY ${formatTypeable(slot.quantity, "qty")} at ${buyPair.buy.toLocaleString("en-US")}`,
    detail:
      distance <= 0.01
        ? `Entry is inside the planned lower band. Frozen exit target: ${formatCoins(slot.sellOffer)}.`
        : `Current midpoint is ${(distance * 100).toFixed(1)}% above entry. Leave a patient offer or wait; do not chase it upward.`,
    fellBack: buyPair.fellBack,
  };
}

function renderPlan() {
  elements.slotPlan.innerHTML = state.plan
    .map((slot, index) => {
      if (!slot) {
        return `
          <article class="slot-card empty">
            <div>
              <strong>Slot ${index + 1}</strong>
              <span>Empty</span>
            </div>
          </article>
        `;
      }

      const guidance = planGuidance(slot);
      const current = findOpportunity(slot.id);
      const modelGuidance = state.guidance.get(slot.id);
      const currentExit =
        current?.sellOffer || modelGuidance?.sellTarget || slot.sellOffer;
      const slotPair = snapTradePair(slot.buyOffer, slot.sellOffer);

      return `
        <article class="slot-card">
          <header>
            <div>
              <span class="slot-number">Slot ${index + 1}</span>
              <h3>${escapeHtml(slot.name)}</h3>
              <span>Risk ${slot.riskScore}/100 - pinned ${new Date(slot.pinnedAt).toLocaleDateString()}</span>
            </div>
            <select data-plan-status="${index}">
              ${["Planned", "Buying", "Holding", "Selling", "Complete"]
                .map(
                  (status) =>
                    `<option ${guidance.status === status ? "selected" : ""}>${status}</option>`,
                )
                .join("")}
            </select>
          </header>
          <div class="slot-command">
            <strong>${guidance.title}${guidance.fellBack || slotPair.fellBack ? snapFallbackMarker() : ""}</strong>
            <span>${guidance.detail}</span>
          </div>
          <div class="slot-prices">
            <div><span>Entry</span><strong>${renderTypeable(slotPair.buy, slot.buyOffer)}</strong></div>
            <div><span>Frozen exit</span><strong>${renderTypeable(slotPair.sell, slot.sellOffer)}</strong></div>
            <div><span>Current exit</span><strong>${renderTypeableSide(currentExit, "sell")}</strong></div>
          </div>
          <p class="slot-band">
            Fair ${formatCoins(slot.fairValue)} - Q1 ${formatCoins(slot.q1)} -
            Q3 ${formatCoins(slot.q3)} - volatility sigma ${(Number(slot.sigmaPercent || 0) * 100).toFixed(2)}% -
            exit ${Number(slot.effectiveExitSigma || 0).toFixed(2)} sigma${slot.taxAdjustedExit ? " tax-adjusted" : ""} -
            review below ${formatCoins(slot.reviewPrice)}
            ${slot.bidAsk ? `<br/><span class="slot-asymmetry" title="bid sigma ${slot.bidAsk.bidSigma.toFixed(3)}, ask sigma ${slot.bidAsk.askSigma.toFixed(3)}, asymmetric data weight ${Math.round(slot.bidAsk.asymmetryWeight * 100)}% (${slot.bidAsk.asymmetricSamples} samples)">Bid ${formatCoins(slot.bidAsk.bidFair)} / Ask ${formatCoins(slot.bidAsk.askFair)} - realized spread ${formatCoins(slot.bidAsk.realizedSpread)}</span>` : ""}
          </p>
          <div class="slot-footer">
            <span>${formatTypeable(slot.quantity, "qty")} units - ${formatCoins(slot.expectedWeeklyProfit, true)}/wk model</span>
            <div>
              ${
                current || modelGuidance?.distribution.available
                  ? `<button data-plan-refresh="${index}" type="button">Adopt current</button>`
                  : ""
              }
              <button data-plan-remove="${index}" type="button">Remove</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function pinOpportunity(opportunity) {
  const existingIndex = state.plan.findIndex((slot) => slot?.id === opportunity.id);
  const emptyIndex = state.plan.findIndex((slot) => !slot);
  const index = existingIndex >= 0 ? existingIndex : emptyIndex;

  if (index < 0) {
    throw new Error("All eight slots are pinned. Remove or complete one first.");
  }

  state.plan[index] = snapshotOpportunity(opportunity);
  savePlan();
  renderPlan();
  renderSummary();
  loadPlanGuidance();
}

function buildPlan() {
  if (!state.data) {
    return;
  }

  const desiredSlots = Math.min(8, state.data.settings.slots);
  const pinnedIds = new Set(state.plan.filter(Boolean).map((slot) => slot.id));
  const candidates = (state.data.plan || state.data.balanced).filter(
    (opportunity) =>
      opportunity.modelSource === "distribution" && !pinnedIds.has(opportunity.id),
  );

  for (let index = 0; index < desiredSlots; index += 1) {
    if (state.plan[index]) {
      continue;
    }
    const opportunity = candidates.shift();
    if (!opportunity) {
      break;
    }
    state.plan[index] = snapshotOpportunity(opportunity);
  }

  savePlan();
  renderPlan();
  renderSummary();
  loadPlanGuidance();

  const filled = state.plan.slice(0, desiredSlots).filter(Boolean).length;
  if (filled < desiredSlots) {
    elements.errorBanner.textContent =
      `Filled ${filled} of ${desiredSlots} slots. The remaining slots do not yet have enough historical data or do not pass the current return and risk rules.`;
    elements.errorBanner.hidden = false;
  } else {
    elements.errorBanner.hidden = true;
  }
}

function findOpportunity(id) {
  const combined = [
    ...(state.data?.balanced || []),
    ...(state.data?.highVolume || []),
    ...(state.data?.highMargin || []),
    ...(state.data?.lowRisk || []),
    ...(state.data?.plan || []),
  ];
  return combined.find((item) => item.id === id);
}

function openOrderVerdict(order, maxHours) {
  const ageHours = (Date.now() - new Date(order.firstSeenAt).getTime()) / 3_600_000;
  const remaining = Math.max(0, order.totalQuantity - order.quantitySold);
  const name = escapeHtml(order.name);
  const stuck = ageHours > maxHours && remaining > 0;

  if (!stuck) {
    return {
      level: "ok",
      ageHours,
      title: remaining > 0 ? "Filling on schedule" : "Fully filled",
      detail:
        remaining > 0
          ? `${formatHours(ageHours)} open of ${formatHours(maxHours)} target; ${formatCoins(remaining)} left.`
          : "Awaiting the completion event.",
    };
  }

  const opportunity = findOpportunity(order.itemId);
  if (!opportunity) {
    return {
      level: "info",
      ageHours,
      title: `Reassess ${name} manually`,
      detail: `Stuck ${formatHours(ageHours)} (> ${formatHours(maxHours)} target) but no live model for this item. Decide in-game.`,
    };
  }

  const drift = Number(opportunity.driftPerHour) || 0;
  const driftPct = (Math.exp(drift) - 1) * 100;
  const modelExit = Number(opportunity.sellOffer) || 0;
  const target = Math.round(Number(opportunity.projectedFairExit) || modelExit || order.offerPrice);

  if (order.side === "sell") {
    if (order.offerPrice > target) {
      return {
        level: "reprice",
        ageHours,
        title: `Lower ask on ${name} to ~${formatCoins(target)}`,
        detail: `Sell stuck ${formatHours(ageHours)}; your ask ${formatCoins(order.offerPrice)} is above the drift-adjusted exit ${formatCoins(target)} (${driftPct.toFixed(1)}%/h). Lower it to free capital.`,
      };
    }
    return {
      level: "hold",
      ageHours,
      title: `Hold ${name}`,
      detail: `Sell stuck ${formatHours(ageHours)}, but your ask ${formatCoins(order.offerPrice)} is at/below the model exit ${formatCoins(target)}. Holding is reasonable.`,
    };
  }

  const fastFillPrice = Math.max(Math.round(Number(opportunity.currentMid) || 0), order.offerPrice + 1);
  const exitNet = target * 0.98;
  const marginAtFastFill = Math.round(exitNet - fastFillPrice);

  if (drift < -0.002 || marginAtFastFill <= 0) {
    return {
      level: "cancel",
      ageHours,
      title: `Cancel ${name}`,
      detail: `Stuck ${formatHours(ageHours)}; ${driftPct.toFixed(1)}%/h drift. Re-pricing to ~${formatCoins(fastFillPrice)} against the drift-adjusted exit ${formatCoins(target)} leaves ${formatCoins(marginAtFastFill)}/unit. Cancel and redeploy.`,
    };
  }

  return {
    level: "reprice",
    ageHours,
    title: `Raise bid on ${name} to ~${formatCoins(fastFillPrice)}`,
    detail: `Stuck ${formatHours(ageHours)} (> ${formatHours(maxHours)} target); ${driftPct.toFixed(1)}%/h trend. Drift-adjusted exit ${formatCoins(target)} keeps ~${formatCoins(marginAtFastFill)}/unit at the faster fill. Re-price up.`,
  };
}

function renderOpenOrders(tracking) {
  if (!elements.openOrders) {
    return;
  }
  const orders = tracking.openOrders || [];
  const maxHours = Number(state.data?.settings?.maxEntryFillHours) || 6;

  if (!orders.length) {
    elements.openOrders.innerHTML = `<p class="empty-state">No open orders reported.</p>`;
    return;
  }

  elements.openOrders.innerHTML = orders
    .map((order) => {
      const verdict = openOrderVerdict(order, maxHours);
      return `
        <article class="compact-entry open-order ${verdict.level}">
          <div>
            <strong>${escapeHtml(order.name)} <span class="order-tag ${order.side}">${order.side.toUpperCase()}</span></strong>
            <span>${formatCoins(order.quantitySold)}/${formatCoins(order.totalQuantity)} at ${formatCoins(order.offerPrice)} - open ${formatHours(verdict.ageHours)}</span>
          </div>
          <div class="order-verdict ${verdict.level}">
            <strong>${verdict.title}</strong>
            <span>${verdict.detail}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTracking() {
  const tracking = state.tracking;
  if (!tracking) {
    return;
  }

  elements.ingestEndpoint.textContent = tracking.ingestEndpoint;
  elements.ingestToken.textContent = tracking.ingestToken;
  elements.realizedProfit.textContent = formatCoins(tracking.realizedProfit, true);
  elements.realizedProfit.classList.toggle("loss-text", tracking.realizedProfit < 0);
  elements.trackingStatus.textContent = tracking.lastEventAt
    ? `Last fill ${new Date(tracking.lastEventAt).toLocaleString()}`
    : "RuneLite tracker not connected";

  elements.trackedPositions.innerHTML = tracking.positions.length
    ? tracking.positions
        .slice(0, 30)
        .map(
          (position) => `
            <article class="compact-entry">
              <div>
                <strong>${escapeHtml(position.name)}</strong>
                <span>${formatCoins(position.quantity)} at ${formatCoins(position.averageCost)} average</span>
              </div>
              <div class="${position.unrealizedProfit < 0 ? "loss-text" : "gain-text"}">
                ${position.unrealizedProfit === null ? "--" : formatCoins(position.unrealizedProfit, true)}
                <span>quick-exit P/L</span>
              </div>
            </article>
          `,
        )
        .join("")
    : `<p class="empty-state">No open tracked positions.</p>`;

  elements.recentFills.innerHTML = tracking.recentFills.length
    ? tracking.recentFills
        .slice(0, 30)
        .map(
          (fill) => `
            <article class="compact-entry">
              <div>
                <strong>${escapeHtml(fill.name)}</strong>
                <span>${fill.side.toUpperCase()} ${formatCoins(fill.quantity)} at ${formatCoins(fill.unitPrice)}</span>
              </div>
              <time>${new Date(fill.timestamp).toLocaleString()}</time>
            </article>
          `,
        )
        .join("")
    : `<p class="empty-state">No automatic fills received.</p>`;

  renderOpenOrders(tracking);
}

async function loadTracking() {
  elements.refreshTrackingButton.disabled = true;
  try {
    const response = await fetch("/api/tracking", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Tracking request failed.");
    }
    state.tracking = body;
    renderTracking();
    renderPlan();
  } catch (error) {
    elements.trackingStatus.textContent = error.message;
  } finally {
    elements.refreshTrackingButton.disabled = false;
  }
}

async function loadPlanGuidance() {
  const ids = state.plan.filter(Boolean).map((slot) => slot.id);
  if (!ids.length) {
    state.guidance.clear();
    renderPlan();
    return;
  }

  try {
    const settings = getSettings();
    const query = new URLSearchParams({
      ids: ids.join(","),
      distributionWindowHours: String(settings.distributionWindowHours),
      distributionHalfLifeHours: String(settings.distributionHalfLifeHours),
      minimumDistributionSamples: String(settings.minimumDistributionSamples),
      entrySigma: String(settings.entrySigma),
      exitSigma: String(settings.exitSigma),
      maxExitSigma: String(settings.maxExitSigma),
    });
    const response = await fetch(`/api/guidance?${query}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Pinned guidance request failed.");
    }
    state.guidance = new Map(body.guidance.map((entry) => [entry.id, entry]));
    renderPlan();
  } catch (error) {
    console.warn(error.message);
  }
}

async function loadData() {
  clearTimeout(state.timer);
  elements.refreshButton.disabled = true;
  elements.liveLabel.textContent = "Refreshing...";
  elements.errorBanner.hidden = true;

  try {
    const settings = getSettings();
    const query = new URLSearchParams(
      Object.entries(settings).map(([key, value]) => [key, String(value)]),
    );
    const response = await fetch(`/api/opportunities?${query}`, { cache: "no-store" });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(body.detail || body.error || "Price request failed.");
    }

    state.data = body;
    renderTable();
    renderSummary();
    renderPlan();
    await loadPlanGuidance();
    const timestamp = new Date(body.generatedAt);
    elements.liveLabel.textContent = `Updated ${timestamp.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    })}`;
  } catch (error) {
    elements.errorBanner.textContent = error.message;
    elements.errorBanner.hidden = false;
    elements.liveLabel.textContent = "Update failed";
  } finally {
    elements.refreshButton.disabled = false;
    state.timer = setTimeout(loadData, 5 * 60_000);
  }
}

elements.form.addEventListener("change", loadData);
elements.form.addEventListener("submit", (event) => event.preventDefault());
elements.refreshButton.addEventListener("click", loadData);
elements.refreshTrackingButton.addEventListener("click", loadTracking);
elements.buildPlanButton.addEventListener("click", buildPlan);
elements.clearPlanButton.addEventListener("click", () => {
  state.plan = Array(8).fill(null);
  state.guidance.clear();
  savePlan();
  renderPlan();
  renderSummary();
});

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.querySelector(`#${button.dataset.copyTarget}`);
    navigator.clipboard.writeText(target.textContent).then(() => {
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = original;
      }, 900);
    });
  });
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.activeStrategy = tab.dataset.strategy;
    document.querySelectorAll(".tab").forEach((candidate) => {
      candidate.classList.toggle("active", candidate === tab);
    });
    renderTable();
  });
});

if (elements.roundFriendlyToggle) {
  elements.roundFriendlyToggle.checked = state.roundFriendly;
  elements.roundFriendlyToggle.addEventListener("change", () => {
    state.roundFriendly = elements.roundFriendlyToggle.checked;
    localStorage.setItem(
      "osrs-flip-round-friendly",
      state.roundFriendly ? "1" : "0",
    );
    renderTable();
    renderPlan();
  });
}

elements.rows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const id = Number(button.dataset.id);
  if (button.dataset.action === "watch") {
    if (state.watchlist.has(id)) {
      state.watchlist.delete(id);
    } else {
      state.watchlist.add(id);
    }
    localStorage.setItem("osrs-flip-watchlist", JSON.stringify([...state.watchlist]));
    renderTable();
    return;
  }

  const opportunity = findOpportunity(id);
  if (!opportunity) {
    return;
  }

  if (button.dataset.action === "pin") {
    try {
      pinOpportunity(opportunity);
    } catch (error) {
      elements.errorBanner.textContent = error.message;
      elements.errorBanner.hidden = false;
    }
    return;
  }

});

elements.slotPlan.addEventListener("change", (event) => {
  const index = Number(event.target.dataset.planStatus);
  if (!Number.isInteger(index) || !state.plan[index]) {
    return;
  }

  state.plan[index].status = event.target.value;
  savePlan();
  renderPlan();
});

elements.slotPlan.addEventListener("click", (event) => {
  const removeIndex = Number(event.target.dataset.planRemove);
  if (Number.isInteger(removeIndex) && state.plan[removeIndex]) {
    state.plan[removeIndex] = null;
    savePlan();
    renderPlan();
    renderSummary();
    loadPlanGuidance();
    return;
  }

  const refreshIndex = Number(event.target.dataset.planRefresh);
  if (Number.isInteger(refreshIndex) && state.plan[refreshIndex]) {
    const current = findOpportunity(state.plan[refreshIndex].id);
    const modelGuidance = state.guidance.get(state.plan[refreshIndex].id);
    if (current) {
      const status = state.plan[refreshIndex].status;
      const pinnedAt = state.plan[refreshIndex].pinnedAt;
      state.plan[refreshIndex] = {
        ...snapshotOpportunity(current),
        status,
        pinnedAt,
      };
      savePlan();
      renderPlan();
      renderSummary();
    } else if (modelGuidance?.distribution.available) {
      state.plan[refreshIndex] = {
        ...state.plan[refreshIndex],
        buyOffer: modelGuidance.buyTarget,
        sellOffer: modelGuidance.sellTarget,
        reviewPrice: modelGuidance.reviewPrice,
        fairValue: modelGuidance.distribution.fairValue,
        q1: modelGuidance.distribution.q1,
        q3: modelGuidance.distribution.q3,
        p10: modelGuidance.distribution.p10,
        sigmaPercent: modelGuidance.distribution.sigmaPercent,
        bidAsk: bidAskSnapshot(modelGuidance.distribution),
        currentMid: modelGuidance.currentMid,
      };
      savePlan();
      renderPlan();
      renderSummary();
    }
  }
});

renderPlan();
loadData();
loadTracking();
setInterval(loadTracking, 10_000);
