"use strict";
/*
  Super Korona Ops server. No packages to install (Node 20+).
  Reads secrets from environment variables, never from the page:
    CLOVER_API_TOKEN, CLOVER_MERCHANT_ID, APP_PASSWORD
  More Clover accounts (their sales are added together): CLOVER_API_TOKEN_2 and CLOVER_MERCHANT_ID_2, then _3, and so on.
  Optional: TIMEZONE (default America/New_York), PORT (default 3000), CLOVER_BASE_URL (default https://api.clover.com)
  Run locally:  node --env-file=.env server.js
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
/* Every Clover account whose sales count toward the bar. Account 1 uses the plain names, the rest add _2, _3 and so on. */
const ACCOUNTS = [];
for (let i = 1; i <= 9; i++) {
  const sfx = i === 1 ? "" : "_" + i, token = (process.env["CLOVER_API_TOKEN" + sfx] || "").trim(), mid = (process.env["CLOVER_MERCHANT_ID" + sfx] || "").trim();
  if (token && mid) ACCOUNTS.push({ n: i, label: "Account " + i, token, mid });
}
const CONFIGURED = ACCOUNTS.length > 0;
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
if (PASSWORD.length < 12) console.warn("Warning: APP_PASSWORD is short. Use at least 12 characters (for example four random words) so nobody can guess it.");

/* ---------- dates in the bar's time zone ---------- */
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
const bizDate = ms => dateFmt.format(new Date(ms - DAY_START_HOUR * 3600e3));
const clockHour = ms => parseInt(hourFmt.format(new Date(ms)), 10) % 24;
const addDaysKey = (k, n) => { const [y, m, d] = k.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); };

/* ---------- Clover ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cloverGet(acct, pathAndQuery) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + pathAndQuery, { headers: { Authorization: "Bearer " + acct.token, Accept: "application/json" } });
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 401 || res.status === 403) { const e = new Error("Clover rejected the token for " + acct.label + " (" + res.status + ")"); e.code = "auth"; throw e; }
    if (!res.ok) throw new Error("Clover returned " + res.status);
    return res.json();
  }
  throw new Error("Clover is rate limiting requests");
}
async function fetchList(acct, resource, fromMs, toMs, expand) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 400; page++) {
    const q = new URLSearchParams();
    q.append("filter", "createdTime>=" + fromMs);
    q.append("filter", "createdTime<=" + toMs);
    if (expand) q.append("expand", expand);
    q.append("limit", "1000");
    q.append("offset", String(offset));
    const data = await cloverGet(acct, "/v3/merchants/" + encodeURIComponent(acct.mid) + "/" + resource + "?" + q.toString());
    const els = (data && data.elements) || [];
    if (!els.length) break;
    out.push(...els);
    offset += els.length;
    await sleep(120);
  }
  return out;
}
const fetchOrders = (acct, f, t) => fetchList(acct, "orders", f, t, "lineItems");
const COUNTED = new Set(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"]);
/* Clover can leave paymentState as OPEN on orders that were paid by card (they become "locked"), so a locked order counts too.
   Refunded, voided and still-open tabs do not. */
const tally = {};
const isPaid = o => COUNTED.has(o.paymentState) || (o.paymentState === "OPEN" && o.state === "locked") || !o.paymentState;
/* Each day keeps two sets of money numbers: from orders (og/otx/oh) and from payments (pg/ptx/ph). gross/tx/hourly are filled in at the end from payments when they are available. */
function emptyDay(date) { return { date, gross: 0, tx: 0, hourly: Array(24).fill(0), items: {}, og: 0, otx: 0, oh: Array(24).fill(0), pg: 0, ptx: 0, ph: Array(24).fill(0), ptips: 0, refunds: 0 }; }
function addOrder(days, prices, o) {
  tally[(o.paymentState || "none") + " / " + (o.state || "none")] = (tally[(o.paymentState || "none") + " / " + (o.state || "none")] || 0) + 1;
  if (!isPaid(o)) return;
  const ms = +o.createdTime; if (!ms) return;
  const date = bizDate(ms), d = days[date]; if (!d) return;
  const dollars = (+o.total || 0) / 100;
  d.og += dollars; d.otx += 1; d.oh[clockHour(ms)] += dollars;
  const els = (o.lineItems && o.lineItems.elements) || [];
  for (const li of els) {
    if (!li.name) continue;
    const q = li.unitQty ? (+li.unitQty) / 1000 : 1;
    d.items[li.name] = (d.items[li.name] || 0) + q;
    const p = prices[li.name] || (prices[li.name] = { rev: 0, qty: 0 });
    p.rev += (+li.price || 0) / 100 * q; p.qty += q;
  }
}

