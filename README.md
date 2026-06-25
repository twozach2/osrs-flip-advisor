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

The default model uses a 72-hour window, a 24-hour recency half-life, and entry
and exit targets 0.75 robust sigma below and above weighted fair value. Robust
sigma is estimated from MAD and IQR in log-price space, making it much less
sensitive to one-off spikes than ordinary mean and standard deviation.

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
