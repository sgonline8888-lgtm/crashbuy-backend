// CrashBuy Pro Backend v4
// Dual storage: Render JSON files (primary) + Google Sheets (backup/sync)
// Set env vars: SMTP_*, TWILIO_*, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");
const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
const SETTINGS_FILE  = path.join(DATA_DIR, "settings.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Google Sheets helper ──────────────────────
// Uses Google Sheets API v4 with a Service Account JSON key
// Env var GOOGLE_SERVICE_ACCOUNT_JSON = the full JSON key (stringified)
// Env var GOOGLE_SHEET_ID = the spreadsheet ID from the URL

let googleAuth = null;

async function getGoogleToken() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) return null;
  try {
    const key = JSON.parse(keyJson);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claim = Buffer.from(JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600, iat: now
    })).toString("base64url");
    // Sign with RS256 using the private key via crypto
    const { createSign } = await import("crypto");
    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${claim}`);
    const sig = sign.sign(key.private_key, "base64url");
    const jwt = `${header}.${claim}.${sig}`;
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
    });
    const d = await r.json();
    return d.access_token;
  } catch(e) { console.error("Google auth failed:", e.message); return null; }
}

async function sheetsRequest(method, path, body) {
  const token = await getGoogleToken();
  if (!token) return null;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return null;
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
      method, headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    return r.json();
  } catch(e) { console.error("Sheets error:", e.message); return null; }
}

// Write watchlist to Google Sheets (Sheet1: Watchlist tab)
async function syncWatchlistToSheets(watchlist) {
  if (!process.env.GOOGLE_SHEET_ID) return;
  const values = [
    ["Symbol", "Type", "CoinGecko ID", "Last Updated"],
    ...watchlist.map(s => [s.sym, s.type, s.cgId || "", new Date().toISOString()])
  ];
  await sheetsRequest("PUT", "/values/Watchlist!A1?valueInputOption=RAW", { values });
}

// Write portfolio to Google Sheets (Sheet2: Portfolio tab)
async function syncPortfolioToSheets(portfolio) {
  if (!process.env.GOOGLE_SHEET_ID) return;
  const values = [
    ["ID", "Symbol", "Qty", "Buy Price", "Date"],
    ...portfolio.map(p => [p.id, p.symbol, p.qty, p.buyPrice, p.date])
  ];
  await sheetsRequest("PUT", "/values/Portfolio!A1?valueInputOption=RAW", { values });
}

// Read watchlist from Google Sheets (fallback)
async function readWatchlistFromSheets() {
  const d = await sheetsRequest("GET", "/values/Watchlist!A2:C100");
  if (!d || !d.values) return null;
  return d.values.filter(r => r[0]).map(r => ({ sym: r[0], type: r[1] || "stock", cgId: r[2] || null }));
}

// Read portfolio from Google Sheets (fallback)
async function readPortfolioFromSheets() {
  const d = await sheetsRequest("GET", "/values/Portfolio!A2:E100");
  if (!d || !d.values) return null;
  return d.values.filter(r => r[0]).map(r => ({ id: Number(r[0]), symbol: r[1], qty: +r[2], buyPrice: +r[3], date: r[4] }));
}

const DEFAULT_WATCHLIST = [
  { sym: "SPY",    type: "stock",  cgId: null       },
  { sym: "QQQ",    type: "stock",  cgId: null       },
  { sym: "NVDA",   type: "stock",  cgId: null       },
  { sym: "BTC/USD",type: "crypto", cgId: "bitcoin"  },
  { sym: "ETH/USD",type: "crypto", cgId: "ethereum" },
  { sym: "SOL/USD",type: "crypto", cgId: "solana"   },
];

const app = express();
app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok", uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    service: "CrashBuy Pro v4",
    googleSheets: !!process.env.GOOGLE_SHEET_ID,
  });
});
app.get("/", (req, res) => res.send("CrashBuy Pro backend v4 (dual storage) is running."));

// ── Stock price proxy ─────────────────────────
app.get("/api/price/:symbol", async (req, res) => {
  const { symbol } = req.params;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return res.status(404).json({ error: "Symbol not found" });
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
    const changePct = prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0;
    res.json({ symbol, price, prevClose, changePct, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch price", detail: String(err) });
  }
});

// ── Historical price data (for charts) ────────
// GET /api/history/:symbol?range=1D|1W|1M|3M|6M|YTD|1Y
// Returns { symbol, range, prices: [[timestampMs, closePrice], ...] }
const RANGE_MAP = {
  "1D":  { range: "1d",  interval: "5m"  },
  "1W":  { range: "5d",  interval: "15m" }, // Yahoo has no literal "7d"; 5 trading days is closest
  "1M":  { range: "1mo", interval: "1d"  },
  "3M":  { range: "3mo", interval: "1d"  },
  "6M":  { range: "6mo", interval: "1d"  },
  "YTD": { range: "ytd", interval: "1d"  },
  "1Y":  { range: "1y",  interval: "1d"  },
};

const historyCache = new Map(); // "symbol:range" -> { data, expiresAt }

app.get("/api/history/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const range = (req.query.range || "1M").toUpperCase();
  const cfg = RANGE_MAP[range];
  if (!cfg) return res.status(400).json({ error: `Unsupported range "${range}"` });

  const cacheKey = `${symbol}:${range}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ symbol, range, prices: cached.data, cached: true });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${cfg.range}&interval=${cfg.interval}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: "Symbol not found" });

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) prices.push([timestamps[i] * 1000, closes[i]]);
    }
    if (!prices.length) return res.status(404).json({ error: "No historical data" });

    // Intraday ranges refresh fast; daily-bar ranges can cache longer.
    const ttlMs = range === "1D" ? 60 * 1000 : range === "1W" ? 5 * 60 * 1000 : 60 * 60 * 1000;
    historyCache.set(cacheKey, { data: prices, expiresAt: Date.now() + ttlMs });

    res.json({ symbol, range, prices });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history", detail: String(err) });
  }
});

