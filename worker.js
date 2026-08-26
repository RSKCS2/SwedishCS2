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
const KV_PLAYER_STATS    = 'player_game_stats';   // growing list of per-player-per-game rows
const KV_STATS_QUEUE     = 'player_stats_queue';  // finished games waiting to be fetched
const KV_STATS_DONE      = 'player_stats_done';   // game ids already processed (success OR permanent miss)
const STATS_BATCH_SIZE   = 5;                     // games fetched per scheduled tick — keep small, rate-limit safe

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

// ⚠️ VERIFY before relying on this in production: player-level fields
// (kills / deaths / killAssistsGiven / damage) belong to GRID's
// Statistics Feed product, which is a *separate* product from the
// central-data / live-data-feed endpoints QUERY_CS2_SERIES and
// QUERY_SERIES_STATE already use above. Depending on your GRID plan this
// query may 400, return nulls, or need a different endpoint entirely —
// check it against a real series id in GRID's GraphQL explorer first.
const QUERY_SERIES_STATE_PLAYERS = `
  query SeriesStatePlayers($id: ID!) {
    seriesState(id: $id) {
      id
      games {
        sequenceNumber
        finished
        map { name }
        teams {
          name
          players {
            name
            kills
            deaths
            killAssistsGiven
            damage { dealt }
          }
        }
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

// Single-team roster lookup, used by shared.js's classifyTeamCountry() to
// work out a non-Swedish team's roster nationality (e.g. MIBR, G2 Ares).
// Not part of the scheduled KV snapshot since it's only needed for teams
// as they show up in the UI, so this fetches PandaScore directly and
// caches the result in KV with its own TTL.
const TEAM_ROSTER_CACHE_TTL_S = 24 * 60 * 60; // seconds, for KV expirationTtl

async function fetchTeamRoster(teamId, token, env) {
  const kvKey = `team_roster_${teamId}`;
  const cached = await env.MATCH_DATA.get(kvKey);
  if (cached) return JSON.parse(cached);

  const res = await fetch(`${PANDA_BASE}/csgo/teams/${teamId}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`PandaScore team fetch failed: ${res.status}`);
  const data = await res.json();
  await env.MATCH_DATA.put(kvKey, JSON.stringify(data), { expirationTtl: TEAM_ROSTER_CACHE_TTL_S });
  return data;
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

// ─────────────────────────────────────────────────────────────────────────
// PLAYER STATS — PandaScore primary, GRID fallback, queue-based (small
// batch per scheduled tick, never re-fetches a finished game once done)
// ─────────────────────────────────────────────────────────────────────────

function normPlayerName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Pulls {gameId, matchId, mapName, t1, t2, date} for every finished game
// across the cached match history, so the queue always reflects reality
// even if a match was merged into history after its games already ended.
function extractFinishedGames(matches) {
  const out = [];
  matches.forEach(m => {
    (m.games || []).forEach(g => {
      if (g.status !== 'finished' && !g.finished) return;
      if (!g.id) return;
      out.push({
        gameId:  g.id,
        matchId: m.id,
        mapName: g.map?.name || null,
        t1: m.opponents?.[0]?.opponent || null,
        t2: m.opponents?.[1]?.opponent || null,
        date: m.begin_at || m.end_at || null,
      });
    });
  });
  return out;
}

async function getStatsQueue(env) {
  return JSON.parse(await env.MATCH_DATA.get(KV_STATS_QUEUE) || '[]');
}

async function getStatsDone(env) {
  return new Set(JSON.parse(await env.MATCH_DATA.get(KV_STATS_DONE) || '[]'));
}

// Adds newly-finished games to the queue. Skips anything already done or
// already queued, so this is safe to call every scheduled tick.
async function enqueueFinishedGames(matches, env) {
  const done = await getStatsDone(env);
  const queue = await getStatsQueue(env);
  const queuedIds = new Set(queue.map(q => q.gameId));
  let added = 0;
  extractFinishedGames(matches).forEach(g => {
    if (done.has(g.gameId) || queuedIds.has(g.gameId)) return;
    queue.push(g);
    queuedIds.add(g.gameId);
    added++;
  });
  if (added) await env.MATCH_DATA.put(KV_STATS_QUEUE, JSON.stringify(queue));
  return added;
}

