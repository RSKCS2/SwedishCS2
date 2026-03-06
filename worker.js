/**
 * SWE CS2 Tracker — Cloudflare Worker
 *
 * GET  /csgo/*   → PandaScore (cached at the Worker edge)
 * POST /central  → GRID central-data
 * POST /live     → GRID series-state (never cached — always live)
 *
 * Secrets: PANDASCORE_TOKEN, GRID_TOKEN
 *
 * Cache TTLs (shared across ALL users — one fetch serves everyone):
 *   /csgo/players*          → 6 hours  (rosters barely change)
 *   /csgo/matches/past*     → 20 min   (history, good enough)
 *   /csgo/matches/running*  → 20 sec   (live scores)
 *   /csgo/matches/upcoming* → 5 min
 *   everything else         → 2 min
 */

const ALLOWED_ORIGINS = ['https://rskcs2.github.io'];
const GRID_CENTRAL    = 'https://api-op.grid.gg/central-data/graphql';
const GRID_LIVE       = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';
const PANDA_BASE      = 'https://api.pandascore.co';

function ttlForPath(path) {
  if (path.includes('/players'))          return 6 * 60 * 60;   // 6h
  if (path.includes('/matches/past'))     return 20 * 60;        // 20min
  if (path.includes('/matches/running'))  return 20;             // 20s
  if (path.includes('/matches/upcoming')) return 5 * 60;         // 5min
  return 2 * 60;                                                  // 2min default
}

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

    // ── GRID POST ─────────────────────────────────────────────────────────
    if (request.method === 'POST') {
      const endpoint = path === '/central' ? GRID_CENTRAL
                     : path === '/live'    ? GRID_LIVE
                     : null;
      if (!endpoint) return new Response('Not found', { status: 404 });

      // /central (schedule) can be cached 2min; /live must never be cached
      if (path === '/central') {
        const cacheKey = new Request('https://cache.internal/central', { method: 'GET' });
        const cache    = caches.default;
        const cached   = await cache.match(cacheKey);
        if (cached) {
          const clone = new Response(cached.body, cached);
          Object.entries(corsHeaders(origin)).forEach(([k, v]) => clone.headers.set(k, v));
          return clone;
        }
        const body = await request.text();
        const res  = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': env.GRID_TOKEN },
          body,
        });
        const data = await res.text();
        const response = new Response(data, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120', ...corsHeaders(origin) },
        });
        if (res.ok) await cache.put(cacheKey, response.clone());
        return response;
      }

      // /live — never cache
      const body = await request.text();
      const res  = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.GRID_TOKEN },
        body,
      });
      const data = await res.text();
      return new Response(data, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    }

    // ── PANDASCORE GET ────────────────────────────────────────────────────
    if (request.method === 'GET') {
      if (!path.startsWith('/csgo/'))
        return new Response('Not found', { status: 404 });

      const pandaURL = PANDA_BASE + path + url.search;
      const ttl      = ttlForPath(path);

      // Use Cloudflare's Cache API — keyed on the full PandaScore URL
      // All users hitting the same endpoint share ONE cached response
      const cacheKey = new Request(pandaURL, { method: 'GET' });
      const cache    = caches.default;
      const cached   = await cache.match(cacheKey);

      if (cached) {
        // Return cached response with correct CORS headers for this origin
        const clone = new Response(cached.body, cached);
        Object.entries(corsHeaders(origin)).forEach(([k, v]) => clone.headers.set(k, v));
        clone.headers.set('X-Cache', 'HIT');
        return clone;
      }

      // Cache miss — fetch from PandaScore
      const res = await fetch(pandaURL, {
        headers: { 'Authorization': 'Bearer ' + env.PANDASCORE_TOKEN, 'Accept': 'application/json' },
      });
      const data = await res.text();
      const response = new Response(data, {
        status: res.status,
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${ttl}`,
          'X-Cache':       'MISS',
          ...corsHeaders(origin),
        },
      });

      // Only cache successful responses
      if (res.ok) await cache.put(cacheKey, response.clone());
      return response;
    }

    return new Response('Method not allowed', { status: 405 });
  },
};
