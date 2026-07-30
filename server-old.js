// CrashBuy Pro Backend
// Proxies stock prices (Yahoo Finance) past CORS, and sends email alerts via Nodemailer.
// Deploy free on Render.com or Vercel — see DEPLOY.md

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

// ───────────────────────────────────────────────
// Stock price proxy — works around Yahoo Finance CORS blocking
// GET /api/price/SPY  ->  { symbol, price, prevClose, changePct }
// ───────────────────────────────────────────────
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

// Batch endpoint — GET /api/prices?symbols=SPY,QQQ,NVDA
app.get("/api/prices", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: "Provide ?symbols=SPY,QQQ" });

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return { symbol, error: "not found" };
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose ?? meta.previousClose;
        const changePct = prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0;
        return { symbol, price, prevClose, changePct };
      } catch (e) {
        return { symbol, error: String(e) };
      }
    })
  );
  res.json({ results, updatedAt: new Date().toISOString() });
});

// ───────────────────────────────────────────────
// Email alerts via Nodemailer
// Set env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
// For Gmail: use an "App Password", not your normal password.
// ───────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

app.post("/api/alert", async (req, res) => {
  const { to, cc, subject, symbol, price, score, threshold } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' email" });

  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to,
      cc: cc || undefined,
      subject: subject || `CrashBuy Alert: ${symbol} hit ${threshold}%`,
      html: `
        <h2>CrashBuy Pro Alert</h2>
        <p><b>${symbol}</b> has dropped <b>${threshold}%</b> from its recent high.</p>
        <ul>
          <li>Current price: $${price}</li>
          <li>Crash Buy Score: ${score}</li>
        </ul>
        <p>Review your tranche plan in the dashboard.</p>
      `,
    });
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to send email", detail: String(err) });
  }
});

app.get("/", (req, res) => res.send("CrashBuy Pro backend is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CrashBuy backend running on :${PORT}`));