// ── Watchlist — dual storage ──────────────────
app.get("/api/watchlist", async (req, res) => {
  // Primary: local JSON file
  let list = readJSON(WATCHLIST_FILE, null);
  let source = "local";
  // Fallback: Google Sheets
  if (!list) {
    list = await readWatchlistFromSheets();
    source = "google_sheets";
    if (list) writeJSON(WATCHLIST_FILE, list); // cache it locally
  }
  if (!list) { list = DEFAULT_WATCHLIST; source = "defaults"; }
  res.json({ watchlist: list, source });
});

app.post("/api/watchlist", async (req, res) => {
  const { sym, type, cgId } = req.body;
  if (!sym || !type) return res.status(400).json({ error: "Missing sym or type" });
  const list = readJSON(WATCHLIST_FILE, DEFAULT_WATCHLIST);
  if (list.find(s => s.sym === sym)) return res.status(400).json({ error: "Already exists" });
  list.push({ sym, type, cgId: cgId || null });
  writeJSON(WATCHLIST_FILE, list);
  // Sync to Google Sheets in background
  syncWatchlistToSheets(list).catch(e => console.error("Sheets sync failed:", e.message));
  res.json({ added: true, watchlist: list });
});

app.delete("/api/watchlist/:sym", async (req, res) => {
  const sym = decodeURIComponent(req.params.sym);
  let list = readJSON(WATCHLIST_FILE, DEFAULT_WATCHLIST);
  list = list.filter(s => s.sym !== sym);
  writeJSON(WATCHLIST_FILE, list);
  syncWatchlistToSheets(list).catch(e => console.error("Sheets sync failed:", e.message));
  res.json({ deleted: true, watchlist: list });
});

// Manual sync endpoint — force push current data to Google Sheets
app.post("/api/sync-sheets", async (req, res) => {
  const watchlist = readJSON(WATCHLIST_FILE, DEFAULT_WATCHLIST);
  const portfolio = readJSON(PORTFOLIO_FILE, []);
  await Promise.all([
    syncWatchlistToSheets(watchlist),
    syncPortfolioToSheets(portfolio)
  ]);
  res.json({ synced: true, timestamp: new Date().toISOString() });
});

