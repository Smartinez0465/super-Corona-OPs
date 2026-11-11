# Super Korona Ops

A single-page dashboard for the bar: sales reports, a forecast, busy-hour and drink trends, event and DJ scheduling with profit and loss, and inventory.

Open `index.html` in a browser to see it. No build step.

## Sections

- **Overview**: last 7 days, expected next 7 days, estimated net, items to reorder.
- **Reports**: weekly ledger, sales by day, top items, event nights, reorder list. CSV download.
- **Forecast**: next 14 days from the same weekday over the last 8 weeks, scaled by the 4-week trend and any scheduled events.
- **Trends**: day-by-hour heat map and rising or falling drinks.
- **Events**: calendar plus a list with DJ fee, other costs, gross, net, and whether the night paid for itself.
- **Inventory**: on hand, par level, days left, and what is on order.

## Current state

- Sales are **sample data**, generated in `sampleSales()`. Nothing here talks to Clover yet.
- The page was built to run inside a claude.ai artifact, which provides saved storage for events, inventory and cost settings. Opened as a plain file, those sections start empty and cannot be saved.

## Connecting Clover

A browser page cannot call Clover directly, and an API token must never be placed in front-end code. The plan:

1. Create a read-only API token in the Clover dashboard (Orders, Payments, Inventory).
2. Put the token and Merchant ID in a `.env` file on a small server (for example a Netlify function). `.env` is already in `.gitignore`.
3. The server reads orders with line items from Clover's v3 API and returns one record per day:
   `{ date, gross, tx, hourly: [24 numbers], items: { "Item name": units } }`
4. Replace `sampleSales()` in `index.html` with a fetch to that server.

Do not commit tokens or merchant IDs to this repository.
