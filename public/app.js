const state = {
  data: null,
  activeStrategy: "balanced",
  watchlist: new Set(JSON.parse(localStorage.getItem("osrs-flip-watchlist") || "[]")),
  journal: JSON.parse(localStorage.getItem("osrs-flip-journal") || "[]"),
  tracking: null,
  timer: null,
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
  recentFills: document.querySelector("#recentFills"),
  refreshTrackingButton: document.querySelector("#refreshTrackingButton"),
  journal: document.querySelector("#journal"),
  clearJournalButton: document.querySelector("#clearJournalButton"),
};

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
    edgePercent: Number(formData.get("edgePercent")) / 100,
    maxSpreadRatio: Number(formData.get("maxSpreadRatio")) / 100,
    participationRate: 0.02,
    adaptiveOffers: formData.get("adaptiveOffers") === "on",
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
            <span>Limit ${formatCoins(opportunity.limit)} - ${formatCoins(opportunity.capitalRequired, true)} allocated${historyLabel}</span>
          </div>
        </div>
      </td>
      <td class="price buy-price">
        ${formatCoins(opportunity.buyOffer)}
        <button class="copy-button" data-action="copy-buy" data-id="${opportunity.id}" type="button">Copy</button>
      </td>
      <td class="price sell-price">
        ${formatCoins(opportunity.sellOffer)}
        <button class="copy-button" data-action="copy-sell" data-id="${opportunity.id}" type="button">Copy</button>
      </td>
      <td>${formatCoins(opportunity.quantity)}</td>
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
      <td title="Raw model: ${formatCoins(opportunity.weeklyModel, true)}; estimated fill ${(opportunity.fillEstimate * 100).toFixed(0)}%">${formatCoins(opportunity.expectedWeeklyProfit, true)}</td>
      <td>
        <span class="confidence ${confidenceClass(opportunity.confidence)}">
          ${opportunity.confidence}%
        </span>
      </td>
      <td>
        <button class="queue-button" data-action="queue" data-id="${opportunity.id}" type="button">
          Queue
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

  const portfolio = state.data.balanced.slice(0, state.data.settings.slots);
  const weeklyProfit = portfolio.reduce(
    (total, item) => total + item.expectedWeeklyProfit,
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

function saveJournal() {
  localStorage.setItem("osrs-flip-journal", JSON.stringify(state.journal));
}

function renderJournal() {
  if (!state.journal.length) {
    elements.journal.innerHTML = `<p class="empty-state">No queued trades yet.</p>`;
    return;
  }

  elements.journal.innerHTML = state.journal
    .map((entry) => {
      const current = findOpportunity(entry.id);
      let guidance = "Waiting for current market match";

      if (current && ["Queued", "Buying"].includes(entry.status)) {
        const difference = current.buyOffer - entry.buyOffer;
        guidance =
          difference > 0
            ? `Consider raising buy by ${formatCoins(difference)}`
            : difference < 0
              ? `Current buy is ${formatCoins(Math.abs(difference))} lower`
              : "Buy offer still matches";
      } else if (current && ["Bought", "Selling"].includes(entry.status)) {
        const difference = current.sellOffer - entry.sellOffer;
        guidance =
          difference > 0
            ? `Market sell is ${formatCoins(difference)} higher`
            : difference < 0
              ? `Consider lowering sell by ${formatCoins(Math.abs(difference))}`
              : "Sell offer still matches";
      }

      return `
        <article class="journal-entry">
          <div>
            <strong>${escapeHtml(entry.name)}</strong>
            <span>Buy ${formatCoins(entry.buyOffer)} - Sell ${formatCoins(entry.sellOffer)} - Qty ${formatCoins(entry.quantity)}</span>
            <em>${guidance}</em>
          </div>
          <label>
            Status
            <select data-journal-status="${entry.key}">
              ${["Queued", "Buying", "Bought", "Selling", "Complete", "Cancelled"]
                .map(
                  (status) =>
                    `<option ${entry.status === status ? "selected" : ""}>${status}</option>`,
                )
                .join("")}
            </select>
          </label>
          <button class="remove-button" data-journal-remove="${entry.key}" type="button">Remove</button>
        </article>
      `;
    })
    .join("");
}

function findOpportunity(id) {
  const combined = [
    ...(state.data?.balanced || []),
    ...(state.data?.highVolume || []),
    ...(state.data?.highMargin || []),
    ...(state.data?.lowRisk || []),
  ];
  return combined.find((item) => item.id === id);
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
  } catch (error) {
    elements.trackingStatus.textContent = error.message;
  } finally {
    elements.refreshTrackingButton.disabled = false;
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
    renderJournal();
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
    state.timer = setTimeout(loadData, 30_000);
  }
}

elements.form.addEventListener("change", loadData);
elements.form.addEventListener("submit", (event) => event.preventDefault());
elements.refreshButton.addEventListener("click", loadData);
elements.refreshTrackingButton.addEventListener("click", loadTracking);

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

  if (button.dataset.action === "copy-buy" || button.dataset.action === "copy-sell") {
    const value =
      button.dataset.action === "copy-buy"
        ? opportunity.buyOffer
        : opportunity.sellOffer;
    navigator.clipboard.writeText(String(value)).then(() => {
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = original;
      }, 900);
    });
    return;
  }

  state.journal.unshift({
    key: `${id}-${Date.now()}`,
    id,
    name: opportunity.name,
    buyOffer: opportunity.buyOffer,
    sellOffer: opportunity.sellOffer,
    quantity: opportunity.quantity,
    status: "Queued",
    createdAt: new Date().toISOString(),
  });
  saveJournal();
  renderJournal();
});

elements.journal.addEventListener("change", (event) => {
  const key = event.target.dataset.journalStatus;
  if (!key) {
    return;
  }

  const entry = state.journal.find((candidate) => candidate.key === key);
  if (entry) {
    entry.status = event.target.value;
    saveJournal();
  }
});

elements.journal.addEventListener("click", (event) => {
  const key = event.target.dataset.journalRemove;
  if (!key) {
    return;
  }

  state.journal = state.journal.filter((entry) => entry.key !== key);
  saveJournal();
  renderJournal();
});

elements.clearJournalButton.addEventListener("click", () => {
  state.journal = [];
  saveJournal();
  renderJournal();
});

renderJournal();
loadData();
loadTracking();
setInterval(loadTracking, 10_000);
