"use strict";
/*
  Super Korona Ops server. No packages to install (Node 20+).
  Reads secrets from environment variables, never from the page:
    CLOVER_API_TOKEN, CLOVER_MERCHANT_ID, APP_PASSWORD
  Optional: TIMEZONE (default America/New_York), PORT (default 3000), CLOVER_BASE_URL (default https://api.clover.com)
  Run locally:  node --env-file=.env server.js
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const TOKEN = process.env.CLOVER_API_TOKEN || "";
const MID = process.env.CLOVER_MERCHANT_ID || "";
const PASSWORD = process.env.APP_PASSWORD || "";
const BASE = (process.env.CLOVER_BASE_URL || "https://api.clover.com").replace(/\/+$/, "");
const TZ = process.env.TIMEZONE || "America/New_York";
const DAYS = 84;                 // days of history the dashboard uses
const CHUNK_DAYS = 42;           // Clover limits order calls to a 90 day window, so fetch in two pieces
const DAY_START_HOUR = 6;        // sales between midnight and 6am belong to the night before
const REFRESH_MS = 5 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");

if (!PASSWORD) {
  console.error("APP_PASSWORD is not set. Set it in your .env file or your host's environment settings, then start again.");
  process.exit(1);
}

/* ---------- dates in the bar's time zone ---------- */
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
const bizDate = ms => dateFmt.format(new Date(ms - DAY_START_HOUR * 3600e3));
const clockHour = ms => parseInt(hourFmt.format(new Date(ms)), 10) % 24;
const addDaysKey = (k, n) => { const [y, m, d] = k.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); };

/* ---------- Clover ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cloverGet(pathAndQuery) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + pathAndQuery, { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/json" } });
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 401 || res.status === 403) { const e = new Error("Clover rejected the token (" + res.status + ")"); e.code = "auth"; throw e; }
    if (!res.ok) throw new Error("Clover returned " + res.status);
    return res.json();
  }
  throw new Error("Clover is rate limiting requests");
}
async function fetchOrders(fromMs, toMs) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 400; page++) {
    const q = new URLSearchParams();
    q.append("filter", "createdTime>=" + fromMs);
    q.append("filter", "createdTime<=" + toMs);
    q.append("expand", "lineItems");
    q.append("limit", "1000");
    q.append("offset", String(offset));
    const data = await cloverGet("/v3/merchants/" + encodeURIComponent(MID) + "/orders?" + q.toString());
    const els = (data && data.elements) || [];
    if (!els.length) break;
    out.push(...els);
    offset += els.length;
    await sleep(120);
  }
  return out;
}
const COUNTED = new Set(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"]);
/* Clover can leave paymentState as OPEN on orders that were paid by card (they become "locked"), so a locked order counts too.
   Refunded, voided and still-open tabs do not. */
const tally = {};
const isPaid = o => COUNTED.has(o.paymentState) || (o.paymentState === "OPEN" && o.state === "locked") || !o.paymentState;
function emptyDay(date) { return { date, gross: 0, tx: 0, hourly: Array(24).fill(0), items: {} }; }
function addOrder(days, prices, o) {
  tally[(o.paymentState || "none") + " / " + (o.state || "none")] = (tally[(o.paymentState || "none") + " / " + (o.state || "none")] || 0) + 1;
  if (!isPaid(o)) return;
  const ms = +o.createdTime; if (!ms) return;
  const date = bizDate(ms), d = days[date]; if (!d) return;
  const dollars = (+o.total || 0) / 100;
  d.gross += dollars; d.tx += 1; d.hourly[clockHour(ms)] += dollars;
  const els = (o.lineItems && o.lineItems.elements) || [];
  for (const li of els) {
    if (!li.name) continue;
    const q = li.unitQty ? (+li.unitQty) / 1000 : 1;
    d.items[li.name] = (d.items[li.name] || 0) + q;
    const p = prices[li.name] || (prices[li.name] = { rev: 0, qty: 0 });
    p.rev += (+li.price || 0) / 100 * q; p.qty += q;
  }
}

/* ---------- cache: finished days are fetched once, the last two days are refreshed ---------- */
const cache = { status: TOKEN && MID ? "loading" : "not_configured", message: "", days: new Map(), prices: {}, updated: 0, busy: false };
function window84() {
  const last = addDaysKey(bizDate(Date.now()), -1);
  return Array.from({ length: DAYS }, (_, i) => addDaysKey(last, i - (DAYS - 1)));
}
function startMs(dateKey) { // earliest instant that belongs to this business day, in the bar's zone
  const [y, m, d] = dateKey.split("-").map(Number);
  let t = Date.UTC(y, m - 1, d) - 15 * 3600e3;
  for (let i = 0; i <= 160; i++, t += 15 * 60e3) if (bizDate(t) === dateKey) return t;
  return Date.UTC(y, m - 1, d, 11);
}
async function load(fullBackfill) {
  if (!(TOKEN && MID) || cache.busy) return;
  cache.busy = true;
  try {
    const keys = window84(), want = fullBackfill ? keys : keys.slice(-2);
    const days = {}; want.forEach(k => { days[k] = emptyDay(k); });
    const prices = {};
    const fromMs = startMs(want[0]) - 3600e3, toMs = startMs(addDaysKey(want[want.length - 1], 1)) + 3600e3;
    const span = CHUNK_DAYS * 86400e3;
    for (let s = fromMs; s < toMs; s += span) {
      const orders = await fetchOrders(s, Math.min(toMs, s + span));
      orders.forEach(o => addOrder(days, prices, o));
    }
    want.forEach(k => cache.days.set(k, days[k]));
    if (fullBackfill) cache.prices = prices;
    else for (const [n, p] of Object.entries(prices)) if (!cache.prices[n]) cache.prices[n] = p;
    for (const k of [...cache.days.keys()]) if (!keys.includes(k)) cache.days.delete(k);
    cache.status = "ready"; cache.message = ""; cache.updated = Date.now();
  } catch (e) {
    cache.message = e.message;
    if (e.code === "auth") cache.status = "auth_error";
    else if (!cache.days.size) cache.status = "error";
    console.error("Clover load failed:", e.message);
  } finally { cache.busy = false; }
}
function salesPayload() {
  const body = { status: cache.status, message: cache.message, timezone: TZ };
  if (cache.status === "ready" || (cache.status === "error" && cache.days.size)) {
    body.days = window84().map(k => { const d = cache.days.get(k) || emptyDay(k); return { date: k, gross: Math.round(d.gross * 100) / 100, tx: d.tx, hourly: d.hourly.map(v => Math.round(v * 100) / 100), items: Object.fromEntries(Object.entries(d.items).map(([n, q]) => [n, Math.round(q * 100) / 100])) }; });
    body.prices = Object.fromEntries(Object.entries(cache.prices).filter(([, p]) => p.qty > 0).map(([n, p]) => [n, Math.round(p.rev / p.qty * 100) / 100]));
    body.updated = cache.updated;
  }
  return body;
}

