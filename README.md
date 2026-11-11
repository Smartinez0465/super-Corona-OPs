# Super Korona Ops

Sales reports, a 14-day forecast, busy-hour and drink trends, event and DJ scheduling with profit and loss, and inventory, for the bar. It reads your sales from Clover through a small server, and installs on a phone like an app.

There is nothing to install: the server uses only what comes with Node.js 20 or newer.

## Run it on your computer

1. In Clover, create a read-only API token (Orders, Payments, Inventory). Find your Merchant ID in the dashboard URL.
2. Copy `.env.example` to `.env` and fill in the three values. `APP_PASSWORD` is a password you choose for the dashboard.
3. Run `npm run dev` (or `node --env-file=.env server.js`) and open http://localhost:3000.

`.env` is in `.gitignore`. Never commit it, and never paste the token into the page or into chat.

## Put it online with Render

1. Create a Render account and choose New, then Web Service, and connect this GitHub repo.
2. Runtime: Node. Start command: `npm start`. Instance type: Free is enough to start.
3. In the service's Environment settings, add `CLOVER_API_TOKEN`, `CLOVER_MERCHANT_ID`, `APP_PASSWORD` and, if needed, `TIMEZONE`.
4. Deploy. Render gives you a link. Open it, sign in with `APP_PASSWORD`, and wait for the first Clover load (about a minute).

Pushing to `main` redeploys. On the free plan the service sleeps after 15 minutes without visitors, so the first open after a break is slow and the Clover load restarts.

## Install on your phone

- **iPhone:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome, then use the menu and choose Install app or Add to Home screen.

## Languages

The app is in English and Spanish. The English / Español switch is at the top of the left menu (and at the top of the page on a phone), and on the sign-in screen. The choice is remembered on each device, and a phone set to Spanish opens in Spanish the first time. To change or add wording, edit the `ES` list in `public/index.html`: each line pairs the English text with its Spanish version.

## How the numbers work

- Sales come from Clover orders. Orders that are open, refunded or credited are left out. A "business day" runs from 6am to 6am in `TIMEZONE`, so sales after midnight count toward the night before.
- Check yesterday's total here against Clover's own sales report the first time. If gross is off (for example, tax or tips handled differently), tell whoever maintains this so `server.js` can be adjusted.
- Cost of goods, labor and fixed costs are percentages you set on the Reports tab. They are estimates until they match your books.
- Events, costs and inventory are saved in the browser on the device you use. They do not sync between phone and computer yet.

## Files

- `server.js`: login, Clover sales feed, serves the page.
- `public/index.html`: the dashboard.
- `public/manifest.webmanifest`, `public/sw.js`, icons: phone install.
