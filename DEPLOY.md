# Deploy CrashBuy Backend (free, ~5 minutes)

This gives you a live URL like `https://crashbuy-backend.onrender.com` that the
dashboard can call for real SPY/QQQ prices and real email alerts.

## Option A: Render.com (recommended — free tier, easiest)

1. Go to https://render.com and sign up (free, no credit card for the free tier).
2. Push this folder to a new GitHub repo:
   ```bash
   cd crashbuy-backend
   git init
   git add .
   git commit -m "crashbuy backend"
   git remote add origin https://github.com/YOUR_USERNAME/crashbuy-backend.git
   git push -u origin main
   ```
3. In Render: **New +** → **Web Service** → connect your GitHub repo.
4. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
5. Add environment variables (Render dashboard → Environment):
   - `SMTP_HOST` = smtp.gmail.com (or your provider)
   - `SMTP_PORT` = 587
   - `SMTP_USER` = your@gmail.com
   - `SMTP_PASS` = your Gmail App Password (not your normal password —
     generate one at https://myaccount.google.com/apppasswords)
6. Click **Deploy**. Render gives you a URL like `https://crashbuy-backend-xxxx.onrender.com`.
7. Test it: open `https://crashbuy-backend-xxxx.onrender.com/api/price/SPY` in your
   browser — you should see live JSON with SPY's real price.

Note: Render's free tier spins down after inactivity, so the first request after
idle takes ~30s to wake up. Fine for personal use; upgrade to a paid tier ($7/mo)
for always-on.

## Option B: Vercel (also free, slightly different setup)

Vercel works best with serverless functions rather than a long-running Express
app. If you'd like the Vercel-style version (an `/api` folder with individual
function files instead of `server.js`), let me know and I'll generate that
variant instead.

## After deploying

Send me your live URL (e.g. `https://crashbuy-backend-xxxx.onrender.com`) and
I'll wire the dashboard's fetch calls to it so SPY/QQQ go live and email alerts
actually send.

## Local test (optional, before deploying)

```bash
cd crashbuy-backend
npm install
SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=you@gmail.com SMTP_PASS=yourapppassword npm start
```
Then visit http://localhost:3000/api/price/SPY
