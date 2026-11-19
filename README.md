# Crumble — crumble.live

Static site for Crumble (crumble.live): sky-desk UI with Privy login, live Pons terminal data, and an AI ask box.

- `index.html` — the whole site
- `assets/` — logo + sky background
- `api/ask.js` — Vercel serverless function: answers questions about Pons coins using live GeckoTerminal data + Gemini

## Deploy

Connected to Vercel project `usecrumblenew` — every push to `main` auto-deploys to crumble.live.

## Env vars (set in Vercel, never commit)

- `GEMINI_API_KEY` — Gemini API key used by `api/ask.js` (Production scope)
