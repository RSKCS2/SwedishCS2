/**
 * SWE CS2 Tracker — Cloudflare Worker (refactored for KV caching via scheduled handler)
 *
 * GET  /csgo/*   → KV cache (live_data, history_data)
 * POST /central  → KV cache (live_data)
 * POST /live     → KV cache (live_data)
 *
 * Scheduled handler (cron): Fetches from PandaScore + GRID, stores in KV
 *
 * Secrets: PANDASCORE_TOKEN, GRID_TOKEN, WORKER_SECRET, TURNSTILE_SECRET
 *   WORKER_SECRET now doubles as the HMAC signing key for session tokens
 *   (it never leaves the Worker, so reusing it is fine)
 * KV Namespaces: MATCH_DATA
 *
 * POST /session → exchanges a Turnstile token for a short-lived signed
 *   session token, used instead of a static shared secret
 */

const ALLOWED_ORIGINS = ['https://rskcs2.github.io'];
const GRID_CENTRAL    = 'https://api-op.grid.gg/central-data/graphql';
const GRID_LIVE       = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';
const PANDA_BASE      = 'https://api.pandascore.co';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SESSION_TTL_MS  = 30 * 60 * 1000; // must match SESSION_TTL_MS in shared.js

// KV keys
const KV_LIVE_DATA       = 'live_data';
const KV_HISTORY_DATA    = 'history_data';
const KV_HISTORY_CURSOR  = 'history_cursor';
const KV_SWEDISH_TEAMS   = 'swedish_teams';

// ── GRID QUERIES (from shared.js) ─────────────────────────────────────────
const QUERY_CS2_SERIES = `
  query CS2Series($gte: String!, $lte: String!) {
    allSeries(
      filter: { startTimeScheduled: { gte: $gte, lte: $lte } }
      orderBy: StartTimeScheduled
      first: 50
    ) {
      edges {
        node {
          id
          startTimeScheduled
          title { nameShortened }
          tournament { name }
          format { nameShortened }
          teams {
            baseInfo { id name logoUrl }
            scoreAdvantage
          }
        }
      }
    }
  }
`;

const QUERY_SERIES_STATE = `
  query SeriesState($id: ID!) {
    seriesState(id: $id) {
      id
      started
      finished
      teams { name won }
      games {
        sequenceNumber
        started
        finished
        map { name }
        teams { name score }
      }
    }
  }
`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── SESSION TOKEN (HMAC-signed, replaces static X-Worker-Secret) ──────────
// Format: "<expiryEpochMs>.<hexHmacSha256>"

async function _hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function _timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function createSessionToken(secret) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sig = await _hmacSign(String(expiresAt), secret);
  return { session: `${expiresAt}.${sig}`, expiresAt };
}

async function verifySessionToken(token, secret) {
  if (!token || !token.includes('.')) return false;
  const [expiryStr, sig] = token.split('.');
  const expiry = parseInt(expiryStr, 10);
  if (!expiry || Date.now() > expiry) return false;
  const expected = await _hmacSign(expiryStr, secret);
  return _timingSafeEqual(sig, expected);
}

async function verifyTurnstileToken(token, secret, remoteIp) {
  const res = await fetch(TURNSTILE_VERIFY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ secret, response: token, remoteip: remoteIp || '' }),
  });
  const raw = await res.text();
  if (!res.ok) {
    return { success: false, 'error-codes': [`siteverify-http-${res.status}`], _rawBody: raw };
  }
  try {
    return JSON.parse(raw);
  } catch(_) {
    return { success: false, 'error-codes': ['siteverify-non-json-response'], _rawBody: raw };
  }
}

async function isAuthorized(request, env) {
  const origin  = request.headers.get('Origin') || '';
  const session = request.headers.get('X-Session-Token') || '';

  if (!ALLOWED_ORIGINS.includes(origin)) return false;
  return verifySessionToken(session, env.WORKER_SECRET);
}

// ─────────────────────────────────────────────────────────────────────────
// SCHEDULED HANDLER — Fetches and caches everything
// ─────────────────────────────────────────────────────────────────────────