// Extracts per-player rows from a PandaScore /csgo/games/{id} response.
// ⚠️ VERIFY: PandaScore's documented shape nests stats under
// game.players[].player_stats, but which fields are actually populated
// (ADR in particular) depends on plan tier — sanity-check a real response
// once this is deployed rather than trusting these field names blind.
function extractPandaPlayerRows(game, meta) {
  const rows = [];
  (game?.players || []).forEach(gp => {
    const stats = gp.player_stats || gp; // some plans flatten stats onto the player entry directly
    const playerId = gp.player?.id ?? gp.id;
    if (!playerId) return;
    rows.push({
      game_id:    meta.gameId,
      match_id:   meta.matchId,
      player_id:  playerId,
      team_id:    gp.team_id ?? gp.team?.id ?? null,
      kills:      stats.kills ?? 0,
      deaths:     stats.deaths ?? 0,
      assists:    stats.assists ?? 0,
      headshots:  stats.headshots ?? 0,
      adr:        stats.adr ?? stats.damage_per_round ?? null, // null (not 0) if your plan doesn't expose it
      map:        meta.mapName,
      date:       meta.date,
      source:     'pandascore',
    });
  });
  return rows;
}

async function fetchPandaGameStats(gameId, token) {
  const res = await fetch(`${PANDA_BASE}/csgo/games/${gameId}?include=players,players.player_stats`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    console.error(`PandaScore game ${gameId} fetch failed: ${res.status}`);
    return null;
  }
  return res.json();
}

// Best-effort match of a GRID player name to a PandaScore player id, using
// the already-KV-cached team roster (see fetchTeamRoster). Falls back to
// null (row is still stored, keyed by name) if no roster is cached yet.
async function resolveGridPlayerId(name, teamId, env) {
  if (!teamId) return null;
  try {
    const cached = await env.MATCH_DATA.get(`team_roster_${teamId}`);
    if (!cached) return null;
    const roster = JSON.parse(cached);
    const target = normPlayerName(name);
    const match = (roster?.players || []).find(p => normPlayerName(p.name) === target);
    return match?.id ?? null;
  } catch(_) { return null; }
}

// GRID fallback — only reached when PandaScore has no per-player stats for
// a game. Requires meta.t1/t2 (from the PandaScore match) to resolve GRID's
// series id via the same team-name fuzzy match used for live matches, and
// to attribute GRID's name-keyed players back to a PandaScore player id.
async function fetchGridPlayerRows(meta, token, env) {
  try {
    const centralResult = await queryGridCentral(
      {
        gte: new Date(new Date(meta.date).getTime() - 24 * 60 * 60 * 1000).toISOString(),
        lte: new Date(new Date(meta.date).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
      token
    );
    const gridSeriesList = centralResult?.data?.allSeries?.edges?.map(e => e.node) || [];
    const series = findGridSeries(meta.t1?.name || '', meta.t2?.name || '', gridSeriesList);
    if (!series) return [];

    const res = await fetch(GRID_LIVE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ query: QUERY_SERIES_STATE_PLAYERS, variables: { id: series.id } }),
    });
    if (!res.ok) { console.error(`GRID stats query failed: ${res.status}`); return []; }
    const json = await res.json();
    const game = json?.data?.seriesState?.games?.find(g => g.map?.name === meta.mapName);
    if (!game) return [];

    const rows = [];
    for (const t of (game.teams || [])) {
      const teamObj = normName(t.name) === normName(meta.t1?.name) ? meta.t1 : meta.t2;
      for (const p of (t.players || [])) {
        const playerId = await resolveGridPlayerId(p.name, teamObj?.id, env);
        rows.push({
          game_id:     meta.gameId,
          match_id:    meta.matchId,
          player_id:   playerId,       // may be null — see resolveGridPlayerId
          player_name: p.name,
          team_id:     teamObj?.id ?? null,
          kills:       p.kills ?? 0,
          deaths:      p.deaths ?? 0,
          assists:     p.killAssistsGiven ?? 0,
          headshots:   null,
          adr:         p.damage?.dealt ?? null,
          map:         meta.mapName,
          date:        meta.date,
          source:      'grid',
        });
      }
    }
    return rows;
  } catch(err) {
    console.error(`GRID stats fetch error: ${err.message}`);
    return [];
  }
}

