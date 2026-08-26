/**
 * SWE CS2 Tracker — Cloudflare Worker
 *
 * GET  /csgo/*   → KV cache, with fallback to live PandaScore if cache empty
 * POST /central  → KV cache (live_data)
 * POST /live     → KV cache (live_data)
 *
 * Scheduled handler (cron): Fetches from PandaScore + GRID, stores in KV
 *
 * Secrets: PANDASCORE_TOKEN, GRID_TOKEN, WORKER_SECRET, TURNSTILE_SECRET
 * KV Namespaces: MATCH_DATA
 */

const ALLOWED_ORIGINS = ['https://rskcs2.github.io'];
const GRID_CENTRAL    = 'https://api-op.grid.gg/central-data/graphql';
const GRID_LIVE       = 'https://api-op.grid.gg/live-data-feed/series-state/graphql';
const PANDA_BASE      = 'https://api.pandascore.co';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SESSION_TTL_MS  = 30 * 60 * 1000;

const KV_LIVE_DATA       = 'live_data';
const KV_HISTORY_DATA    = 'history_data';
const KV_HISTORY_CURSOR  = 'history_cursor';
const KV_SWEDISH_TEAMS   = 'swedish_teams';
const KV_SWEDISH_TEAM_NAMES = 'swedish_team_names';
const KV_PLAYER_STATS    = 'player_game_stats';
const KV_STATS_QUEUE     = 'player_stats_queue';
const KV_STATS_DONE      = 'player_stats_done';
const STATS_BATCH_SIZE   = 5;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── SESSION TOKEN ──────────────────────────────────────────────────────────
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

// ── HELPER: fetch from PandaScore with pagination ──────────────────────
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

// ── SINGLE TEAM ROSTER (with KV cache) ──────────────────────────────────
const TEAM_ROSTER_CACHE_TTL_S = 24 * 60 * 60;
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

// ── GRID QUERIES (from shared.js) ───────────────────────────────────────
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

// ── TEAM NAME MATCHING ────────────────────────────────────────────────────
function normName(name) {
  return (name || '').toLowerCase().replace(/esports?|gaming|team\s|\.|\s/g, '').trim();
}

function findGridSeries(t1Name, t2Name, gridSeriesList) {
  const n1 = normName(t1Name), n2 = normName(t2Name);
  return gridSeriesList.find(s => {
    const gn = s.teams?.map(t => normName(t.baseInfo?.name)) || [];
    return gn.some(n => n === n1 || n.includes(n1) || n1.includes(n)) &&
           gn.some(n => n === n2 || n.includes(n2) || n2.includes(n));
  }) || null;
}