async function fetchPandascoreWithPagination(url, token, maxPages = 999) {
  const results = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const paginatedUrl = `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
    try {
      const res = await fetch(paginatedUrl, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      if (!res.ok) {
        console.error(`PandaScore request failed: ${res.status}`);
        hasMore = false;
        break;
      }
      const data = await res.json();
      results.push(...(data || []));
      hasMore = data && data.length > 0;
      page++;
    } catch (err) {
      console.error(`PandaScore fetch error: ${err.message}`);
      hasMore = false;
    }
  }

  return results;
}

async function fetchSwedishPlayers(token) {
  const url = `${PANDA_BASE}/csgo/players?filter[nationality]=SE&per_page=100`;
  return fetchPandascoreWithPagination(url, token);
}

async function fetchRunningMatches(token) {
  const url = `${PANDA_BASE}/csgo/matches/running?per_page=50&include=opponents,results,games,pick_bans`;
  return fetchPandascoreWithPagination(url, token, 1);
}

async function fetchUpcomingMatches(token) {
  const url = `${PANDA_BASE}/csgo/matches/upcoming?per_page=30&sort=begin_at&include=opponents`;
  return fetchPandascoreWithPagination(url, token, 1);
}

async function fetchSwedishTeamMatches(teamId, token) {
  // Use filter[opponent_id] instead of filter[team_id]
  // Include opponents, results, and sort by -end_at (newest first)
  const url = `${PANDA_BASE}/csgo/matches/past?filter[opponent_id]=${teamId}&per_page=100&include=opponents,results&sort=-end_at`;
  return fetchPandascoreWithPagination(url, token);
}

function isSwedishTeam(match, swedishTeamIds) {
  if (!match.opponents || match.opponents.length < 2) return false;
  const team1Id = match.opponents[0]?.opponent?.id;
  const team2Id = match.opponents[1]?.opponent?.id;
  return swedishTeamIds.includes(team1Id) || swedishTeamIds.includes(team2Id);
}

async function queryGridCentral(variables, token) {
  // Use actual QUERY_CS2_SERIES from shared.js
  try {
    const res = await fetch(GRID_CENTRAL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({ query: QUERY_CS2_SERIES, variables }),
    });
    if (!res.ok) {
      console.error(`GRID central query failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`GRID central fetch error: ${err.message}`);
    return null;
  }
}

