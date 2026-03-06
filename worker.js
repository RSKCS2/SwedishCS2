/**
 * SWE CS2 Tracker — Cloudflare Worker
 *
 * GET  /csgo/*   → PandaScore (Swedish player/team detection)
 * POST /central  → GRID central-data (CS2 series schedule)
 * POST /live     → GRID series-state (live round scores)
 *
 * Secrets needed in Cloudflare → Worker → Settings → Variables & Secrets:
 *   PANDASCORE_TOKEN
 *   GRID_TOKEN
 */

const ALLOWED_ORIGINS = ['https://rskcs2.github.io'];

const GRID_CENTRAL = 'https://api-op.grid.gg/central-data/graphql';
const GRID_LIVE    = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';
const PANDA_BASE   = 'https://api.pandascore.co';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    // ── GRID (POST) ───────────────────────────────────────────────────────
    if (request.method === 'POST') {
      const endpoint = path === '/central' ? GRID_CENTRAL
                     : path === '/live'    ? GRID_LIVE
                     : null;
      if (!endpoint) return new Response('Not found', { status: 404 });

      const body = await request.text();
      const res  = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.GRID_TOKEN },
        body,
      });
      const data = await res.text();
      return new Response(data, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }

    // ── PANDASCORE (GET) ──────────────────────────────────────────────────
    if (request.method === 'GET') {
      if (!path.startsWith('/csgo/'))
        return new Response('Not found', { status: 404 });

      const pandaURL = PANDA_BASE + path + url.search;
      const res = await fetch(pandaURL, {
        headers: { 'Authorization': 'Bearer ' + env.PANDASCORE_TOKEN, 'Accept': 'application/json' },
      });
      const data = await res.text();
      return new Response(data, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }

    return new Response('Method not allowed', { status: 405 });
  },
};
