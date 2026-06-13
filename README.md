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
- Suggests a passive buy above the latest observed low and a passive sell below
  the latest observed high.
- Adapts buy and sell aggressiveness using five-minute activity and buy pressure.
- Calculates the current 2% seller tax conservatively, including the 5m cap.
- Rejects stale, thin, low-return, and implausibly wide-spread markets.
- Scores downside risk using persistent volatility, drawdown, adverse moves,
  trend, liquidity, spread, and history confidence.
- Reduces position size to respect a configurable modeled-loss budget and risk
  ceiling.
- Ranks balanced, high-volume, and high-margin opportunities separately.
- Sizes each suggestion against cash, reserve, GE slots, buy limits, and recent
  liquidity.
- Provides user-triggered copy buttons and live manual repricing guidance.
- Keeps a watchlist and manual trade journal in browser local storage.
- Stores compact five-minute market snapshots for 14 days in
  `data/market-history.jsonl`.
- Accepts deduplicated read-only RuneLite fill events and maintains FIFO
  inventory, realized profit, and conservative quick-exit valuations.

## Important assumptions

The API contains completed trades, not the live order book. Suggested prices
are therefore estimates. The expected weekly number is a comparison model, not
a profit promise. It applies a heuristic fill estimate and caps throughput at
the item's four-hour buy limit.

The tax model applies 2% to every recommendation. Some exempt items may
therefore show slightly understated profit.

Risk scores are estimates, not guarantees. "Review below" is a prompt to
reassess or exit a position, not an automatic stop order. New items detected
after the first catalog snapshot receive an additional risk penalty. Items with
limited local history are also sized more conservatively while the database
builds.

## Automatic fill tracking

The read-only companion source is in `runelite-plugin/`. Start the advisor,
open the Automatic Fill Tracking panel, and copy its endpoint and token into
the plugin configuration.

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