async function queryGridLive(seriesId, token) {
  // Use actual QUERY_SERIES_STATE from shared.js
  try {
    const res = await fetch(GRID_LIVE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
      },
      body: JSON.stringify({ query: QUERY_SERIES_STATE, variables: { id: seriesId } }),
    });
    if (!res.ok) {
      console.error(`GRID live query failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`GRID live fetch error: ${err.message}`);
    return null;
  }
}

// Team name matching from shared.js
function normName(name) {
  return (name || '').toLowerCase().replace(/esports?|gaming|team\s|\.|\s/g, '').trim();
}

function findGridSeries(t1Name, t2Name, gridSeriesList) {
  const n1 = normName(t1Name);
  const n2 = normName(t2Name);
  return gridSeriesList.find(s => {
    const gn = s.teams?.map(t => normName(t.baseInfo?.name)) || [];
    return gn.some(n => n === n1 || n.includes(n1) || n1.includes(n)) &&
           gn.some(n => n === n2 || n.includes(n2) || n2.includes(n));
  }) || null;
}

async function attachGridStateToRunningMatches(runningMatches, swedishTeamIds, gridToken) {
  // For each Swedish running match, find corresponding GRID series and fetch live state
  for (const match of runningMatches) {
    if (!isSwedishTeam(match, swedishTeamIds)) continue;

    const team1 = match.opponents?.[0]?.opponent?.name || '';
    const team2 = match.opponents?.[1]?.opponent?.name || '';
    
    // Query GRID central-data for CS2 series in a time window (±5 min around match start)
    const matchTime = new Date(match.begin_at);
    const startTime = new Date(matchTime.getTime() - 5 * 60 * 1000).toISOString();
    const endTime = new Date(matchTime.getTime() + 5 * 60 * 1000).toISOString();

    const centralResult = await queryGridCentral(
      { gte: startTime, lte: endTime },
      gridToken
    );

    if (!centralResult?.data?.allSeries?.edges) continue;

    // Extract series from edges
    const gridSeriesList = centralResult.data.allSeries.edges.map(e => e.node);

    // Find matching series using team name fuzzy matching
    const matchedSeries = findGridSeries(team1, team2, gridSeriesList);

    // If matched, fetch live series state
    if (matchedSeries) {
      const liveResult = await queryGridLive(matchedSeries.id, gridToken);
      match.grid_state = liveResult?.data?.seriesState || null;
    }
  }

  return runningMatches;
}

async function rotateHistoryTeam(env) {
  // Get or initialize the team list and cursor
  let teams = JSON.parse(await env.MATCH_DATA.get(KV_SWEDISH_TEAMS) || '[]');
  if (teams.length === 0) {
    // Fetch Swedish teams from PandaScore if not cached
    const players = await fetchSwedishPlayers(env.PANDASCORE_TOKEN);
    const teamSet = new Set();
    for (const player of players) {
      if (player.current_team?.id) teamSet.add(player.current_team.id);
    }
    teams = Array.from(teamSet);
    await env.MATCH_DATA.put(KV_SWEDISH_TEAMS, JSON.stringify(teams));
  }

  if (teams.length === 0) return null;

  // Get the cursor (which team to fetch next)
  let cursor = parseInt(await env.MATCH_DATA.get(KV_HISTORY_CURSOR) || '0');
  cursor = cursor % teams.length;

  const teamId = teams[cursor];
  const nextCursor = (cursor + 1) % teams.length;
  await env.MATCH_DATA.put(KV_HISTORY_CURSOR, String(nextCursor));

  return { teamId, cursor, nextCursor };
}

async function mergeHistoryData(existing, newMatches) {
  // Merge new matches with existing history, avoiding duplicates by ID
  const existingMap = new Map(existing.map(m => [m.id, m]));
  for (const match of newMatches) {
    existingMap.set(match.id, match);
  }
  return Array.from(existingMap.values());
}

async function handleScheduled(env) {
  try {
    console.log('Scheduled handler triggered');

    // ─── LIVE DATA (every run) ───────────────────────────────────────
    console.log('Fetching live data...');

    // Fetch Swedish players
    const players = await fetchSwedishPlayers(env.PANDASCORE_TOKEN);
    const swedishTeamIds = new Set();
    for (const player of players) {
      if (player.current_team?.id) swedishTeamIds.add(player.current_team.id);
    }

    // Fetch running and upcoming matches
    let runningMatches = await fetchRunningMatches(env.PANDASCORE_TOKEN);
    runningMatches = runningMatches.filter(m => isSwedishTeam(m, Array.from(swedishTeamIds)));

    // Attach GRID state to running matches
    runningMatches = await attachGridStateToRunningMatches(
      runningMatches,
      Array.from(swedishTeamIds),
      env.GRID_TOKEN
    );

    let upcomingMatches = await fetchUpcomingMatches(env.PANDASCORE_TOKEN);
    upcomingMatches = upcomingMatches.filter(m => isSwedishTeam(m, Array.from(swedishTeamIds)));

    // Store live data
    const liveData = {
      timestamp: new Date().toISOString(),
      players,
      running_matches: runningMatches,
      upcoming_matches: upcomingMatches,
    };

    await env.MATCH_DATA.put(KV_LIVE_DATA, JSON.stringify(liveData));
    console.log('Live data updated');

    // ─── HISTORY DATA (one team per run) ─────────────────────────────
    console.log('Fetching history data...');

    const rotation = await rotateHistoryTeam(env);
    if (rotation) {
      console.log(`Fetching history for team ${rotation.teamId} (cursor: ${rotation.cursor})`);
      
      const newMatches = await fetchSwedishTeamMatches(rotation.teamId, env.PANDASCORE_TOKEN);
      
      // Merge with existing history
      const existingHistoryJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
      const existingHistory = existingHistoryJson ? JSON.parse(existingHistoryJson) : [];
      
      const mergedHistory = await mergeHistoryData(existingHistory, newMatches);
      await env.MATCH_DATA.put(KV_HISTORY_DATA, JSON.stringify(mergedHistory));
      
      console.log(`History updated: ${mergedHistory.length} total matches`);
    }

    console.log('Scheduled handler completed');
  } catch (err) {
    console.error(`Scheduled handler error: ${err.message}`);
    // Do NOT clear KV data on error — let the last good data persist
  }
}

async function handleFetch(request, env) {
  const origin = request.headers.get('Origin') || '';
  const url    = new URL(request.url);
  const path   = url.pathname;

  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(origin) });

  // Session exchange: no session token required yet, this is what mints one.
  // Still origin-gated, and the Turnstile site key is itself bound to
  // rskcs2.github.io, so tokens minted elsewhere won't verify anyway.
  if (request.method === 'POST' && path === '/session') {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders(origin) });
    }

    let body;
    try { body = await request.json(); } catch(_) { body = {}; }
    const turnstileToken = body.token || '';
    if (!turnstileToken) {
      return new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const remoteIp = request.headers.get('CF-Connecting-IP') || '';

    // TEMPORARY: confirm the secret is actually bound before calling out to Turnstile.
    if (!env.TURNSTILE_SECRET) {
      return new Response(JSON.stringify({
        error: 'TURNSTILE_SECRET is not set on this Worker (env.TURNSTILE_SECRET is falsy)',
      }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const verifyData = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET, remoteIp);
    if (!verifyData.success) {
      // TEMPORARY: echoing Turnstile's error codes back to diagnose the 403.
      // Remove the errorCodes field once this is confirmed working.
      return new Response(JSON.stringify({
        error: 'Turnstile verification failed',
        errorCodes: verifyData['error-codes'] || [],
        rawBody: verifyData._rawBody || null,
      }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const { session, expiresAt } = await createSessionToken(env.WORKER_SECRET);
    return new Response(JSON.stringify({ session, expiresAt }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Reject unauthorized requests early
  if (!(await isAuthorized(request, env))) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders(origin) });
  }

  // ─── GRID POST (read from KV) ────────────────────────────────────
  if (request.method === 'POST') {
    if (path === '/central' || path === '/live') {
      // Both /central and /live now serve from KV live_data
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (!liveDataJson) {
        return new Response(
          JSON.stringify({ error: 'No live data cached' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
        );
      }
      return new Response(liveDataJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
      });
    }
    return new Response('Not found', { status: 404 });
  }

  // ─── PANDASCORE GET (read from KV with pagination support) ──────────
  if (request.method === 'GET') {
    if (!path.startsWith('/csgo/'))
      return new Response('Not found', { status: 404 });

    // Handle pagination for /csgo/players and /csgo/matches/past
    const pageParam = parseInt(url.searchParams.get('page') || '1');
    const perPageParam = parseInt(url.searchParams.get('per_page') || '100');

    let data = null;

    if (path.includes('/players')) {
      // Serve players from live_data with pagination support
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        const liveData = JSON.parse(liveDataJson);
        const allPlayers = liveData.players || [];
        
        // Implement pagination: slice the full dataset
        const startIdx = (pageParam - 1) * perPageParam;
        const endIdx = startIdx + perPageParam;
        data = allPlayers.slice(startIdx, endIdx);
      }
    } else if (path.includes('/matches/running')) {
      // Serve running matches from live_data
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        const liveData = JSON.parse(liveDataJson);
        data = liveData.running_matches || [];
      }
    } else if (path.includes('/matches/upcoming')) {
      // Serve upcoming matches from live_data
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        const liveData = JSON.parse(liveDataJson);
        data = liveData.upcoming_matches || [];
      }
    } else if (path.includes('/matches/past')) {
      // Serve history from history_data with pagination support
      const historyJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
      if (historyJson) {
        const allHistory = JSON.parse(historyJson);
        
        // Implement pagination: slice the full dataset
        const startIdx = (pageParam - 1) * perPageParam;
        const endIdx = startIdx + perPageParam;
        data = allHistory.slice(startIdx, endIdx);
      }
    }

    if (data === null) {
      return new Response(
        JSON.stringify({ error: 'No cached data' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}

export default {
  async fetch(request, env) {
    return handleFetch(request, env);
  },
  async scheduled(event, env) {
    await handleScheduled(env);
  },
};