// Pops a small batch off the queue, fetches PandaScore first / GRID second,
// appends new rows to the growing KV_PLAYER_STATS list, and marks every
// attempted game as done — including ones where neither source had data,
// so a permanently-stat-less game isn't retried forever.
async function processStatsQueue(env) {
  const queue = await getStatsQueue(env);
  if (!queue.length) return { processed: 0, newRows: 0, remaining: 0 };

  const batch     = queue.slice(0, STATS_BATCH_SIZE);
  const remaining = queue.slice(STATS_BATCH_SIZE);
  const done = await getStatsDone(env);

  const existingJson = await env.MATCH_DATA.get(KV_PLAYER_STATS);
  const existingStats = existingJson ? JSON.parse(existingJson) : [];
  const existingKeys = new Set(existingStats.map(r => `${r.game_id}_${r.player_id ?? r.player_name}`));
  let newRowCount = 0;

  for (const meta of batch) {
    let rows = [];
    try {
      const game = await fetchPandaGameStats(meta.gameId, env.PANDASCORE_TOKEN);
      rows = extractPandaPlayerRows(game, meta);
    } catch(e) { console.error(`Panda stats fetch error for game ${meta.gameId}: ${e.message}`); }

    if (!rows.length && env.GRID_TOKEN) {
      rows = await fetchGridPlayerRows(meta, env.GRID_TOKEN, env);
    }

    rows.forEach(r => {
      const key = `${r.game_id}_${r.player_id ?? r.player_name}`;
      if (!existingKeys.has(key)) {
        existingStats.push(r);
        existingKeys.add(key);
        newRowCount++;
      }
    });
    done.add(meta.gameId);
  }

  await env.MATCH_DATA.put(KV_PLAYER_STATS, JSON.stringify(existingStats));
  await env.MATCH_DATA.put(KV_STATS_DONE, JSON.stringify([...done]));
  await env.MATCH_DATA.put(KV_STATS_QUEUE, JSON.stringify(remaining));

  return { processed: batch.length, newRows: newRowCount, remaining: remaining.length };
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

    // ─── PLAYER STATS (small batch per run, never re-fetches a done game) ─
    console.log('Processing player stats queue...');
    try {
      const historyJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
      const historyForQueue = historyJson ? JSON.parse(historyJson) : [];
      const added = await enqueueFinishedGames(historyForQueue, env);
      if (added) console.log(`Queued ${added} newly finished games for stats`);

      const { processed, newRows, remaining } = await processStatsQueue(env);
      if (processed) console.log(`Player stats: processed ${processed} games, ${newRows} new rows, ${remaining} left in queue`);
    } catch(e) {
      console.error(`Player stats pipeline error: ${e.message}`);
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

    if (path.startsWith('/csgo/teams/')) {
      const teamId = path.split('/')[3];
      try {
        data = await fetchTeamRoster(teamId, env.PANDASCORE_TOKEN, env);
      } catch (err) {
        console.error(`Team roster fetch error: ${err.message}`);
        return new Response(
          JSON.stringify({ error: 'Could not fetch team roster' }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
        );
      }
    } else if (path.includes('/players')) {
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
    } else if (path.includes('/player-stats')) {
      // Serve per-player-per-game rows from player_game_stats, same
      // pagination pattern as /matches/past
      const statsJson = await env.MATCH_DATA.get(KV_PLAYER_STATS);
      if (statsJson) {
        const allStats = JSON.parse(statsJson);
        const startIdx = (pageParam - 1) * perPageParam;
        const endIdx = startIdx + perPageParam;
        data = allStats.slice(startIdx, endIdx);
      } else {
        data = []; // no stats collected yet — empty list, not an error
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
