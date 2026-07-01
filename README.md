# OSRS Flip Advisor

A local Grand Exchange market scanner that recommends trades while leaving all
game input and execution to the player.

## Start

Run `Start OSRS Flip Advisor.ps1`, then open:

`http://127.0.0.1:4173`

The script uses `node` when it is installed. Inside Codex Desktop it can also
use the bundled Node runtime.

## What it does

- Pulls live prices, item mappings, buy limits, and 5-minute/1-hour volume from
  the OSRS Wiki Real-time Prices API.
- Seeds selected liquid items with hourly timeseries, then adds local five-minute
  observations.
- Calculates fair value, quartiles, and entry/exit bands from weighted log-price
  distributions using robust median absolute deviation rather than ordinary
  standard deviation.
- Suggests patient entry and exit targets at configurable robust-sigma distances.
- Calculates the current 2% seller tax conservatively, including the 5m cap.
- Rejects stale, thin, low-return, and implausibly wide-spread markets.
- Scores downside risk using persistent volatility, drawdown, adverse moves,
  trend, liquidity, spread, and history confidence.
- Reduces position size to respect a configurable modeled-loss budget and risk
  ceiling.
- Ranks balanced, high-volume, high-margin, high-value, and low-risk
  opportunities separately.
- Maintains a persistent eight-slot execution plan in the browser. Pinned entry,
  exit, review, quantity, and distribution values remain visible even when the
  item later drops out of the opportunity board.
- Sizes each suggestion against cash, reserve, GE slots, buy limits, and recent
  liquidity.
- Displays large, tabular entry, exit, and quantity values for fast read-and-type
  entry into the game client, with an optional toggle that snaps prices and
  quantities to nearby 1/2/5-series numbers (within ~1.5%). Snapping is
  margin-preserving: buys snap down, sells snap up, and quantities snap down,
  so the modeled post-tax margin can only widen, never shrink.
- Keeps a watchlist and manual trade journal in browser local storage.
- Stores compact five-minute market snapshots for 14 days in
  `data/market-history.jsonl`.
- Accepts deduplicated read-only RuneLite fill events and maintains FIFO
  inventory, realized profit, and conservative quick-exit valuations.
- Collects leakage-safe market decisions for three machine-learning shadow
  signals without allowing those predictions to change rankings.

## Important assumptions

The API contains completed trades, not the live order book. The live feed is
used for activity, freshness, and current-price context. Entry and exit targets
come from the advisor's rolling historical model. Suggested prices remain
estimates, and patient distribution targets may take substantially longer to
fill than current-spread offers.

Fresh installs start without `data/market-history.jsonl`. The dashboard can open
before the planner has enough local history to fill the eight GE slots. Leave
the server running until the top-right status says it has updated and the
History samples card is no longer near zero. If Fill empty slots still cannot
find enough distribution-qualified markets, either wait for more samples or
temporarily uncheck Historical targets only to allow live-spread fallback ideas.
The server also backfills likely candidates from the Wiki hourly series. Backfill
eligibility is based on samples inside the selected model window, not the larger
14-day file total. When slots remain empty, the dashboard reports how many
markets lacked per-item history and the leading safety or return filters that
rejected the rest.

The default model uses a 72-hour window, a 24-hour recency half-life, and entry
and exit targets 0.75 robust sigma below and above weighted fair value. Robust
sigma is estimated from MAD and IQR in log-price space, making it much less
sensitive to one-off spikes than ordinary mean and standard deviation.

The advisor also runs a walk-forward cycle analysis on qualified markets. Raw
history is compressed into hourly evaluation bars. At each historical point,
the entry, exit, and review levels are calculated using only samples that were
already available at that time. The model then measures exit success within
6/12/24/48 hours, whether downside occurred before exit, median exit time,
expired cycles, average post-tax value, and recent range shifts. Results with
only a few completed cycles receive very little ranking weight. An hourly bar
that touches both downside and exit is counted as downside-first because the
event order is unknown. These are historical target touches, not proof that a
specific queued GE offer would have filled. A pattern that crossed the downside
band before exit in more than 75% of its cycles cannot receive a ranking boost,
even when it eventually recovered.

High-value recommendations default to items with entry targets at or above
1,000,000 gp. That lane relaxes the normal one-hour round-trip and history-sample
filters and allows slower fills, but it still requires historical targets,
positive expected value, risk-budget sizing, and a viable exit probability. Fill
empty slots may blend in one or two high-value ideas only when their expected
cycle profit is meaningful, so weak expensive positions can appear for review
without crowding out the normal plan.

The tax model applies 2% to every recommendation. Some exempt items may
therefore show slightly understated profit.

Risk scores are estimates, not guarantees. "Review below" is a prompt to
reassess or exit a position, not an automatic stop order. New items detected
after the first catalog snapshot receive an additional risk penalty. Items with
limited local history are also sized more conservatively while the database
builds.

## Machine-learning shadow mode

The advisor now collects one decision per qualified item per hour and labels it
only after the relevant future window is fully observable. Missing market
observations are not treated as failed trades. Three dependency-free logistic
models estimate entry within 6 hours, exit within 24 hours after entry, and
downside before exit. Training uses chronological validation with a 30-hour
embargo, and the dashboard reports whether each signal beat its simple baseline.

ML remains strictly in shadow mode: predictions are displayed as `E`, `X`, and
`D`, but never alter ranking, prices, sizing, or risk. Current labels represent
market target touches, not guaranteed fills for a queued GE offer. The local
files `data/ml-decisions.json`, `data/ml-training.jsonl`, and
`data/ml-model.json` are excluded from Git and retain up to 180 days or 100,000
compact training rows.

To seed the model from existing history, stop the server and run:

```powershell
node scripts\bootstrap-ml.mjs
```

The server continues collecting labels and retrains automatically after enough
new examples accumulate. Gradient-boosted trees remain on the backburner until
RuneLite tracking provides a substantial labeled set of real entries, partial
fills, exits, cancellations, and realized holding times. A future model must
beat this shadow baseline on later unseen periods, remain calibrated through
regime changes, and retain the statistical fallback when confidence is low.

The Old School RuneScape client does not accept paste into the Grand Exchange
price or quantity prompts, so every recommended value has to be typed by hand.
The advisor renders these values in a large, tabular style for accurate
read-and-type entry and offers an optional type-friendly rounding toggle to
reduce keystrokes. The snap direction is margin-preserving (buys down, sells up,
quantities down) and is double-checked against the 2% sale tax before display,
so rounding cannot turn a profitable recommendation into a losing one. (Paste
into RuneLite's plugin configuration field still works normally — that is a
separate Java input, not the in-game prompt.)

## Automatic fill tracking

The read-only companion source is in `runelite-plugin/`. Start the advisor,
open the Automatic Fill Tracking panel, and copy its endpoint and token into
the plugin configuration.

For a complete, beginner-friendly, step-by-step walkthrough of installing the
tools and running the plugin in RuneLite on Windows, see
[`runelite-plugin/README.md`](runelite-plugin/README.md).

The plugin observes `GrandExchangeOfferChanged` and sends only newly filled
quantity and coin deltas to localhost. It does not click, type, create offers,
cancel offers, or alter prices. The source should go through RuneLite Plugin
Hub review before normal installation.

For courteous API identification, set a descriptive user agent before starting:

```powershell
$env:OSRS_FLIP_USER_AGENT = "osrs-flip-advisor/0.1 (contact: your-email@example.com)"
.\Start OSRS Flip Advisor.ps1
```

This application never clicks, types, reads the game client, or places trades.
