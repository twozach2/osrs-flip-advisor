# OSRS Flip Advisor Tracker

This is the source for a read-only RuneLite companion plugin. It observes
`GrandExchangeOfferChanged`, calculates newly filled quantity and coins since
the previous event, and sends that delta to the local advisor.

It does not add menu actions, generate input, place offers, cancel offers, or
modify the game client.

## Configuration

1. Start OSRS Flip Advisor.
2. Open the advisor's Automatic Fill Tracking panel.
3. Enter its Local endpoint and Ingest token in the plugin configuration.
4. Keep the local advisor running while trading.

The source should be reviewed and accepted through the RuneLite Plugin Hub
process before relying on it in a normal RuneLite installation. The local
advisor already supports the event format, but this repository does not include
a RuneLite distribution or bypass the Plugin Hub review process.
