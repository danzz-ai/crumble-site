// Crumble — /api/ask
// Vercel serverless function. Answers "Ask Crumble anything on chain"
// questions for real: it reads the visitor's question, pulls live Pons
// pool data from GeckoTerminal (Robinhood Chain), and asks Gemini
// (gemini-3.5-flash-lite) to answer with that data as context.
//
// SETUP: the Gemini key is read ONLY from the GEMINI_API_KEY environment
// variable (Vercel dashboard → Project → Settings → Environment
// Variables). Never write the key into this file or anywhere in code.

const GECKO_NEW_POOLS =
  "https://api.geckoterminal.com/api/v2/networks/robinhood/new_pools";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL +
  ":generateContent";

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  // Vercel usually pre-parses JSON bodies into req.body; fall back to
  // reading the raw stream so this also works in plain Node runtimes.
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string" && req.body) {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function fmtUsd(v) {
  const n = Number(v);
  if (!isFinite(n)) return "n/a";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function poolContext(pools) {
  return pools
    .slice(0, 25)
    .map((p, i) => {
      const a = p.attributes || {};
      const dex =
        (p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id) || "?";
      const vol = a.volume_usd || {};
      const chg = a.price_change_percentage || {};
      return [
        `${i + 1}. ${a.name || "?"} (dex: ${dex})`,
        `price ${fmtUsd(a.base_token_price_usd)}`,
        `reserve ${fmtUsd(a.reserve_in_usd)}`,
        `vol h1 ${fmtUsd(vol.h1)} / h24 ${fmtUsd(vol.h24)}`,
        `change h1 ${chg.h1 ?? "n/a"}% / h24 ${chg.h24 ?? "n/a"}%`,
        `created ${a.pool_created_at || "?"}`,
      ].join(" · ");
    })
    .join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed — use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      ok: false,
      error:
        "GEMINI_API_KEY is not set on the server. Add it as an Environment Variable in the Vercel dashboard (Project → Settings → Environment Variables) and redeploy.",
    });
  }

  const body = await readBody(req);
  const question = String(body.question || "").trim().slice(0, 600);
  if (!question) {
    return sendJson(res, 400, { ok: false, error: "No question was sent." });
  }
  const agents = Math.min(6, Math.max(1, parseInt(body.agents, 10) || 3));

  // 1) Live Pons pool data from GeckoTerminal (Robinhood Chain).
  let pools = [];
  let poolsLive = false;
  try {
    const gRes = await fetch(GECKO_NEW_POOLS, {
      headers: { Accept: "application/json" },
    });
    if (gRes.ok) {
      const gJson = await gRes.json();
      if (Array.isArray(gJson.data)) {
        pools = gJson.data;
        poolsLive = pools.length > 0;
      }
    }
  } catch (e) {
    pools = [];
    poolsLive = false;
  }

  const context = poolsLive
    ? poolContext(pools)
    : "(Live pool data could not be fetched from GeckoTerminal just now — say so plainly if the question needs pool numbers, and do not invent any.)";

  // 2) Ask Gemini with the question + pool data as context.
  const prompt = [
    "You are Crumble, an on-chain AI desk for Pons coins on Robinhood Chain.",
    "Answer the visitor's question using ONLY the live pool data below for any numbers, prices, volumes, or coin names. Never invent figures that are not in the data. If the data does not cover the question, say that honestly and answer what you can in general terms.",
    "Reply in the same language the visitor used.",
    "Keep the answer under 180 words, plain text, no markdown tables.",
    'Respond with ONLY a JSON object, no code fences: {"verdict":"BUY" | "WATCH" | "PASS" | "ANSWER","coin":"the main coin ticker the answer is about, or empty string","title":"a short headline for the answer, max 8 words","answer":"the full answer text"}',
    "Use verdict BUY, WATCH, or PASS only when the question is about a specific coin or pool in the data; otherwise use ANSWER.",
    "",
    "LIVE PONS POOLS (GeckoTerminal, Robinhood Chain, newest first):",
    context,
    "",
    "VISITOR QUESTION:",
    question,
  ].join("\n");

  let geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 900,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      error: "Couldn't reach Gemini from the server. Try again in a moment.",
    });
  }

  if (!geminiRes.ok) {
    let detail = "";
    try {
      const errJson = await geminiRes.json();
      detail = (errJson.error && errJson.error.message) || "";
    } catch (e) { /* keep detail empty */ }
    return sendJson(res, 502, {
      ok: false,
      error:
        "Gemini returned HTTP " + geminiRes.status + (detail ? ": " + detail : "") +
        ". If this is a key error, check the GEMINI_API_KEY environment variable in the Vercel dashboard.",
    });
  }

  const geminiJson = await geminiRes.json();
  const parts =
    (geminiJson.candidates &&
      geminiJson.candidates[0] &&
      geminiJson.candidates[0].content &&
      geminiJson.candidates[0].content.parts) ||
    [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) {
    return sendJson(res, 502, { ok: false, error: "Gemini replied with an empty answer." });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (e) {
    parsed = null;
  }

  const answer = {
    ok: true,
    question,
    verdict: parsed && parsed.verdict ? String(parsed.verdict).toUpperCase() : "ANSWER",
    coin: parsed && parsed.coin ? String(parsed.coin) : "",
    title: parsed && parsed.title ? String(parsed.title) : "Crumble's answer",
    answer: parsed && parsed.answer ? String(parsed.answer) : text,
    agents,
    model: GEMINI_MODEL,
    poolsLive,
    poolsUsed: pools.length,
    fetchedAt: new Date().toISOString(),
  };
  return sendJson(res, 200, answer);
};
