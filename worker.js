/**
 * SWE CS2 Tracker — Cloudflare Worker Proxy
 *
 * Proxies requests from your GitHub Pages site to PandaScore API.
 * Your API key lives ONLY here as an environment secret — never in frontend code.
 *
 * SETUP (one-time, ~5 minutes):
 * ─────────────────────────────
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Paste this entire file into the editor, click "Deploy"
 * 3. Go to your Worker → Settings → Variables → Add variable:
 *      Name:  PANDASCORE_TOKEN
 *      Value: your PandaScore API key
 *      ✓ Check "Encrypt" to store it as a secret
 * 4. Click "Deploy" again after saving the variable
 * 5. Copy your Worker URL  (e.g. https://swe-cs2.YOUR-NAME.workers.dev)
 * 6. Paste it into shared.js  →  const WORKER_URL = 'https://...'
 *
 * That's it. Your key is never exposed to the browser.
 */

// ── CORS ─────────────────────────────────────────────────────────────────────
// Allow requests from your GitHub Pages domain AND localhost for local dev.
// If you want to lock it down further, replace the wildcard with your exact domain.
const ALLOWED_ORIGINS = [
  'https://YOUR-GITHUB-USERNAME.github.io',   // ← replace with your GitHub Pages URL
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Extract the PandaScore path + query from the incoming URL
    // e.g. /csgo/matches/running?per_page=50&include=games,opponents
    const url = new URL(request.url);
    const pandaPath = url.pathname + url.search;

    // Only allow requests to the CS:GO / CS2 section of PandaScore
    if (!pandaPath.startsWith('/csgo/')) {
      return new Response('Not found', { status: 404 });
    }

    // Forward to PandaScore with the secret token
    const pandaURL = `https://api.pandascore.co${pandaPath}`;
    const pandaResponse = await fetch(pandaURL, {
      headers: {
        'Authorization': `Bearer ${env.PANDASCORE_TOKEN}`,
        'Accept': 'application/json',
      },
    });

    const data = await pandaResponse.text();

    return new Response(data, {
      status: pandaResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders(origin),
      },
    });
  },
};
