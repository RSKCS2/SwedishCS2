/**
 * SWE CS2 Tracker — Cloudflare Worker (GRID API Proxy)
 *
 * Proxies GraphQL requests to GRID's two endpoints:
 *   POST /central → api-op.grid.gg/central-data/graphql     (schedule, teams, series)
 *   POST /live    → api-op.grid.gg/live-data-feed/series-state/graphql (live round scores)
 *
 * Secret: GRID_TOKEN  (Cloudflare → Worker → Settings → Variables & Secrets)
 */

const ALLOWED_ORIGINS = [
  'https://rskcs2.github.io',
];

const GRID_CENTRAL = 'https://api-op.grid.gg/central-data/graphql';
const GRID_LIVE    = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const path = new URL(request.url).pathname;
    const gridEndpoint = path === '/central' ? GRID_CENTRAL
                       : path === '/live'    ? GRID_LIVE
                       : null;

    if (!gridEndpoint) return new Response('Not found', { status: 404 });

    const body = await request.text();
    const gridResponse = await fetch(gridEndpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.GRID_TOKEN },
      body,
    });

    const data = await gridResponse.text();
    return new Response(data, {
      status: gridResponse.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
    });
  },
};