async function queryGridCentral(variables, token) {
  try {
    const res = await fetch(GRID_CENTRAL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': token },
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
  try {
    const res = await fetch(GRID_LIVE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': token },
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

async function fetchSwedishPlayers(token) {
  const url = `${PANDA_BASE}/csgo/players?filter[nationality]=SE&per_page=100`;
  return fetchPandascoreWithPagination(url, token);
}

async function tryPanda(fetcher, fallback = null) {
  try {
    return await fetcher();
  } catch (err) {
    console.error(`PandaScore failed: ${err.message}`);
    return fallback;
  }
}

function saveSwedishTeamMetadata(players, env) {
  const ids = new Set();
  const names = new Set();

  for (const player of (players || [])) {
    const team = player.current_team;
    if (!team) continue;
    if (team.id) ids.add(String(team.id));
    if (team.name) names.add(team.name);
  }

  return Promise.all([
    env.MATCH_DATA.put(KV_SWEDISH_TEAMS, JSON.stringify([...ids])),
    env.MATCH_DATA.put(KV_SWEDISH_TEAM_NAMES, JSON.stringify([...names])),
  ]);
}

async function getCachedSwedishTeamNames(env) {
  try {
    return JSON.parse(await env.MATCH_DATA.get(KV_SWEDISH_TEAM_NAMES) || '[]');
  } catch (_) {
    return [];
  }
}

function isGridSwedishSeries(series, swedishTeamNames) {
  const targetNames = new Set((swedishTeamNames || []).map(normName));
  if (!targetNames.size) return false;

  return (series.teams || []).some(team =>
    targetNames.has(normName(team.baseInfo?.name))
  );
}

function gridSeriesToPandaMatch(series, state = null) {
  const teams = (series.teams || []).map(t => ({
    opponent: {
      id: `grid-${t.baseInfo?.id ?? ''}`,
      name: t.baseInfo?.name || 'TBD',
      image_url: t.baseInfo?.logoUrl || null,
    },
    scoreAdvantage: t.scoreAdvantage ?? 0,
  }));

  const games = (state?.games || []).map(g => ({
    sequence_number: g.sequenceNumber,
    status: g.finished ? 'finished' : g.started ? 'running' : 'not_started',
    finished: !!g.finished,
    map: g.map ? { name: g.map.name } : null,
    teams: (g.teams || []).map(t => ({
      id: t.id,
      team: { id: t.id, name: t.name },
      score: t.score ?? 0,
    })),
  }));

  let results = [];
  if (state?.teams?.length && teams.length) {
    results = state.teams.map(st => {
      const matchTeam = teams.find(t => normName(t.opponent.name) === normName(st.name));
      return {
        team_id: matchTeam?.opponent?.id,
        score: st.score ?? 0,
      };
    });
  }

  const finished = !!state?.finished;
  const started = !!state?.started;

  return {
    id: `grid-${series.id}`,
    begin_at: series.startTimeScheduled,
    end_at: finished ? series.startTimeScheduled : null,
    status: finished ? 'finished' : started ? 'running' : 'not_started',
    name: series.title?.nameShortened || `${teams[0]?.opponent?.name || 'TBD'} vs ${teams[1]?.opponent?.name || 'TBD'}`,
    opponents: teams.slice(0, 2),
    results,
    games,
    winner: null,
    league: null,
    serie: null,
    tournament: { name: series.tournament?.name || 'CS2' },
    grid_series_id: series.id,
    grid_state: state,
    source: 'grid',
  };
}

async function fetchGridSeriesWindow(gridToken, gte, lte, swedishTeamNames = []) {
  const result = await queryGridCentral({ gte, lte }, gridToken);
  const series = result?.data?.allSeries?.edges?.map(e => e.node) || [];
  return swedishTeamNames.length
    ? series.filter(s => isGridSwedishSeries(s, swedishTeamNames))
    : series;
}

async function fetchGridMatches(gridToken, swedishTeamNames, gte, lte, includeState = false) {
  const series = await fetchGridSeriesWindow(gridToken, gte, lte, swedishTeamNames);
  const out = [];

  for (const s of series) {
    let state = null;
    if (includeState || new Date(s.startTimeScheduled) <= new Date()) {
      const live = await queryGridLive(s.id, gridToken);
      state = live?.data?.seriesState || null;
    }
    out.push(gridSeriesToPandaMatch(s, state));
  }

  return out;
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
  const url = `${PANDA_BASE}/csgo/matches/past?filter[opponent_id]=${teamId}&per_page=100&include=opponents,results&sort=-end_at`;
  return fetchPandascoreWithPagination(url, token);
}

function isSwedishTeam(match, swedishTeamIds) {
  if (!match.opponents || match.opponents.length < 2) return false;
  const team1Id = match.opponents[0]?.opponent?.id;
  const team2Id = match.opponents[1]?.opponent?.id;
  return swedishTeamIds.includes(team1Id) || swedishTeamIds.includes(team2Id);
}

async function attachGridStateToRunningMatches(runningMatches, swedishTeamIds, gridToken) {
  for (const match of runningMatches) {
    if (!isSwedishTeam(match, swedishTeamIds)) continue;
    const team1 = match.opponents?.[0]?.opponent?.name || '';
    const team2 = match.opponents?.[1]?.opponent?.name || '';
    const matchTime = new Date(match.begin_at);
    const startTime = new Date(matchTime.getTime() - 5 * 60 * 1000).toISOString();
    const endTime = new Date(matchTime.getTime() + 5 * 60 * 1000).toISOString();
    const centralResult = await queryGridCentral({ gte: startTime, lte: endTime }, gridToken);
    if (!centralResult?.data?.allSeries?.edges) continue;
    const gridSeriesList = centralResult.data.allSeries.edges.map(e => e.node);
    const matchedSeries = findGridSeries(team1, team2, gridSeriesList);
    if (matchedSeries) {
      const liveResult = await queryGridLive(matchedSeries.id, gridToken);
      match.grid_state = liveResult?.data?.seriesState || null;
    }
  }
  return runningMatches;
}

async function rotateHistoryTeam(env) {
  let teams = [];
  try {
    teams = JSON.parse(await env.MATCH_DATA.get(KV_SWEDISH_TEAMS) || '[]');
  } catch (_) {}

  if (!teams.length && env.PANDASCORE_TOKEN) {
    const players = await tryPanda(
      () => fetchSwedishPlayers(env.PANDASCORE_TOKEN),
      []
    );
    if (players.length) {
      const teamSet = new Set(
        players.map(p => p.current_team?.id).filter(Boolean).map(String)
      );
      teams = Array.from(teamSet);
      await saveSwedishTeamMetadata(players, env);
    }
  }

  if (teams.length === 0) return null;
  let cursor = parseInt(await env.MATCH_DATA.get(KV_HISTORY_CURSOR) || '0');
  cursor = cursor % teams.length;
  const teamId = teams[cursor];
  const nextCursor = (cursor + 1) % teams.length;
  await env.MATCH_DATA.put(KV_HISTORY_CURSOR, String(nextCursor));
  return { teamId, cursor, nextCursor };
}

async function mergeHistoryData(existing, newMatches) {
  const existingMap = new Map(existing.map(m => [m.id, m]));
  for (const match of newMatches) {
    existingMap.set(match.id, match);
  }
  return Array.from(existingMap.values());
}

// ── PLAYER STATS HELPERS ──────────────────────────────────────────────────
function normPlayerName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

function extractPandaPlayerRows(game, meta) {
  const rows = [];
  const playerRows = Array.isArray(game) ? game : (game?.players || []);

  playerRows.forEach(gp => {
    const stats = gp.player_stats || gp;
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
      adr:        stats.adr ?? stats.damage_per_round ?? null,
      map:        meta.mapName,
      date:       meta.date,
      source:     'pandascore',
    });
  });
  return rows;
}

async function fetchPandaGameStats(meta, token) {
  const res = await fetch(
    `${PANDA_BASE}/csgo/matches/${meta.matchId}/players/stats`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
  );
  if (!res.ok) {
    console.error(`PandaScore match ${meta.matchId} player stats failed: ${res.status}`);
    return null;
  }
  return res.json();
}

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
          player_id:   playerId,
          player_name: p.name,
          team_id:     teamObj?.id ?? null,
          kills:       p.kills ?? 0,
          deaths:      p.deaths ?? 0,
          assists:     p.killAssistsGiven ?? 0,
          headshots:   null,
          adr:         null,
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
      const game = await fetchPandaGameStats(meta, env.PANDASCORE_TOKEN);
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
    // Only mark the game done when at least one provider returned rows.
    // Otherwise keep it in the queue so the next cron run can retry.
    if (rows.length) done.add(meta.gameId);
    else remaining.push(meta);
  }
  await env.MATCH_DATA.put(KV_PLAYER_STATS, JSON.stringify(existingStats));
  await env.MATCH_DATA.put(KV_STATS_DONE, JSON.stringify([...done]));
  await env.MATCH_DATA.put(KV_STATS_QUEUE, JSON.stringify(remaining));
  return { processed: batch.length, newRows: newRowCount, remaining: remaining.length };
}

// ─── SCHEDULED HANDLER (unchanged) ──────────────────────────────────────
async function handleScheduled(env) {
  try {
    console.log('Scheduled handler triggered');

    const oldLiveJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
    const oldLive = oldLiveJson ? JSON.parse(oldLiveJson) : null;

    // 1) Swedish player/team discovery:
    // PandaScore is preferred, but cached metadata survives Panda outages.
    let players = await tryPanda(
      () => fetchSwedishPlayers(env.PANDASCORE_TOKEN),
      []
    );

    let swedishTeamNames = [];
    if (players.length) {
      swedishTeamNames = [...new Set(
        players.map(p => p.current_team?.name).filter(Boolean)
      )];
      await saveSwedishTeamMetadata(players, env);
    } else {
      swedishTeamNames = await getCachedSwedishTeamNames(env);
      if (oldLive?.players?.length) players = oldLive.players;
    }

    // 2) Running/upcoming matches:
    // PandaScore first; GRID becomes the fallback for the same time windows.
    let runningMatches = await tryPanda(
      () => fetchRunningMatches(env.PANDASCORE_TOKEN),
      null
    );

    let upcomingMatches = await tryPanda(
      () => fetchUpcomingMatches(env.PANDASCORE_TOKEN),
      null
    );

    const now = new Date();
    const runningGte = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const runningLte = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const upcomingGte = now.toISOString();
    const upcomingLte = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    if (runningMatches === null && env.GRID_TOKEN && swedishTeamNames.length) {
      runningMatches = await fetchGridMatches(
        env.GRID_TOKEN, swedishTeamNames, runningGte, runningLte, true
      );
    }

    if (upcomingMatches === null && env.GRID_TOKEN && swedishTeamNames.length) {
      upcomingMatches = await fetchGridMatches(
        env.GRID_TOKEN, swedishTeamNames, upcomingGte, upcomingLte, false
      );
    }

    runningMatches = (runningMatches || []).filter(m =>
      m.opponents?.length === 2 &&
      (swedishTeamNames.length
        ? m.opponents.some(o => swedishTeamNames.some(n => normName(n) === normName(o.opponent?.name)))
        : true)
    );

    upcomingMatches = (upcomingMatches || []).filter(m =>
      m.opponents?.length === 2 &&
      (swedishTeamNames.length
        ? m.opponents.some(o => swedishTeamNames.some(n => normName(n) === normName(o.opponent?.name)))
        : true)
    );

    // Enrich Panda-sourced running matches with GRID live state when possible.
    if (env.GRID_TOKEN && runningMatches.length) {
      runningMatches = await attachGridStateToRunningMatches(
        runningMatches,
        [...new Set(
          players.map(p => p.current_team?.id).filter(Boolean)
        )],
        env.GRID_TOKEN
      );
    }

    const liveData = {
      timestamp: new Date().toISOString(),
      players,
      running_matches: runningMatches,
      upcoming_matches: upcomingMatches,
    };

    await env.MATCH_DATA.put(KV_LIVE_DATA, JSON.stringify(liveData));
    console.log(`Live data updated from ${runningMatches.length || 0} running + ${upcomingMatches.length || 0} upcoming matches`);

    // 3) History:
    // Prefer PandaScore one-team rotation. If unavailable, use GRID series
    // state over a recent window and merge the converted matches.
    let rotation = await rotateHistoryTeam(env);

    if (rotation) {
      const newMatches = await tryPanda(
        () => fetchSwedishTeamMatches(rotation.teamId, env.PANDASCORE_TOKEN),
        null
      );

      if (newMatches) {
        const existingHistoryJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
        const existingHistory = existingHistoryJson ? JSON.parse(existingHistoryJson) : [];
        const mergedHistory = await mergeHistoryData(existingHistory, newMatches);
        await env.MATCH_DATA.put(KV_HISTORY_DATA, JSON.stringify(mergedHistory));
      } else if (env.GRID_TOKEN && swedishTeamNames.length) {
        const historyGte = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const historyLte = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const gridHistory = await fetchGridMatches(
          env.GRID_TOKEN, swedishTeamNames, historyGte, historyLte, true
        );
        const existingHistoryJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
        const existingHistory = existingHistoryJson ? JSON.parse(existingHistoryJson) : [];
        const mergedHistory = await mergeHistoryData(existingHistory, gridHistory);
        await env.MATCH_DATA.put(KV_HISTORY_DATA, JSON.stringify(mergedHistory));
      }
    } else if (env.GRID_TOKEN && swedishTeamNames.length) {
      const historyGte = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const historyLte = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const gridHistory = await fetchGridMatches(
        env.GRID_TOKEN, swedishTeamNames, historyGte, historyLte, true
      );
      const existingHistoryJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
      const existingHistory = existingHistoryJson ? JSON.parse(existingHistoryJson) : [];
      const mergedHistory = await mergeHistoryData(existingHistory, gridHistory);
      await env.MATCH_DATA.put(KV_HISTORY_DATA, JSON.stringify(mergedHistory));
    }

    // 4) Player stats queue. GRID remains the secondary provider per game.
    try {
      const historyJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
      const historyForQueue = historyJson ? JSON.parse(historyJson) : [];
      const added = await enqueueFinishedGames(historyForQueue, env);
      if (added) console.log(`Queued ${added} newly finished games for stats`);
      const { processed, newRows, remaining } = await processStatsQueue(env);
      if (processed) {
        console.log(`Player stats: processed ${processed} games, ${newRows} new rows, ${remaining} left in queue`);
      }
    } catch (e) {
      console.error(`Player stats pipeline error: ${e.message}`);
    }

    console.log('Scheduled handler completed');
  } catch (err) {
    console.error(`Scheduled handler error: ${err.message}`);
  }
}

// ─── FETCH HANDLER (improved with fallback) ─────────────────────────────
async function handleFetch(request, env) {
  const origin = request.headers.get('Origin') || '';
  const url    = new URL(request.url);
  const path   = url.pathname;

  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders(origin) });

  // Session exchange
  if (request.method === 'POST' && path === '/session') {
    if (!ALLOWED_ORIGINS.includes(origin))
      return new Response('Unauthorized', { status: 401, headers: corsHeaders(origin) });

    let body;
    try { body = await request.json(); } catch(_) { body = {}; }
    const turnstileToken = body.token || '';
    if (!turnstileToken) {
      return new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    const remoteIp = request.headers.get('CF-Connecting-IP') || '';
    if (!env.TURNSTILE_SECRET) {
      return new Response(JSON.stringify({ error: 'TURNSTILE_SECRET is not set' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    const verifyData = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET, remoteIp);
    if (!verifyData.success) {
      return new Response(JSON.stringify({
        error: 'Turnstile verification failed',
        errorCodes: verifyData['error-codes'] || [],
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

  // POST /central or /live
  if (request.method === 'POST') {
    if (path === '/central' || path === '/live') {
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        return new Response(liveDataJson, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      }
      // Fallback: return 503 because we want the scheduled handler to populate this
      return new Response(JSON.stringify({ error: 'No live data cached' }), {
        status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    return new Response('Not found', { status: 404 });
  }

  // GET /csgo/*
  if (request.method === 'GET' && path.startsWith('/csgo/')) {
    const pageParam = parseInt(url.searchParams.get('page') || '1');
    const perPageParam = parseInt(url.searchParams.get('per_page') || '100');

    // /csgo/teams/{id} → fetch from PandaScore (cached in KV)
    if (path.startsWith('/csgo/teams/')) {
      const teamId = path.split('/')[3];
      try {
        const data = await fetchTeamRoster(teamId, env.PANDASCORE_TOKEN, env);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      } catch (err) {
        console.error(`Team roster fetch error: ${err.message}`);
        const cached = await env.MATCH_DATA.get(`team_roster_${teamId}`);
        if (cached) {
          return new Response(cached, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
          });
        }
        return new Response(JSON.stringify({ error: 'Could not fetch team roster and no cached roster exists' }), {
          status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    // /csgo/players → KV first, then live fallback
    if (path.includes('/players')) {
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        const liveData = JSON.parse(liveDataJson);
        const allPlayers = liveData.players || [];
        const startIdx = (pageParam - 1) * perPageParam;
        const endIdx = startIdx + perPageParam;
        const data = allPlayers.slice(startIdx, endIdx);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      }
      // Fallback: PandaScore, then stale cached players.
      try {
        const players = await fetchPandascoreWithPagination(
          `${PANDA_BASE}/csgo/players?filter[nationality]=SE&per_page=100`,
          env.PANDASCORE_TOKEN
        );
        return new Response(JSON.stringify(players), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      } catch (err) {
        // Last resort: stale KV copy from the last successful scheduler run.
        const cached = env.MATCH_DATA.get(KV_LIVE_DATA);
        const cachedJson = await cached;
        if (cachedJson) {
          const liveData = JSON.parse(cachedJson);
          return new Response(JSON.stringify(liveData.players || []), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
          });
        }
        return new Response(JSON.stringify({ error: 'Failed to fetch players from PandaScore and no cached data exists' }), {
          status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    // /csgo/matches/running
    if (path.includes('/matches/running')) {
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        const liveData = JSON.parse(liveDataJson);
        return new Response(JSON.stringify(liveData.running_matches || []), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      }
      try {
        const matches = await fetchPandascoreWithPagination(
          `${PANDA_BASE}/csgo/matches/running?per_page=50&include=opponents,results,games,pick_bans`,
          env.PANDASCORE_TOKEN, 1
        );
        return new Response(JSON.stringify(matches), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to fetch running matches' }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    // /csgo/matches/upcoming
    if (path.includes('/matches/upcoming')) {
      const liveDataJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
      if (liveDataJson) {
        const liveData = JSON.parse(liveDataJson);
        return new Response(JSON.stringify(liveData.upcoming_matches || []), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      }
      try {
        const matches = await fetchPandascoreWithPagination(
          `${PANDA_BASE}/csgo/matches/upcoming?per_page=30&sort=begin_at&include=opponents`,
          env.PANDASCORE_TOKEN, 1
        );
        return new Response(JSON.stringify(matches), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to fetch upcoming matches' }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    // /csgo/matches/past
    if (path.includes('/matches/past')) {
      const historyJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
      if (historyJson) {
        const allHistory = JSON.parse(historyJson);
        const startIdx = (pageParam - 1) * perPageParam;
        const endIdx = startIdx + perPageParam;
        const data = allHistory.slice(startIdx, endIdx);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      }
      // Fallback: empty array
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // /csgo/player-stats
    if (path.includes('/player-stats')) {
      const statsJson = await env.MATCH_DATA.get(KV_PLAYER_STATS);
      if (statsJson) {
        const allStats = JSON.parse(statsJson);
        const startIdx = (pageParam - 1) * perPageParam;
        const endIdx = startIdx + perPageParam;
        const data = allStats.slice(startIdx, endIdx);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      }
      // Fallback: empty array
      return new Response(JSON.stringify([]), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  return new Response('Method not allowed', { status: 405 });
}

// ─── EXPORT ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    return handleFetch(request, env);
  },
  async scheduled(event, env) {
    await handleScheduled(env);
  },
};