/* ---------- login ---------- */
const SESSION = crypto.createHmac("sha256", PASSWORD).update("korona-session:v1").digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0]));
const isAuthed = req => { const c = cookieOf(req).korona_session; return !!c && safeEq(c, SESSION); };
const fails = new Map();
const ipOf = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function loginPage(msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0C1A16"><title>Super Korona Ops</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#EBEFEC;color:#12231E;padding:16px}
@media(prefers-color-scheme:dark){body{background:#0C1A16;color:#E8F1ED}input{background:#13251F!important;color:#E8F1ED!important;border-color:#26443B!important}}
form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:14px}h1{margin:0;font-size:30px}label{font-size:14px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #CAD4CF;border-radius:8px;font:inherit;background:#F7F9F8}
button{padding:11px;border:0;border-radius:8px;background:#B35A00;color:#fff;font:inherit;font-weight:700;cursor:pointer}.e{color:#B8332B;font-size:14px;min-height:20px}</style></head>
<body><form method="post" action="/login"><h1>Super Korona Ops</h1><div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus></div><div class="e" role="alert">${msg || ""}</div><button type="submit">Sign in</button></form></body></html>`;
}
function readBody(req) { return new Promise(res => { let b = ""; req.on("data", c => { b += c; if (b.length > 4096) req.destroy(); }); req.on("end", () => res(b)); }); }

/* ---------- static files ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PUBLIC_OK = new Set(["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/icon.svg"]);
function serveFile(res, file, extra) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  const secure = req.headers["x-forwarded-proto"] === "https";
  if (p === "/login" && req.method === "POST") {
    const ip = ipOf(req), f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) { res.writeHead(429, { "Content-Type": "text/html; charset=utf-8" }); return res.end(loginPage("Too many tries. Wait 10 minutes and try again.")); }
    const pw = new URLSearchParams(await readBody(req)).get("password") || "";
    if (safeEq(crypto.createHash("sha256").update(pw).digest("hex"), crypto.createHash("sha256").update(PASSWORD).digest("hex"))) {
      fails.delete(ip);
      res.writeHead(302, { Location: "/", "Set-Cookie": `korona_session=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` });
      return res.end();
    }
    f.n += 1; if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0; } fails.set(ip, f);
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }); return res.end(loginPage("That password is not right."));
  }
  if (p === "/login") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(loginPage("")); }
  if (p === "/logout") { res.writeHead(302, { Location: "/login", "Set-Cookie": "korona_session=; Path=/; Max-Age=0" }); return res.end(); }
  if (PUBLIC_OK.has(p)) return serveFile(res, path.join(PUBLIC_DIR, p), { "Cache-Control": "no-cache" });
  if (!isAuthed(req)) {
    if (p.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"status":"login"}'); }
    res.writeHead(302, { Location: "/login" }); return res.end();
  }
  if (p === "/api/sales") {
    if ((cache.status === "ready" || cache.status === "error") && Date.now() - cache.updated > REFRESH_MS) load(false);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(salesPayload()));
  }
  if (p === "/api/diagnose") { // signed-in only: shows what Clover returns, with no customer details
    const out = { status: cache.status, message: cache.message, timezone: TZ, now: Date.now(), daysLoaded: cache.days.size, daysWithSales: [...cache.days.values()].filter(d => d.gross > 0).length, orderTally: tally };
    try {
      const m = await cloverGet("/v3/merchants/" + encodeURIComponent(MID));
      out.merchantName = m && m.name;
    } catch (e) { out.merchantError = e.message; }
    try {
      const o = await cloverGet("/v3/merchants/" + encodeURIComponent(MID) + "/orders?orderBy=" + encodeURIComponent("createdTime DESC") + "&limit=5");
      out.latestOrders = ((o && o.elements) || []).map(x => ({ createdTime: x.createdTime, createdAt: x.createdTime ? new Date(+x.createdTime).toISOString() : null, paymentState: x.paymentState, state: x.state, total: x.total }));
    } catch (e) { out.ordersError = e.message; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out, null, 2));
  }
  if (p === "/" || p === "/index.html") return serveFile(res, path.join(PUBLIC_DIR, "index.html"), { "Cache-Control": "no-cache" });
  res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
});

server.listen(PORT, () => {
  console.log("Super Korona Ops is running on port " + PORT + (TOKEN && MID ? "" : " (Clover is not configured, so the dashboard shows sample sales)"));
  if (TOKEN && MID) load(true);
});