/* Payments are what Clover's Transactions page adds up (cash and card, tips kept separate). Only completed payments count. */
const PAID_RESULTS = new Set(["SUCCESS", "AUTH_COMPLETED"]);
function addPayment(days, p) {
  if (p.result && !PAID_RESULTS.has(p.result)) return;
  const ms = +p.createdTime; if (!ms) return;
  const d = days[bizDate(ms)]; if (!d) return;
  const dollars = (+p.amount || 0) / 100;
  d.pg += dollars; d.ptx += 1; d.ph[clockHour(ms)] += dollars; d.ptips += (+p.tipAmount || 0) / 100;
}
function addRefund(days, r) {
  const ms = +r.createdTime; if (!ms) return;
  const d = days[bizDate(ms)]; if (!d) return;
  const dollars = (+r.amount || 0) / 100;
  d.pg -= dollars; d.ph[clockHour(ms)] -= dollars; d.refunds += dollars;
}
function finishDay(d, usePayments) {
  if (usePayments) { d.gross = d.pg; d.tx = d.ptx; d.hourly = d.ph.slice(); }
  else { d.gross = d.og; d.tx = d.otx; d.hourly = d.oh.slice(); }
}

/* ---------- cache: finished days are fetched once, the last two days are refreshed ---------- */
const cache = { status: CONFIGURED ? "loading" : "not_configured", byAccount: {}, accountErrors: [], message: "", days: new Map(), prices: {}, updated: 0, busy: false, source: "orders", paymentsNote: "", refundsNote: "" };
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
/* Load one Clover account into its own set of days. Uses payments when the token can read them, otherwise orders. */
async function loadAccount(acct, want, prices) {
  const days = {}; want.forEach(k => { days[k] = emptyDay(k); });
  const fromMs = startMs(want[0]) - 3600e3, toMs = startMs(addDaysKey(want[want.length - 1], 1)) + 3600e3;
  const span = CHUNK_DAYS * 86400e3;
  let payOk = true, payNote = "", refNote = "";
  for (let s = fromMs; s < toMs; s += span) {
    const upto = Math.min(toMs, s + span - 1);
    (await fetchOrders(acct, s, upto)).forEach(o => addOrder(days, prices, o));
    if (payOk) {
      try { (await fetchList(acct, "payments", s, upto)).forEach(p => addPayment(days, p)); }
      catch (e) { payOk = false; payNote = e.message; }
    }
    if (payOk) {
      try { (await fetchList(acct, "refunds", s, upto)).forEach(r => addRefund(days, r)); }
      catch (e) { refNote = e.message; }
    }
  }
  if (!payOk) want.forEach(k => { const d = days[k]; d.pg = d.ptx = d.refunds = d.ptips = 0; d.ph.fill(0); });
  want.forEach(k => finishDay(days[k], payOk));
  return { days, payOk, payNote, refNote };
}
const NUM_FIELDS = ["gross", "tx", "og", "otx", "pg", "ptx", "ptips", "refunds"], ARR_FIELDS = ["hourly", "oh", "ph"];
function addInto(t, d) {
  NUM_FIELDS.forEach(f => { t[f] += d[f]; });
  ARR_FIELDS.forEach(f => d[f].forEach((v, h) => { t[f][h] += v; }));
  for (const [n, q] of Object.entries(d.items)) t.items[n] = (t.items[n] || 0) + q;
}
async function load(fullBackfill) {
  if (!CONFIGURED || cache.busy) return;
  cache.busy = true;
  try {
    const keys = window84(), want = fullBackfill ? keys : keys.slice(-2);
    const prices = {}, errors = [], notes = [];
    let anyOk = false, allPayments = true, authFail = 0;
    for (const acct of ACCOUNTS) {
      try {
        const r = await loadAccount(acct, want, prices);
        anyOk = true;
        if (!r.payOk) { allPayments = false; notes.push(acct.label + ": " + r.payNote); }
        if (r.refNote) notes.push(acct.label + " refunds: " + r.refNote);
        const m = cache.byAccount[acct.label] || (cache.byAccount[acct.label] = new Map());
        want.forEach(k => m.set(k, r.days[k]));
        for (const k of [...m.keys()]) if (!keys.includes(k)) m.delete(k);
      } catch (e) {
        if (e.code === "auth") authFail++;
        errors.push(acct.label + ": " + e.message);
        console.error("Clover load failed for " + acct.label + ":", e.message);
      }
    }
    cache.accountErrors = errors;
    if (!anyOk) { const e = new Error(errors.join("; ")); if (authFail === ACCOUNTS.length) e.code = "auth"; throw e; }
    /* the bar's day = every account's day added together */
    want.forEach(k => {
      const tot = emptyDay(k);
      for (const acct of ACCOUNTS) { const m = cache.byAccount[acct.label]; const d = m && m.get(k); if (d) addInto(tot, d); }
      cache.days.set(k, tot);
    });
    cache.source = allPayments ? "payments" : "orders"; cache.paymentsNote = notes.join("; "); cache.refundsNote = "";
    if (fullBackfill) cache.prices = prices;
    else for (const [n, p] of Object.entries(prices)) if (!cache.prices[n]) cache.prices[n] = p;
    for (const k of [...cache.days.keys()]) if (!keys.includes(k)) cache.days.delete(k);
    cache.status = "ready"; cache.message = errors.join("; "); cache.updated = Date.now();
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
    body.updated = cache.updated; body.source = cache.source; body.accounts = ACCOUNTS.length; body.accountErrors = cache.accountErrors;
  }
  return body;
}