// ── Portfolio — dual storage ──────────────────
app.get("/api/portfolio", async (req, res) => {
  let portfolio = readJSON(PORTFOLIO_FILE, null);
  let source = "local";
  if (!portfolio) {
    portfolio = await readPortfolioFromSheets();
    source = "google_sheets";
    if (portfolio) writeJSON(PORTFOLIO_FILE, portfolio);
  }
  res.json({ portfolio: portfolio || [], source });
});

app.post("/api/portfolio", async (req, res) => {
  const { symbol, qty, buyPrice, date } = req.body;
  if (!symbol || !qty || !buyPrice) return res.status(400).json({ error: "Missing fields" });
  const portfolio = readJSON(PORTFOLIO_FILE, []);
  const entry = { id: Date.now(), symbol, qty: +qty, buyPrice: +buyPrice, date: date || new Date().toISOString().slice(0,10) };
  portfolio.push(entry);
  writeJSON(PORTFOLIO_FILE, portfolio);
  syncPortfolioToSheets(portfolio).catch(e => console.error("Sheets sync failed:", e.message));
  res.json({ added: true, entry });
});

app.delete("/api/portfolio/:id", async (req, res) => {
  let portfolio = readJSON(PORTFOLIO_FILE, []);
  portfolio = portfolio.filter(p => p.id !== Number(req.params.id));
  writeJSON(PORTFOLIO_FILE, portfolio);
  syncPortfolioToSheets(portfolio).catch(e => console.error("Sheets sync failed:", e.message));
  res.json({ deleted: true });
});

// ── Settings ──────────────────────────────────
app.get("/api/settings", (req, res) => res.json(readJSON(SETTINGS_FILE, {})));
app.post("/api/settings", (req, res) => { writeJSON(SETTINGS_FILE, req.body); res.json({ saved: true }); });

// ── Email alerts ──────────────────────────────
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

app.post("/api/alert", async (req, res) => {
  const { to, cc, subject, symbol, price, score, threshold } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' email" });
  try {
    await mailer.sendMail({
      from: `CrashBuy Pro <${process.env.SMTP_USER}>`, to, cc: cc || undefined,
      subject: subject || `🚨 CrashBuy Alert: ${symbol} hit ${threshold}`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f4f6fb;border-radius:12px">
        <h2 style="color:#0052ff">CrashBuy Pro Alert</h2>
        <p><b>${symbol}</b> dropped <b style="color:#e03131">${threshold}</b></p>
        <div style="background:#fff;border-radius:8px;padding:16px;margin:16px 0">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#7a849a">Price</span><b>$${price}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#7a849a">Buy Score</span><b style="color:${score>=70?'#00a86b':score>=45?'#d97706':'#e03131'}">${score}/99</b></div>
        </div>
        <p style="color:#7a849a;font-size:12px">Review your plan in CrashBuy Pro.</p>
      </div>`,
    });
    res.json({ sent: true });
  } catch (err) { res.status(500).json({ error: "Email failed", detail: String(err) }); }
});

// ── SMS via Twilio ────────────────────────────
app.post("/api/sms", async (req, res) => {
  const { to, symbol, price, score, threshold } = req.body;
  const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return res.status(400).json({ error: "Twilio env vars not set" });
  if (!to) return res.status(400).json({ error: "Missing phone" });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { "Authorization": "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: from, To: to, Body: `CrashBuy: ${symbol} dropped ${threshold}. Price: $${price}. Score: ${score}/99.` }),
    });
    const data = await r.json();
    if (data.sid) res.json({ sent: true }); else res.status(500).json({ error: "Twilio error", detail: data });
  } catch (err) { res.status(500).json({ error: "SMS failed", detail: String(err) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CrashBuy Pro v4 running on :${PORT}`));