/* ---------- login ---------- */
const SESSION = crypto.createHmac("sha256", PASSWORD).update("korona-session:v1").digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0]));
const isAuthed = req => { const c = cookieOf(req).korona_session; return !!c && safeEq(c, SESSION); };
/* Wrong-password limits. Per address: 5 tries, then locked for 15 minutes. Across everyone: 40 wrong tries in 15 minutes
   pauses all sign-ins for 15 minutes, so changing addresses does not help someone guessing. Each wrong try also waits a second. */
const fails = new Map(), recentFails = [];
const LOCK_MS = 15 * 60e3, PER_IP = 5, GLOBAL = 40;
/* Render sits behind Cloudflare, which puts the visitor's real address in True-Client-IP / CF-Connecting-IP and overwrites
   anything a visitor sends there. X-Forwarded-For is only a fallback: Render appends to it, so its first entries can be faked;
   the entry just before the last one (Cloudflare's own address) is the visitor. */
const ipOf = req => {
  const h = req.headers, direct = String(h["true-client-ip"] || h["cf-connecting-ip"] || "").trim();
  if (direct) return direct;
  const xf = String(h["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
  return xf.length >= 2 ? xf[xf.length - 2] : xf[0] || String(req.socket.remoteAddress || "");
};
let globalLockUntil = 0;
function noteFail(ip) {
  const now = Date.now(), f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1; if (f.n >= PER_IP) { f.until = now + LOCK_MS; f.n = 0; } fails.set(ip, f);
  recentFails.push(now); while (recentFails.length && recentFails[0] < now - LOCK_MS) recentFails.shift();
  if (recentFails.length >= GLOBAL) { globalLockUntil = now + LOCK_MS; recentFails.length = 0; console.warn("Many wrong passwords: sign-in paused for 15 minutes"); }
  if (fails.size > 5000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
}
/* headers on every response: never indexed by search engines, never shown inside another site, no tracking referrers */
function baseHeaders(secure) {
  const h = { "X-Robots-Tag": "noindex, nofollow, noarchive", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  if (secure) h["Strict-Transport-Security"] = "max-age=31536000";
  return h;
}
function loginPage(msg) {
  const m = String(msg || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0C1A16"><meta name="robots" content="noindex,nofollow"><title>Super Korona Ops</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:18px/1.5 system-ui,sans-serif;background:#EBEFEC;color:#12231E;padding:16px}
@media(prefers-color-scheme:dark){body{background:#0C1A16;color:#E8F1ED}input{background:#13251F!important;color:#E8F1ED!important;border-color:#26443B!important}.lang button{background:#13251F!important;color:#E8F1ED!important;border-color:#26443B!important}.lang button[aria-pressed=true]{background:#E8F1ED!important;color:#0C1A16!important}}
form{width:100%;max-width:360px;display:flex;flex-direction:column;gap:14px}h1{margin:0;font-size:32px}label{font-size:16px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #CAD4CF;border-radius:10px;font:inherit;background:#F7F9F8}
button.go{padding:13px;border:0;border-radius:10px;background:#B35A00;color:#fff;font:inherit;font-weight:700;cursor:pointer;min-height:48px}.e{color:#B8332B;font-size:16px;min-height:22px}
.lang{display:flex;gap:8px}.lang button{flex:1;padding:10px;border:1px solid #CAD4CF;border-radius:10px;background:#F7F9F8;color:#12231E;font:inherit;font-size:16px;font-weight:600;cursor:pointer;min-height:44px}.lang button[aria-pressed=true]{background:#12231E;color:#F7F9F8}</style></head>
<body><form method="post" action="/login"><h1>Super Korona Ops</h1>
<div class="lang" role="group" aria-label="Language / Idioma"><button type="button" data-l="en" lang="en">English</button><button type="button" data-l="es" lang="es">Español</button></div>
<div><label for="p" data-t="Password">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus></div><div class="e" role="alert" data-t="${m}">${m}</div><button class="go" type="submit" data-t="Sign in">Sign in</button></form>
<script>
(function(){
  var ES={"Password":"Contrase\u00f1a","Sign in":"Entrar","That password is not right.":"Esa contrase\u00f1a no es correcta.","Too many tries. Wait 15 minutes and try again.":"Demasiados intentos. Espere 15 minutos e intente de nuevo."};
  var l="en"; try{ var s=localStorage.getItem("korona:lang"); if(s==="en"||s==="es") l=s; else l=String((navigator.languages&&navigator.languages[0])||navigator.language||"en").toLowerCase().indexOf("es")===0?"es":"en"; }catch(e){}
  function apply(x){ l=x; document.documentElement.lang=x;
    Array.prototype.forEach.call(document.querySelectorAll("[data-t]"),function(e){ var k=e.getAttribute("data-t"); if(k) e.textContent=(x==="es"&&ES[k])||k; });
    Array.prototype.forEach.call(document.querySelectorAll(".lang button"),function(b){ b.setAttribute("aria-pressed",String(b.getAttribute("data-l")===x)); });
    try{ localStorage.setItem("korona:lang",x); }catch(e){} }
  Array.prototype.forEach.call(document.querySelectorAll(".lang button"),function(b){ b.addEventListener("click",function(){ apply(b.getAttribute("data-l")); }); });
  apply(l);
})();
</script></body></html>`;
}
function readBody(req) { return new Promise(res => { let b = ""; req.on("data", c => { b += c; if (b.length > 4096) req.destroy(); }); req.on("end", () => res(b)); }); }

/* ---------- static files ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const PUBLIC_OK = new Set(["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/icon.svg"]);
function serveFile(res, file, extra) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", ...extra });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  const secure = req.headers["x-forwarded-proto"] === "https";
  for (const [k, v] of Object.entries(baseHeaders(secure))) res.setHeader(k, v);
  if (secure === false && req.headers["x-forwarded-proto"] === "http" && req.headers.host) { res.writeHead(301, { Location: "https://" + req.headers.host + req.url }); return res.end(); }
  if (p === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("User-agent: *\nDisallow: /\n"); }
  if (p === "/login" && req.method === "POST") {
    const ip = ipOf(req), f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now() || globalLockUntil > Date.now()) { res.writeHead(429, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(loginPage("Too many tries. Wait 15 minutes and try again.")); }
    const pw = new URLSearchParams(await readBody(req)).get("password") || "";
    if (safeEq(crypto.createHash("sha256").update(pw).digest("hex"), crypto.createHash("sha256").update(PASSWORD).digest("hex"))) {
      fails.delete(ip);
      res.writeHead(302, { Location: "/", "Set-Cookie": `korona_session=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` });
      return res.end();
    }
    noteFail(ip);
    await new Promise(r => setTimeout(r, 1000));
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(loginPage("That password is not right."));
  }
  if (p === "/login") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(loginPage("")); }
  if (p === "/logout") { res.writeHead(302, { Location: "/login", "Set-Cookie": `korona_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`, "Clear-Site-Data": '"cache"' }); return res.end(); }
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
    const r2 = n => Math.round(n * 100) / 100;
    const keys = window84().slice(-7);
    const fmtT = ms => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
    const out = { accounts: ACCOUNTS.map(a => ({ label: a.label, merchantId: a.mid, loaded: cache.byAccount[a.label] ? cache.byAccount[a.label].size + " days" : "not loaded" })), accountErrors: cache.accountErrors, status: cache.status, message: cache.message, timezone: TZ, source: cache.source, paymentsNote: cache.paymentsNote, refundsNote: cache.refundsNote, daysLoaded: cache.days.size, daysWithSales: [...cache.days.values()].filter(d => d.gross > 0).length, orderTally: tally,
      compareInClover: "Clover > Transactions > Payments. Use the exact window listed for a day, then compare Payments total with paymentsTotal below (tips are separate in Clover).",
      lastSevenDays: keys.map(k => { const d = cache.days.get(k) || emptyDay(k); return { day: k, window: fmtT(startMs(k)) + " to " + fmtT(startMs(addDaysKey(k, 1))), appShows: r2(d.gross), paymentsTotal: r2(d.pg + d.refunds), paymentsCount: d.ptx, refunds: r2(d.refunds), tips: r2(d.ptips), ordersTotal: r2(d.og), ordersCount: d.otx,
        byAccount: ACCOUNTS.length > 1 ? Object.fromEntries(ACCOUNTS.map(a => { const x = (cache.byAccount[a.label] && cache.byAccount[a.label].get(k)) || emptyDay(k); return [a.label, { appShows: r2(x.gross), paymentsTotal: r2(x.pg + x.refunds), refunds: r2(x.refunds), tips: r2(x.ptips) }]; })) : undefined }; }) };
    out.latestOrders = {};
    for (const a of ACCOUNTS) {
      try {
        const o = await cloverGet(a, "/v3/merchants/" + encodeURIComponent(a.mid) + "/orders?orderBy=" + encodeURIComponent("createdTime DESC") + "&limit=3");
        out.latestOrders[a.label] = ((o && o.elements) || []).map(x => ({ createdAt: x.createdTime ? new Date(+x.createdTime).toISOString() : null, paymentState: x.paymentState, state: x.state, total: x.total }));
      } catch (e) { out.latestOrders[a.label] = { error: e.message }; }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(out, null, 2));
  }
  if (p === "/" || p === "/index.html") return serveFile(res, path.join(PUBLIC_DIR, "index.html"), { "Cache-Control": "no-store" });
  res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
});

server.listen(PORT, () => {
  console.log("Super Korona Ops is running on port " + PORT + (CONFIGURED ? " with " + ACCOUNTS.length + " Clover account" + (ACCOUNTS.length > 1 ? "s" : "") : " (Clover is not configured, so the dashboard shows sample sales)"));
  if (CONFIGURED) load(true);
});
