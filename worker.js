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

import { normalizeHLTVRanking } from './hltv-normalizer.js';

// ── HLTV INTEGRATION ────────────────────────────────────────────────────
// serviceUrl/sharedSecret are read from `env` on every call rather than
// once at module scope — Workers module syntax only hands `env` to the
// exported fetch/scheduled handlers, so a top-level `env.HLTV_SERVICE_URL`
// reference would throw ReferenceError before the Worker ever served a
// request.
async function fetchHLTV(path, env, timeoutMs = 5000) {
  const serviceUrl = env.HLTV_SERVICE_URL || 'http://localhost:3000';
  const sharedSecret = env.HLTV_SHARED_SECRET || 'dev-secret';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${serviceUrl}${path}`, {
      signal: controller.signal,
      headers: { 'X-HLTV-Secret': sharedSecret },
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    console.warn(`[HLTV] Fetch failed: ${path}`, e.message);
    return null;
  }
}

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
const KV_GRID_CS2_TITLE_ID = 'grid_cs2_title_id';
const KV_STATS_MIGRATION = 'player_stats_migration_version';
const KV_NEWS_DATA       = 'fragbite_news';
// Discovered (not guessed) GRID <-> PandaScore identity mappings — see the
// "GRID PROVIDER / TEAM ID DISCOVERY" section below for how these get
// populated. Both are single blobs (one KV key each, holding every team)
// rather than one key per team, to keep this at effectively zero ongoing
// write cost once populated.
const KV_GRID_PANDASCORE_PROVIDER = 'grid_pandascore_provider_name';
const KV_GRID_TEAM_ID_MAP = 'grid_team_id_map'; // { [pandaTeamId]: gridTeamId }
const KV_SEASON_TOTALS   = 'grid_season_totals'; // { [playerKey]: {...} } — GRID series-aggregated totals
// Each non-GRID-native game in a batch costs up to 2 fetch() subrequests
// (1 PandaScore + 1 GRID series-state), not 3 — the GRID central
// series-discovery query used to be a 3rd per-game fetch, but it's now
// shared across the whole batch via makeGridSeriesCache (at most one
// fetch per distinct day in the batch, occasionally two if a day's tight
// window comes up empty and needs a wider retry). Cloudflare's free tier
// caps a single invocation at 50 subrequests total, and player-stats runs
// on its own tick (see STATS_TICK_OFFSET below), so 15 games × up to 2
// fetches + a handful of shared central-query fetches fits with headroom
// to spare.
const STATS_BATCH_SIZE   = 15;

// ── KV WRITE SAFETY / BUDGET ─────────────────────────────────────────────
// Cloudflare's free KV tier hard-caps writes at 1,000/day per namespace,
// resetting 00:00 UTC. Two defenses, used everywhere a scheduled tick
// writes to KV:
//  1. safePut() — every .put() goes through this. A quota rejection (or any
//     other KV error) is logged and swallowed instead of throwing, so it
//     can't abort the rest of the tick (previously an uncaught rejection
//     here jumped straight to handleScheduled's outer catch, skipping
//     everything after it in the same run — including player stats).
//  2. putIfChanged() — skips the write entirely when the serialized value
//     is byte-identical to what's already stored. Costs a read, but the
//     free tier's read budget (100k/day) is generous by comparison.
async function safePut(env, key, value, opts) {
  try {
    await env.MATCH_DATA.put(key, value, opts);
    return true;
  } catch (err) {
    console.error(`[KV] put(${key}) failed: ${err.message}`);
    return false;
  }
}

async function putIfChanged(env, key, valueObj, opts) {
  const serialized = JSON.stringify(valueObj);
  try {
    const existing = await env.MATCH_DATA.get(key);
    if (existing === serialized) return false;
  } catch (_) { /* fall through and attempt the write anyway */ }
  return safePut(env, key, serialized, opts);
}

// Background tasks (team metadata, history rotation, player-stats queue)
// don't need to run every tick — only the live scoreboard does. Gating them
// to a fraction of ticks keeps total daily writes under the 1,000 cap even
// during a full slate of live matches. With the cron at */3 (480 ticks/day),
// running heavy tasks 1 tick in 8 (~every 24 min) budgets worst-case to:
//   live:     480 ticks × 1 write (only-if-changed)        =  480/day
//   team:      60 ticks × 2 writes (only-if-changed)       =  120/day
//   history:   60 ticks × up to 2 writes                   =  120/day
//   stats:     60 ticks × 3 writes                         =  180/day
//                                                    total  ≈  900/day
// ~100 writes of headroom under the cap, and putIfChanged trims the live
// number further in practice (no write when nothing actually changed).
//
// Team-metadata/history and player-stats used to share the same "heavy"
// tick. They're now split onto two different tick offsets (see
// isMetadataTick / isStatsTick, near handleScheduled) so their fetch()
// subrequests don't stack up in the same invocation — see the comment
// above handleScheduled for why that matters.
const HEAVY_TASK_EVERY_N_TICKS = 8;
const CRON_INTERVAL_MINUTES = 3; // must match the cron trigger (*/3 * * * *)

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
// Returns an array of results, OR `null` if the very first page could not
// be fetched at all (network error, 429, 5xx, etc.). This distinction is
// load-bearing: every caller in this file that has a GRID fallback checks
// `=== null` to decide whether to use it. Previously this always returned
// an array (possibly empty) no matter how the request failed, so a 429 on
// page 1 looked identical to "PandaScore says there are 0 results" and
// every GRID fallback that depended on `=== null` silently never fired.
// A failure on page 2+ (after page 1 already returned real data) still
// returns the partial results as an array — that's a genuine partial
// dataset, not a total failure, and is better than discarding it.
async function fetchPandascoreWithPagination(url, token, maxPages = 999) {
  const results = [];
  let page = 1;
  let hasMore = true;
  let failedFirstPage = false;
  while (hasMore && page <= maxPages) {
    const paginatedUrl = `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
    try {
      const res = await fetch(paginatedUrl, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      if (!res.ok) {
        console.error(`PandaScore request failed: ${res.status} (page ${page})`);
        if (page === 1) failedFirstPage = true;
        hasMore = false;
        break;
      }
      const data = await res.json();
      results.push(...(data || []));
      hasMore = data && data.length > 0;
      page++;
    } catch (err) {
      console.error(`PandaScore fetch error: ${err.message} (page ${page})`);
      if (page === 1) failedFirstPage = true;
      hasMore = false;
    }
  }
  if (failedFirstPage && results.length === 0) return null;
  return results;
}

// ── SINGLE TEAM ROSTER (with KV cache + durable stale fallback + GRID) ──
// `team_roster_{id}`       → fresh copy, expires after TEAM_ROSTER_CACHE_TTL_S
// `team_roster_stale_{id}` → same payload, never expires, only overwritten
//                            on a new successful fetch. Used as a fallback
//                            when PandaScore is down and the fresh key has
//                            already expired.
// If neither cache has anything, falls back to a GRID-derived roster
// (see fetchGridTeamRosterByName) before finally giving up. GRID has no
// PandaScore-compatible team ID, so it needs to search by name. The caller
// can pass a `nameHint` (the client already has current_team.name on hand);
// if omitted, resolveTeamNameFromId() is tried as a last resort, but that
// depends on KV_LIVE_DATA already containing this team, which will not be
// true during a PandaScore outage that also blocked the scheduled job.
const TEAM_ROSTER_CACHE_TTL_S = 24 * 60 * 60;
const GRID_ROSTER_CACHE_TTL_S = 6 * 60 * 60; // shorter TTL: less authoritative than Panda

async function tryGridRosterFallback(teamId, env, nameHint = null) {
  if (!env.GRID_TOKEN) return null;

  const titleId = await resolveGridCs2TitleId(env.GRID_TOKEN, env);

  // 1) Cheapest and most reliable path: a mapping already *confirmed* via
  // GRID's own externalLinks field on a previous run (see
  // maybeCachePandaGridTeamMapping). No guessing, no fuzzy name matching —
  // just a direct ID lookup. This is what most calls should hit once the
  // map has warmed up for a team.
  if (titleId) {
    const teamIdMap = await getGridTeamIdMap(env);
    const mappedGridId = teamIdMap[String(teamId)];
    if (mappedGridId) {
      const roster = await fetchGridTeamRosterById(mappedGridId, titleId, env.GRID_TOKEN);
      if (roster && roster.players.length) {
        console.log(`[GRID] Roster fallback served for team ${teamId} via confirmed map -> ${mappedGridId}: ${roster.players.length} players`);
        await safePut(env, `team_roster_${teamId}`, JSON.stringify(roster), { expirationTtl: GRID_ROSTER_CACHE_TTL_S });
        await safePut(env, `team_roster_stale_${teamId}`, JSON.stringify(roster));
        return roster;
      }
    }
  }

  // 2) GRID's own externalId resolution — only attempted once we've
  // confirmed (via dataProviders(), not a guess) that PandaScore is
  // actually registered as a linked data provider on this account, and
  // under what exact name. A null result here (provider not linked, or a
  // linked provider that doesn't cover this team) just falls through to
  // the name-based path below rather than being treated as fatal.
  if (titleId) {
    const providerName = await resolvePandascoreProviderName(env.GRID_TOKEN, env);
    if (providerName) {
      const gridTeamId = await resolveGridTeamIdFromExternalId(teamId, titleId, env.GRID_TOKEN, providerName);
      if (gridTeamId) {
        const roster = await fetchGridTeamRosterById(gridTeamId, titleId, env.GRID_TOKEN);
        if (roster && roster.players.length) {
          console.log(`[GRID] Roster fallback served for team ${teamId} via externalId(${providerName})->${gridTeamId}: ${roster.players.length} players`);
          await safePut(env, `team_roster_${teamId}`, JSON.stringify(roster), { expirationTtl: GRID_ROSTER_CACHE_TTL_S });
          await safePut(env, `team_roster_stale_${teamId}`, JSON.stringify(roster));
          // Confirmed by GRID itself — worth caching in the same map so
          // future calls skip straight to step 1.
          const teamIdMap = await getGridTeamIdMap(env);
          if (teamIdMap[String(teamId)] !== gridTeamId) {
            teamIdMap[String(teamId)] = gridTeamId;
            await putIfChanged(env, KV_GRID_TEAM_ID_MAP, teamIdMap);
          }
          return roster;
        }
      }
    }
  }

  // 3) Name-based fallback (last resort). This also opportunistically
  // discovers and caches the ID mapping for this team via externalLinks
  // (see fetchGridTeamRosterByName), so a team that can only be found this
  // way today may not need to be next time.
  const teamName = nameHint || await resolveTeamNameFromId(teamId, env);
  if (!teamName) {
    console.warn(`[GRID] No team name available for team ${teamId} (no hint, none cached), cannot query GRID by name`);
    return null;
  }
  const roster = await fetchGridTeamRosterByName(teamName, env.GRID_TOKEN, env, teamId);
  if (!roster) {
    console.warn(`[GRID] No roster found for "${teamName}" (team ${teamId}) in the last ${GRID_ROSTER_LOOKBACK_DAYS} days`);
    return null;
  }
  console.log(`[GRID] Roster fallback served for "${teamName}" (team ${teamId}): ${roster.players.length} players`);
  await safePut(env, `team_roster_${teamId}`, JSON.stringify(roster), { expirationTtl: GRID_ROSTER_CACHE_TTL_S });
  await safePut(env, `team_roster_stale_${teamId}`, JSON.stringify(roster));
  return roster;
}

async function fetchTeamRoster(teamId, token, env, nameHint = null) {
  const kvKey = `team_roster_${teamId}`;
  const staleKey = `team_roster_stale_${teamId}`;

  const cached = await env.MATCH_DATA.get(kvKey);
  if (cached) return JSON.parse(cached);

  let res, body;
  try {
    // NOTE: PandaScore's generic "get a team" endpoint lives at /teams/{id},
    // NOT /csgo/teams/{id}. The /csgo/ prefix only exists for CS2-specific
    // endpoints (matches, players, games, stats) — plain team lookups are
    // sport-agnostic and were 404'ing ("Route not found") on every single
    // call because of this. See https://developers.pandascore.co/reference/get_teams_teamidorslug
    res = await fetch(`${PANDA_BASE}/teams/${teamId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    body = await res.text();
  } catch (err) {
    console.error(`[PANDA] GET /teams/${teamId} network error: ${err.message}`);
    const stale = await env.MATCH_DATA.get(staleKey);
    if (stale) return JSON.parse(stale);
    const grid = await tryGridRosterFallback(teamId, env, nameHint);
    if (grid) return grid;
    throw new Error(`PandaScore team ${teamId} unreachable and no stale copy exists`);
  }

  console.log(`[PANDA] GET /teams/${teamId} -> HTTP ${res.status}`);

  if (!res.ok) {
    console.error(`[PANDA] Response: ${body.slice(0, 500)}`);
    const stale = await env.MATCH_DATA.get(staleKey);
    if (stale) {
      console.log(`[PANDA] Serving stale roster for team ${teamId} (HTTP ${res.status} from PandaScore)`);
      return JSON.parse(stale);
    }
    const grid = await tryGridRosterFallback(teamId, env, nameHint);
    if (grid) return grid;
    throw new Error(`PandaScore team ${teamId} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    const stale = await env.MATCH_DATA.get(staleKey);
    if (stale) return JSON.parse(stale);
    const grid = await tryGridRosterFallback(teamId, env, nameHint);
    if (grid) return grid;
    throw new Error(`PandaScore team ${teamId} returned invalid JSON`);
  }

  await safePut(env, kvKey, JSON.stringify(data), { expirationTtl: TEAM_ROSTER_CACHE_TTL_S });
  await safePut(env, staleKey, JSON.stringify(data));
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

// NOTE: `players` here resolves to the `GamePlayerState` interface, not the
// concrete `GamePlayerStateCs2` type directly — kills/deaths/killAssistsGiven
// live on the interface so they're selectable bare, but headshots and
// damageDealt only exist on GamePlayerStateCs2 and MUST be behind an inline
// fragment. Selecting them bare (as a prior version of this query did) is a
// validation error ("Field 'X' in type 'GamePlayerState' is undefined"),
// which GRID rejects for the whole query, not just those two fields —
// seriesState comes back null and every game in the batch silently produces
// zero rows, which is exactly what "teams { score }" is also needed to
// derive ADR from since GRID has no direct per-round-damage field.
// Extended to also pull weaponKills/multikills/firstKill on the per-game
// players (GamePlayerStateCs2 — zero extra GRID calls, same query, we were
// already paying for this request) and a top-level `teams` selection giving
// GRID's own series-aggregated totals per player (SeriesTeamStateCs2 /
// SeriesPlayerStateCs2) for a season-totals rollup — see updateSeasonTotals().
const QUERY_SERIES_STATE_PLAYERS = `
  query SeriesStatePlayers($id: ID!) {
    seriesState(id: $id) {
      id
      teams {
        ... on SeriesTeamStateCs2 {
          name
          players {
            ... on SeriesPlayerStateCs2 {
              name
              kills
              deaths
              headshots
              multikills { numberOfKills count }
            }
          }
        }
      }
      games {
        sequenceNumber
        finished
        map { name }
        teams {
          name
          score
          players {
            name
            kills
            deaths
            killAssistsGiven
            ... on GamePlayerStateCs2 {
              headshots
              damageDealt
              firstKill
              weaponKills { weaponName count }
              multikills { numberOfKills count }
            }
          }
        }
      }
    }
  }
`;

// GRID's `players` query supports filtering directly by nationality (ISO
// 3166-1 Alpha-3 code) and by title. Unlike the series-scanning roster
// fallback above, this doesn't need a team name or a recent series to
// exist — it can discover "every Swedish CS2 player GRID knows about" the
// same way PandaScore's filter[nationality]=SE does. See
// fetchGridSwedishPlayers() / resolveGridCs2TitleId().
const QUERY_TITLES = `
  query Titles {
    titles {
      id
      name
      nameShortened
    }
  }
`;

const QUERY_PLAYERS_BY_NATIONALITY = `
  query PlayersByNationality($nationalityCode: String!, $titleId: ID!, $after: String) {
    players(
      filter: { nationality: { code: { equals: $nationalityCode } }, titleId: $titleId }
      first: 50
      after: $after
    ) {
      edges {
        node {
          id
          nickname
          fullName
          imageUrl
          nationality { code name }
          roles { name }
          team { id name logoUrl }
        }
      }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
`;

// Direct roster-by-GRID-team-ID lookup. Far more reliable than scanning
// recent series for player names (fetchGridTeamRosterByName below) because
// it reads GRID's own current roster assignment instead of reconstructing
// one from whoever happened to play in the last few series. Requires a
// resolved GRID team ID (see resolveGridTeamIdFromExternalId).
const QUERY_PLAYERS_BY_TEAM = `
  query PlayersByTeam($teamId: ID!, $titleId: ID!, $after: String) {
    players(
      filter: { teamIdFilter: { id: { equals: $teamId } }, titleId: $titleId }
      first: 50
      after: $after
    ) {
      edges {
        node {
          id
          nickname
          fullName
          nationality { code name }
          roles { name }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Resolves GRID's own team ID from another data provider's team ID (e.g.
// PandaScore's numeric team ID), via GRID's externalId mapping. Requires
// knowing the exact provider name string GRID uses internally — see
// resolvePandascoreProviderName() below, which discovers this instead of
// guessing it.
const QUERY_TEAM_ID_BY_EXTERNAL_ID = `
  query TeamIdByExternal($dataProviderName: String!, $externalTeamId: ID!, $titleId: ID!) {
    teamIdByExternalId(
      dataProviderName: $dataProviderName
      externalTeamId: $externalTeamId
      titleId: $titleId
    )
  }
`;

async function resolveGridTeamIdFromExternalId(pandaTeamId, titleId, gridToken, providerName) {
  try {
    const result = await queryGridCentral(
      { dataProviderName: providerName, externalTeamId: String(pandaTeamId), titleId },
      gridToken,
      QUERY_TEAM_ID_BY_EXTERNAL_ID
    );
    return result?.data?.teamIdByExternalId || null;
  } catch (err) {
    console.warn(`[GRID] teamIdByExternalId lookup failed for PandaScore team ${pandaTeamId}: ${err.message}`);
    return null;
  }
}

// ── GRID PROVIDER / TEAM ID DISCOVERY (replaces the old hardcoded guess) ──
// dataProviders() is a documented Central Data query that lists every data
// provider GRID actually recognizes by name. Resolving it once (cached
// indefinitely, same TTL as the CS2 title ID) tells us definitively whether
// PandaScore is linked at all on this account and under what exact string —
// instead of hardcoding "PANDASCORE" and silently falling through to the
// name-based fallback on every single miss.
const QUERY_DATA_PROVIDERS = `
  query DataProviders {
    dataProviders { name description }
  }
`;

async function resolvePandascoreProviderName(token, env) {
  const cached = await env.MATCH_DATA.get(KV_GRID_PANDASCORE_PROVIDER);
  if (cached) return cached === '__none__' ? null : cached;

  const result = await queryGridCentral({}, token, QUERY_DATA_PROVIDERS);
  const providers = result?.data?.dataProviders || [];
  const match = providers.find(p => /pandascore/i.test(p.name || ''));

  // Cache the negative result too, or a genuine "not linked" answer gets
  // re-queried on every single roster-fallback call.
  await safePut(env, KV_GRID_PANDASCORE_PROVIDER, match ? match.name : '__none__',
    { expirationTtl: GRID_TITLE_ID_CACHE_TTL_S });

  if (!match) {
    console.warn(`[GRID] No PandaScore-named data provider found. Available providers: ${providers.map(p => p.name).join(', ') || '(none returned)'}`);
  } else {
    console.log(`[GRID] Confirmed PandaScore data provider name: "${match.name}"`);
  }
  return match?.name || null;
}

// A team's externalLinks field is the ground truth for "is this GRID team
// actually linked to PandaScore, and under what ID" — more reliable than
// teamIdByExternalId, which requires already knowing the provider name AND
// depends on that specific team having been linked. Used opportunistically
// whenever we've already found a GRID team by name match, to upgrade that
// one-off match into a permanent, guess-free mapping for next time.
const QUERY_TEAM_EXTERNAL_LINKS = `
  query TeamExternalLinks($id: ID!) {
    team(id: $id) {
      id
      externalLinks { dataProvider { name } externalEntity { id } }
    }
  }
`;

async function getGridTeamIdMap(env) {
  try {
    return JSON.parse(await env.MATCH_DATA.get(KV_GRID_TEAM_ID_MAP) || '{}');
  } catch (_) {
    return {};
  }
}

// Confirms (via GRID's own externalLinks data, not a guess) that a
// name-matched GRID team really does correspond to a given PandaScore team
// ID, and if so, caches that mapping permanently in one shared KV blob.
// Every subsequent roster-fallback call for this team then skips both the
// externalId guess AND the fuzzy name-matching path entirely.
async function maybeCachePandaGridTeamMapping(pandaTeamId, gridTeamId, gridToken, env) {
  try {
    const teamIdMap = await getGridTeamIdMap(env);
    if (teamIdMap[String(pandaTeamId)] === gridTeamId) return; // already confirmed

    const result = await queryGridCentral({ id: gridTeamId }, gridToken, QUERY_TEAM_EXTERNAL_LINKS);
    const links = result?.data?.team?.externalLinks || [];
    const pandaLink = links.find(l => /pandascore/i.test(l.dataProvider?.name || ''));

    if (pandaLink && String(pandaLink.externalEntity?.id) === String(pandaTeamId)) {
      teamIdMap[String(pandaTeamId)] = gridTeamId;
      await putIfChanged(env, KV_GRID_TEAM_ID_MAP, teamIdMap);
      console.log(`[GRID] Confirmed & cached team mapping via externalLinks: Panda ${pandaTeamId} -> GRID ${gridTeamId}`);
    } else {
      console.log(`[GRID] Team ${gridTeamId} has no confirmed PandaScore externalLink matching ${pandaTeamId} (providers seen: ${links.map(l => l.dataProvider?.name).join(', ') || 'none'})`);
    }
  } catch (err) {
    console.warn(`[GRID] externalLinks check failed for team ${gridTeamId}: ${err.message}`);
  }
}

async function fetchGridTeamRosterById(gridTeamId, titleId, gridToken) {
  const players = [];
  let after = null;
  let hasNextPage = true;
  let pages = 0;
  const MAX_PAGES = 4; // 50/page — a roster is never more than a handful of players

  while (hasNextPage && pages < MAX_PAGES) {
    const result = await queryGridCentral(
      { teamId: gridTeamId, titleId, after },
      gridToken,
      QUERY_PLAYERS_BY_TEAM
    );
    const conn = result?.data?.players;
    if (!conn) {
      console.error(`[GRID] players(teamIdFilter=${gridTeamId}) query failed on page ${pages + 1}`);
      break;
    }
    for (const edge of (conn.edges || [])) {
      const n = edge.node;
      players.push({ id: n.id, name: n.nickname || n.fullName || '?', nationality: n.nationality?.code || null, source: 'grid' });
    }
    hasNextPage = !!conn.pageInfo?.hasNextPage;
    after = conn.pageInfo?.endCursor || null;
    pages++;
  }

  return players.length ? { players, source: 'grid', fetched_at: new Date().toISOString() } : null;
}

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

async function queryGridCentral(variables, token, query = QUERY_CS2_SERIES) {
  try {
    const res = await fetch(GRID_CENTRAL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      console.error(`GRID central query failed: ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.errors?.length) {
      console.error(`GRID central query errors: ${json.errors.map(e => e.message).join(', ')}`);
    }
    return json;
  } catch (err) {
    console.error(`GRID central fetch error: ${err.message}`);
    return null;
  }
}

// ── GRID NATIONALITY-BASED PLAYER DISCOVERY ────────────────────────────────
// Resolves and caches (long TTL — this practically never changes) the GRID
// title ID for CS2, so QUERY_PLAYERS_BY_NATIONALITY can filter to CS2 only
// instead of returning a Swedish Dota/Valorant/LoL player by mistake.
const GRID_TITLE_ID_CACHE_TTL_S = 30 * 24 * 60 * 60;

async function resolveGridCs2TitleId(token, env) {
  const cached = await env.MATCH_DATA.get(KV_GRID_CS2_TITLE_ID);
  if (cached) return cached;

  const result = await queryGridCentral({}, token, QUERY_TITLES);
  const titles = result?.data?.titles || [];
  const cs2 = titles.find(t =>
    /counter-?strike\s*2|^cs2$/i.test(t.name || '') || /^cs2$/i.test(t.nameShortened || '')
  );
  if (!cs2) {
    console.error(`[GRID] Could not find a CS2 title in GRID's titles list (${titles.length} titles returned)`);
    return null;
  }
  await safePut(env, KV_GRID_CS2_TITLE_ID, cs2.id, { expirationTtl: GRID_TITLE_ID_CACHE_TTL_S });
  return cs2.id;
}

// GRID's nationality codes are ISO 3166-1 Alpha-3 ("SWE"), while
// PandaScore's is ISO 3166-1 Alpha-2 ("SE") — this is the one static
// mapping needed since we only ever query for Sweden here.
const NATIONALITY_ALPHA2_TO_ALPHA3 = { SE: 'SWE' };

// Direct 1:1-ish replacement for fetchSwedishPlayers() when PandaScore is
// unavailable. Returns players shaped close enough to PandaScore's format
// that the rest of the app (shared.js / players.html) doesn't need to know
// the difference: current_team.{id,name,image_url}, name, role, image_url.
// GRID ids are prefixed 'grid-' (same convention already used for
// GRID-derived match/opponent ids elsewhere in this file) so they can never
// collide with a real PandaScore numeric id.
async function fetchGridSwedishPlayers(nationalityAlpha2, token, env) {
  const nationalityCode = NATIONALITY_ALPHA2_TO_ALPHA3[nationalityAlpha2];
  if (!nationalityCode) {
    console.warn(`[GRID] No alpha-3 mapping for nationality "${nationalityAlpha2}", cannot query GRID players by nationality`);
    return null;
  }
  const titleId = await resolveGridCs2TitleId(token, env);
  if (!titleId) return null;

  const players = [];
  let after = null;
  let hasNextPage = true;
  let pages = 0;
  const MAX_PAGES = 20; // 50/page → up to 1000 players, generous headroom

  while (hasNextPage && pages < MAX_PAGES) {
    const result = await queryGridCentral(
      { nationalityCode, titleId, after },
      token,
      QUERY_PLAYERS_BY_NATIONALITY
    );
    const conn = result?.data?.players;
    if (!conn) {
      console.error(`[GRID] players(nationality=${nationalityCode}) query failed on page ${pages + 1}`);
      return players.length ? players : null;
    }
    for (const edge of (conn.edges || [])) {
      const n = edge.node;
      players.push({
        id: `grid-p-${n.id}`,
        name: n.nickname || n.fullName || '?',
        role: n.roles?.[0]?.name || null,
        image_url: n.imageUrl || null,
        nationality: nationalityAlpha2,
        current_team: n.team ? {
          id: `grid-${n.team.id}`,
          name: n.team.name,
          image_url: n.team.logoUrl || null,
        } : null,
        source: 'grid',
      });
    }
    hasNextPage = !!conn.pageInfo?.hasNextPage;
    after = conn.pageInfo?.endCursor || null;
    pages++;
  }

  console.log(`[GRID] Nationality fallback served ${players.length} "${nationalityCode}" players across ${pages} page(s)`);
  return players;
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

// Same request shape fetchGridPlayerRows already uses successfully for
// per-game stats. Reused here to build a team roster from player names
// that showed up in recent series, since GRID has no documented direct
// "roster by team ID" query and does not share PandaScore's team IDs.
async function queryGridSeriesPlayers(seriesId, token) {
  try {
    const res = await fetch(GRID_LIVE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ query: QUERY_SERIES_STATE_PLAYERS, variables: { id: seriesId } }),
    });
    if (!res.ok) {
      console.error(`GRID series players query failed: ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.errors?.length) {
      console.error(`GRID series players query errors: ${json.errors.map(e => e.message).join(', ')}`);
    }
    return json?.data?.seriesState || null;
  } catch (err) {
    console.error(`GRID series players fetch error: ${err.message}`);
    return null;
  }
}

async function fetchSwedishPlayers(token) {
  const url = `${PANDA_BASE}/csgo/players?filter[nationality]=SE&per_page=100`;
  return fetchPandascoreWithPagination(url, token);
}

// ── PANDASCORE INCIDENTS (roster/score-correction change feed) ────────────
// Team rosters currently only refresh when TEAM_ROSTER_CACHE_TTL_S expires
// (24h) or when a new player list happens to surface a changed current_team
// on a metadata tick (every ~24 min at best). A trade or roster swap in
// between is invisible until one of those triggers fires. PandaScore's
// Incidents API is a documented changelog of exactly this kind of change,
// available on all plans, and at 20-60 calls/hour against a 1000/hour cap
// there's no reason not to poll it here — it costs one extra call per
// metadata tick and zero extra KV writes (it only ever deletes a roster
// cache key early; it never writes new data itself).
//
// NOTE: verify the exact filter/param names below against PandaScore's
// current Incidents API reference for your account/plan — this is built
// from their documented shape (type/created_after/sort), not a response
// confirmed against a live token.
async function fetchRecentPandaIncidents(token, sinceIso) {
  const url = `${PANDA_BASE}/csgo/incidents?filter[created_after]=${encodeURIComponent(sinceIso)}&sort=-created_at&per_page=100`;
  return fetchPandascoreWithPagination(url, token, 1);
}

// Cloudflare KV deletes are counted against their own 1,000/day quota on
// the free tier, separate from the 1,000 writes/day budget the rest of this
// file is careful about — roster changes are rare enough that this is not
// worth gating further.
async function invalidateRostersForIncidents(incidents, env) {
  const rosterIncidents = (incidents || []).filter(i =>
    i.type === 'roster' || i.resource_type === 'team' || i.resource_type === 'roster'
  );
  let invalidated = 0;
  for (const inc of rosterIncidents) {
    const teamId = inc.team_id ?? inc.resource_id ?? inc.object_id;
    if (!teamId) continue;
    try {
      await env.MATCH_DATA.delete(`team_roster_${teamId}`);
      invalidated++;
    } catch (err) {
      console.warn(`[INCIDENTS] Failed to invalidate roster cache for team ${teamId}: ${err.message}`);
    }
  }
  if (invalidated) {
    console.log(`[INCIDENTS] Invalidated ${invalidated} team roster cache(s) from ${rosterIncidents.length} roster-related incident(s)`);
  }
  return invalidated;
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
    putIfChanged(env, KV_SWEDISH_TEAMS, [...ids]),
    putIfChanged(env, KV_SWEDISH_TEAM_NAMES, [...names]),
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

  // GRID's per-game team objects (QUERY_SERIES_STATE's games[].teams) only
  // carry `name` and `score`, never an id — so per-game team ids have to be
  // resolved back to the series-level opponent by normalized name match,
  // the same strategy findGridSeries already uses. The previous version
  // read `t.id` directly, which GRID never returns, so every game-level
  // team ended up with `id: undefined`.
  function resolveOpponentByName(name) {
    return teams.find(t => normName(t.opponent.name) === normName(name)) || null;
  }

  const games = (state?.games || []).map(g => {
    const gTeams = (g.teams || []).map(t => {
      const matched = resolveOpponentByName(t.name);
      return {
        id: matched?.opponent?.id ?? null,
        team: { id: matched?.opponent?.id ?? null, name: t.name },
        score: t.score ?? 0,
      };
    });
    // GRID has no per-game winner field, only each team's map score — so
    // the winner has to be derived by comparing the two scores directly.
    // Without this, extractMapScore()'s fallback in shared.js (which reads
    // `game.winner.id`) always failed silently and every GRID match showed
    // a 0-0 map score.
    let winner = null;
    if (g.finished && gTeams.length === 2) {
      if (gTeams[0].score > gTeams[1].score) winner = gTeams[0].team;
      else if (gTeams[1].score > gTeams[0].score) winner = gTeams[1].team;
    }
    return {
      id: `grid-${series.id}-g${g.sequenceNumber}`,
      sequence_number: g.sequenceNumber,
      status: g.finished ? 'finished' : g.started ? 'running' : 'not_started',
      finished: !!g.finished,
      map: g.map ? { name: g.map.name } : null,
      teams: gTeams,
      winner,
    };
  });

  // Maps won per opponent, counted straight off each game's derived winner
  // above. This is what PandaScore's `results[].score` means (maps won,
  // not rounds) — GRID's series-level `teams` field only carries
  // `name`/`won`, never a score, so the old code was reading `st.score`,
  // a field that plain does not exist on GRID's response, and always got
  // `undefined ?? 0`. Every GRID-sourced match showed 0-0 as a result.
  const mapsWonByOpponentId = {};
  games.forEach(g => {
    if (g.winner?.id) mapsWonByOpponentId[g.winner.id] = (mapsWonByOpponentId[g.winner.id] || 0) + 1;
  });

  const results = teams.map(t => ({
    team_id: t.opponent.id,
    score: mapsWonByOpponentId[t.opponent.id] || 0,
  }));

  // Series winner: GRID's `teams { name won }` gives this directly and
  // handles BO1s/walkovers correctly, so it's used as-is rather than
  // re-derived from map counts. This was hardcoded to `null` before, which
  // is why GRID-sourced matches never got a win/loss badge and never
  // counted toward the SWE win/loss stats on the history page.
  let winner = null;
  if (state?.teams?.length) {
    const winningStateTeam = state.teams.find(st => st.won);
    if (winningStateTeam) {
      const matched = resolveOpponentByName(winningStateTeam.name);
      if (matched) winner = { id: matched.opponent.id };
    }
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
    winner,
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
  const url = `${PANDA_BASE}/csgo/matches/past?filter[opponent_id]=${teamId}&per_page=100&include=opponents,results,games,winner&sort=-end_at`;
  return fetchPandascoreWithPagination(url, token);
}

function isSwedishTeam(match, swedishTeamIds) {
  if (!match.opponents || match.opponents.length < 2) return false;
  const team1Id = match.opponents[0]?.opponent?.id;
  const team2Id = match.opponents[1]?.opponent?.id;
  return swedishTeamIds.includes(team1Id) || swedishTeamIds.includes(team2Id);
}

// ── GRID TEAM ROSTER FALLBACK (name-based) ────────────────────────────────
// GRID doesn't share PandaScore's numeric team IDs, and its Central Data
// schema has no documented "roster by team ID" query in what's available
// to us, so a team ID alone can't be resolved on the GRID side directly.
// What DOES work, because fetchGridPlayerRows already proves it in
// production, is querying player names out of recent series states for a
// team NAME match. This builds a roster the same way: pull the team's
// recent series from Central Data, pull player names per game from
// Series State, and de-duplicate by name.
//
// This is now the SECOND choice, tried only after
// resolveGridTeamIdFromExternalId()/fetchGridTeamRosterById() (exact ID
// match via GRID's externalId mapping) comes up empty — see
// tryGridRosterFallback(). Kept as-is for when that mapping isn't
// available.
//
// Caveat: GRID's series-state player data has no nationality field, so a
// GRID-sourced roster will always classify as 'international' in
// classifyTeamCountry(). That badge only works correctly against a
// PandaScore-sourced roster. Everything else that reads team_roster_{id}
// (player names for stat matching, headshot counts, etc.) works fine
// against a GRID-sourced roster.
const GRID_ROSTER_LOOKBACK_DAYS = 90;
const GRID_ROSTER_MAX_SERIES = 5;

async function resolveTeamNameFromId(teamId, env) {
  try {
    const liveJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
    if (!liveJson) return null;
    const live = JSON.parse(liveJson);
    const match = (live.players || []).find(p => String(p.current_team?.id) === String(teamId));
    return match?.current_team?.name || null;
  } catch (_) {
    return null;
  }
}

async function fetchGridTeamRosterByName(teamName, gridToken, env = null, pandaTeamId = null) {
  const gte = new Date(Date.now() - GRID_ROSTER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const lte = new Date().toISOString();

  const central = await queryGridCentral({ gte, lte }, gridToken);
  const seriesList = central?.data?.allSeries?.edges?.map(e => e.node) || [];
  const target = normName(teamName);
  if (!target) return null;

  const matchingSeries = seriesList
    .filter(s => (s.teams || []).some(t => normName(t.baseInfo?.name) === target))
    .sort((a, b) => new Date(b.startTimeScheduled) - new Date(a.startTimeScheduled))
    .slice(0, GRID_ROSTER_MAX_SERIES);

  if (!matchingSeries.length) return null;

  // Opportunistic discovery: the GRID team ID for this name match is
  // already sitting in the series data we just fetched (QUERY_CS2_SERIES
  // selects teams { baseInfo { id name } }), so this costs nothing extra
  // to read. Checking its externalLinks against the PandaScore team ID
  // costs one GRID call, but only ever runs once per team — after that,
  // tryGridRosterFallback's step 1 (cached map) makes this whole
  // name-matching function unnecessary for this team.
  if (env && pandaTeamId) {
    const gridTeam = matchingSeries[0].teams?.find(t => normName(t.baseInfo?.name) === target);
    if (gridTeam?.baseInfo?.id) {
      await maybeCachePandaGridTeamMapping(pandaTeamId, gridTeam.baseInfo.id, gridToken, env);
    }
  }

  const seenNames = new Set();
  const players = [];

  for (const series of matchingSeries) {
    const state = await queryGridSeriesPlayers(series.id, gridToken);
    for (const game of (state?.games || [])) {
      for (const t of (game.teams || [])) {
        if (normName(t.name) !== target) continue;
        for (const p of (t.players || [])) {
          const key = normPlayerName(p.name);
          if (!key || seenNames.has(key)) continue;
          seenNames.add(key);
          players.push({ id: null, name: p.name, nationality: null, source: 'grid' });
        }
      }
    }
    // A single finished series is usually a full 5-man roster already.
    if (players.length >= 5) break;
  }

  return players.length ? { players, source: 'grid', fetched_at: new Date().toISOString() } : null;
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
    if (players && players.length) {
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
  await safePut(env, KV_HISTORY_CURSOR, String(nextCursor));
  return { teamId, cursor, nextCursor };
}

// Merges freshly fetched matches into the existing history, keyed by match
// id so re-fetches update rather than duplicate. Always returns the result
// sorted newest-first by begin_at: KV_HISTORY_DATA otherwise grows in
// whatever order teams happened to rotate through the scheduled job, not by
// match date, and every GET on /csgo/matches/past just slices the first
// per_page entries off the front without sorting. A freshly finished match
// that lands past that slice boundary in an unsorted array is invisible to
// the client forever (the frontend only ever requests page=1), which is
// exactly what made history look like it stopped updating. Sorting once
// here, at every write path, keeps the newest matches at the front no
// matter which team's rotation turn produced them.
async function mergeHistoryData(existing, newMatches) {
  const existingMap = new Map(existing.map(m => [m.id, m]));
  for (const match of newMatches) {
    existingMap.set(match.id, match);
  }
  return Array.from(existingMap.values())
    .sort((a, b) => new Date(b.begin_at) - new Date(a.begin_at));
}

// ── FRAGBITE NEWS ─────────────────────────────────────────────────────────
// rss.fragbite.se has no CORS headers, so the browser can never fetch it
// directly — this is a plain server-side pull with a small regex parser
// (Workers have no DOMParser/XML library available, and the feed's shape
// is fixed and simple enough that a full XML parser would be overkill).
const FRAGBITE_RSS_URL = 'https://rss.fragbite.se/';

function parseFragbiteRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const link    = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]?.trim();
    const title   = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || [])[1]?.trim();
    const descCdata = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || '';
    const image   = (descCdata.match(/<img src="([^"]+)"/) || [])[1] || null;
    // The description CDATA is "<img .../><br />Actual summary text", so
    // strip the leading image tag and <br/> to get just the summary.
    const summary = descCdata.replace(/^<img[^>]*>\s*<br\s*\/?>/i, '').trim() || null;
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]?.trim() || null;
    if (!link || !title) continue;
    items.push({ title, link, image, summary, pubDate });
  }
  return items;
}

async function fetchFragbiteNews() {
  const res = await fetch(FRAGBITE_RSS_URL, { headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' } });
  if (!res.ok) throw new Error(`Fragbite RSS request failed: ${res.status}`);
  const xml = await res.text();
  const items = parseFragbiteRss(xml);
  // Fragbite's feed mixes in non-CS content (e.g. general esports/Twitch
  // news filed under /all/news/) alongside /cs/news/ items. This tracker
  // is CS2-only, so keep just the CS items.
  return items.filter(i => i.link.includes('/cs/news/')).slice(0, 12);
}


function normPlayerName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractFinishedGames(matches) {
  const out = [];
  matches.forEach(m => {
    (m.games || []).forEach((g, idx) => {
      if (g.status !== 'finished' && !g.finished) return;
      if (!g.id) return;
      out.push({
        gameId:  g.id,
        matchId: m.id,
        mapName: g.map?.name || null,
        // Fallback correlation key for the GRID lookup when mapName is
        // missing (see fetchGridPlayerRows): PandaScore's games array and
        // GRID's games array are both ordered by play order within the
        // series, so a 1-based position match is a reasonable substitute
        // for an exact map-name match, and is what GRID's own
        // `sequenceNumber` field represents.
        sequenceNumber: g.sequence_number ?? (idx + 1),
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
  // Process newest games first. With PandaScore currently unavailable and
  // GRID's live-feed only retaining recent series state, the games actually
  // worth spending a fetch on are the recent ones — a straight FIFO queue
  // buries this week's matches behind a 14k-deep backlog of old games that
  // neither provider can serve data for anymore anyway. Sorting by date
  // descending means whatever data GRID/Panda *can* still provide surfaces
  // on the page as soon as possible instead of after weeks of churning
  // through history that's permanently out of reach.
  if (added) {
    queue.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    await safePut(env, KV_STATS_QUEUE, JSON.stringify(queue));
  }
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

// ── SHARED GRID SERIES-DISCOVERY CACHE (per stats-tick invocation) ────────
// fetchGridPlayerRows used to call queryGridCentral separately for every
// non-GRID-native game in a batch, each with its own +/-24h window. Games
// from the same match (multiple maps) share an identical meta.date, and
// even games from different matches on the same day mostly overlap in
// window — so that was up to STATS_BATCH_SIZE redundant central queries
// per tick, which is what was tipping some batches over Cloudflare's
// 50-subrequest cap ("Too many subrequests by single Worker invocation").
// This cache fetches the series list once per distinct day and reuses it
// for every game whose date falls on that day, cutting a 15-game batch's
// worst case from up to 15 central queries down to as few as 1.
function gridDayBucket(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d) ? null : d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function makeGridSeriesCache(token) {
  const cache = new Map(); // dayBucket -> Promise<series[]>
  return async function getSeriesListForDate(dateStr) {
    const bucket = gridDayBucket(dateStr);
    const key = bucket || dateStr; // fall back to the raw date if unparseable
    if (cache.has(key)) return cache.get(key);
    const fetchPromise = (async () => {
      const gte = new Date(new Date(dateStr).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const lte = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000).toISOString();
      const centralResult = await queryGridCentral({ gte, lte }, token);
      let list = centralResult?.data?.allSeries?.edges?.map(e => e.node) || [];
      // Only when the tight window comes back completely empty (not just
      // "no name match" — see findGridSeries call site), retry once with a
      // much wider window. This is what a rescheduled/delayed series needs
      // to still be found, without paying that wider cost for every game.
      if (!list.length) {
        const wideGte = new Date(new Date(dateStr).getTime() - 72 * 60 * 60 * 1000).toISOString();
        const wideLte = new Date(new Date(dateStr).getTime() + 72 * 60 * 60 * 1000).toISOString();
        const wideResult = await queryGridCentral({ gte: wideGte, lte: wideLte }, token);
        list = wideResult?.data?.allSeries?.edges?.map(e => e.node) || [];
      }
      return list;
    })();
    cache.set(key, fetchPromise);
    return fetchPromise;
  };
}

async function fetchGridPlayerRows(meta, token, env, getSeriesListForDate) {
  try {
    // GRID-native games already carry their own series ID, embedded by
    // gridSeriesToPandaMatch() as `grid-<seriesId>` (matchId) /
    // `grid-<seriesId>-g<sequenceNumber>` (gameId). For those, query
    // seriesState directly instead of re-deriving the series by searching
    // a +/-24h date window and fuzzy-matching team names — that search was
    // only ever needed for PandaScore-origin games, where GRID's own
    // series ID isn't known yet.
    let seriesId = null;
    if (typeof meta.matchId === 'string' && meta.matchId.startsWith('grid-')) {
      seriesId = meta.matchId.slice('grid-'.length);
    } else {
      const gridSeriesList = await getSeriesListForDate(meta.date);
      const series = findGridSeries(meta.t1?.name || '', meta.t2?.name || '', gridSeriesList);
      if (!series) {
        // Log the actual GRID team names seen in this window so a real
        // mismatch (different org name, abbreviation, etc.) is diagnosable
        // from the logs instead of just "no match" with no context.
        const sample = gridSeriesList.slice(0, 8)
          .map(s => (s.teams || []).map(t => t.baseInfo?.name || '?').join(' vs '))
          .join(' | ');
        console.warn(`[GRID] No series found for "${meta.t1?.name}" vs "${meta.t2?.name}" near ${meta.date} (game ${meta.gameId}) — ${gridSeriesList.length} candidates in window${sample ? `: ${sample}` : ''}`);
        return [];
      }
      seriesId = series.id;
    }

    const res = await fetch(GRID_LIVE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ query: QUERY_SERIES_STATE_PLAYERS, variables: { id: seriesId } }),
    });
    if (!res.ok) { console.error(`GRID stats query failed: ${res.status}`); return []; }
    const json = await res.json();
    if (json.errors?.length) {
      console.error(`GRID stats query errors for series ${seriesId} (game ${meta.gameId}): ${json.errors.map(e => e.message).join(', ')}`);
    }
    const seriesGames = json?.data?.seriesState?.games || [];
    // Match by map name when we have one; otherwise (or if that fails to
    // find anything — e.g. the PandaScore side never populated `games.map`
    // for this match) fall back to matching by position within the series.
    // Matching purely on `g.map?.name === meta.mapName` used to be the only
    // strategy, which meant a null/missing mapName could NEVER match a real
    // GRID map name and every such game silently produced zero rows.
    let game = meta.mapName ? seriesGames.find(g => g.map?.name === meta.mapName) : null;
    if (!game) game = seriesGames.find(g => g.sequenceNumber === meta.sequenceNumber);
    if (!game) {
      console.warn(`[GRID] Series ${seriesId} found for game ${meta.gameId}, but no series-state data for map "${meta.mapName}" / sequence ${meta.sequenceNumber} — likely expired from GRID's live-feed retention window`);
      return [];
    }
    // GRID has no single ADR field — PandaScore's is damage dealt divided
    // by rounds played. Rounds played for a finished CS2 map is just the
    // sum of both teams' final round scores (score is "rounds won", so the
    // total is rounds played, overtime included).
    const roundsPlayed = (game.teams || []).reduce((sum, t) => sum + (t.score || 0), 0);
    const rows = [];
    for (const t of (game.teams || [])) {
      const teamObj = normName(t.name) === normName(meta.t1?.name) ? meta.t1 : meta.t2;
      for (const p of (t.players || [])) {
        const playerId = await resolveGridPlayerId(p.name, teamObj?.id, env);
        rows.push({
          game_id:      meta.gameId,
          match_id:     meta.matchId,
          player_id:    playerId,
          player_name:  p.name,
          team_id:      teamObj?.id ?? null,
          kills:        p.kills ?? 0,
          deaths:       p.deaths ?? 0,
          assists:      p.killAssistsGiven ?? 0,
          headshots:    p.headshots ?? null,
          adr:          roundsPlayed > 0 && p.damageDealt != null ? +(p.damageDealt / roundsPlayed).toFixed(1) : null,
          // These three are only ever populated on GRID-sourced rows — the
          // same seriesState request already made above, no extra GRID
          // call. PandaScore rows (extractPandaPlayerRows) leave them
          // undefined/null, which the frontend already treats as "no data".
          first_kill:   p.firstKill ?? null,
          weapon_kills: (p.weaponKills || []).length
            ? p.weaponKills.map(w => ({ weapon: w.weaponName, count: w.count }))
            : null,
          multikills:   (p.multikills || []).length
            ? p.multikills.map(m => ({ kills: m.numberOfKills, count: m.count }))
            : null,
          map:          meta.mapName,
          date:         meta.date,
          source:       'grid',
        });
      }
    }

    // Series-aggregated totals (GRID computes these itself — no per-map
    // summing needed) came back on the very same response. Folding this in
    // here means it happens "for free" on the stats tick's existing GRID
    // calls, once per game processed in a series — redundant across a
    // series' maps, but putIfChanged() means only the first one per series
    // actually costs a KV write.
    if (json?.data?.seriesState?.teams) {
      await updateSeasonTotals(json.data.seriesState, meta, env);
    }

    return rows;
  } catch(err) {
    console.error(`GRID stats fetch error: ${err.message}`);
    return [];
  }
}

// ── SEASON TOTALS (GRID series-aggregated stats) ───────────────────────────
// SeriesTeamStateCs2/SeriesPlayerStateCs2 give GRID's own running totals for
// an entire series in one field selection — already included in the
// QUERY_SERIES_STATE_PLAYERS response fetchGridPlayerRows makes anyway, so
// this adds no new GRID calls. Kept as a single merged KV blob (one key for
// every player) rather than one key per player, written via putIfChanged so
// re-processing the same series (each of its maps hits this) costs nothing
// once the totals stop changing.
async function updateSeasonTotals(seriesState, meta, env) {
  const teams = seriesState?.teams || [];
  if (!teams.length) return;

  let totals;
  try {
    totals = JSON.parse(await env.MATCH_DATA.get(KV_SEASON_TOTALS) || '{}');
  } catch (_) {
    totals = {};
  }

  for (const t of teams) {
    const teamObj = normName(t.name) === normName(meta.t1?.name) ? meta.t1 : meta.t2;
    for (const p of (t.players || [])) {
      const playerId = await resolveGridPlayerId(p.name, teamObj?.id, env);
      const key = playerId ? String(playerId) : `name:${normPlayerName(p.name)}`;
      totals[key] = {
        player_id:  playerId,
        name:       p.name,
        team_id:    teamObj?.id ?? null,
        kills:      p.kills ?? 0,
        deaths:     p.deaths ?? 0,
        headshots:  p.headshots ?? 0,
        multikills: (p.multikills || []).reduce((sum, m) => sum + (m.count || 0), 0),
        updated_at: new Date().toISOString(),
      };
    }
  }

  await putIfChanged(env, KV_SEASON_TOTALS, totals);
}

// ── ONE-TIME STATS REQUEUE MIGRATION ───────────────────────────────────────
// Every game currently sitting in KV_STATS_DONE with no matching rows in
// KV_PLAYER_STATS got marked done because of the GamePlayerState interface
// bug (headshots/damageDealt selected without the GamePlayerStateCs2
// fragment — see QUERY_SERIES_STATE_PLAYERS), which made every GRID stats
// query fail validation and PandaScore was returning 403s at the same time.
// Those games exhausted STATS_MAX_ATTEMPTS and got permanently parked in
// "done" despite never having a real chance under a working query. This
// migration runs once (guarded by KV_STATS_MIGRATION) after deploying the
// fix: it re-extracts every finished game from the currently cached match
// history and re-queues whichever ones aren't already queued, with a clean
// zero-attempts count, then clears KV_STATS_DONE so nothing blocks them.
// Games that have aged out of KV_HISTORY_DATA entirely can't be recovered
// this way, but mergeHistoryData() never evicts entries, so in practice
// this should catch everything the bug ever touched.
const STATS_MIGRATION_VERSION = 'grid-stale-queue-metadata-fix-2026-08-27';

async function maybeRequeueStatsAfterFix(env) {
  try {
    const current = await env.MATCH_DATA.get(KV_STATS_MIGRATION);
    if (current === STATS_MIGRATION_VERSION) return { ran: false };

    let matches = [];
    try {
      matches = JSON.parse(await env.MATCH_DATA.get(KV_HISTORY_DATA) || '[]');
    } catch (_) {}

    const finished = extractFinishedGames(matches);
    const freshByGameId = new Map(finished.map(g => [g.gameId, g]));
    const queue = await getStatsQueue(env);

    // Rebuild metadata for every game already sitting in the queue, not
    // just games that aren't queued yet. The previous version of this
    // migration only added missing games and left existing queue entries
    // untouched ("leave its attempts count alone"), which sounded safe but
    // meant every game queued before the sequenceNumber idx+1 fallback
    // existed kept its stale mapName: null / sequenceNumber: undefined
    // forever — exactly what's been making fetchGridPlayerRows's map
    // lookup fail for nearly the entire queue even after the GRID query
    // fragment fix went live. A fresh re-extraction of the same gameId
    // always produces a defined sequenceNumber, so swap it in wherever the
    // cached history still has the game, keeping only the attempts count.
    let rebuilt = 0;
    const rebuiltQueue = queue.map(q => {
      const fresh = freshByGameId.get(q.gameId);
      if (!fresh) return q; // no longer in cached history — leave as-is
      if (fresh.mapName === q.mapName && fresh.sequenceNumber === q.sequenceNumber) return q;
      rebuilt++;
      return { ...fresh, attempts: q.attempts || 0 };
    });

    const queuedIds = new Set(rebuiltQueue.map(q => q.gameId));
    let added = 0;
    finished.forEach(g => {
      if (queuedIds.has(g.gameId)) return;
      rebuiltQueue.push(g);
      queuedIds.add(g.gameId);
      added++;
    });
    rebuiltQueue.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    await safePut(env, KV_STATS_QUEUE, JSON.stringify(rebuiltQueue));
    await safePut(env, KV_STATS_DONE, JSON.stringify([]));
    await safePut(env, KV_STATS_MIGRATION, STATS_MIGRATION_VERSION);
    console.log(`[STATS] One-time requeue: ${added} games newly added, ${rebuilt} stale queue entries rebuilt with fresh metadata, done set cleared`);
    return { ran: true, added, rebuilt };
  } catch (e) {
    console.error(`[STATS] Requeue migration failed: ${e.message}`);
    return { ran: false, error: e.message };
  }
}

const STATS_MAX_ATTEMPTS = 5; // after this many failed cron ticks, stop retrying and mark the game done

async function processStatsQueue(env) {
  const queue = await getStatsQueue(env);
  if (!queue.length) return { processed: 0, newRows: 0, remaining: 0, gaveUp: 0 };
  // Newest games first — see the comment in enqueueFinishedGames. This also
  // reorders whatever backlog is already sitting in KV, not just newly
  // added games, so it takes effect on the very next run.
  queue.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const batch     = queue.slice(0, STATS_BATCH_SIZE);
  const remaining = queue.slice(STATS_BATCH_SIZE);
  const done = await getStatsDone(env);
  const existingJson = await env.MATCH_DATA.get(KV_PLAYER_STATS);
  const existingStats = existingJson ? JSON.parse(existingJson) : [];
  const existingKeys = new Set(existingStats.map(r => `${r.game_id}_${r.player_id ?? r.player_name}`));
  // One shared series-discovery cache for the whole batch — see
  // makeGridSeriesCache's comment for why this matters for the
  // subrequest budget.
  const getSeriesListForDate = env.GRID_TOKEN ? makeGridSeriesCache(env.GRID_TOKEN) : null;
  let newRowCount = 0;
  let gaveUpCount = 0;
  for (const meta of batch) {
    let rows = [];
    // Skip PandaScore entirely for GRID-native game IDs — matchId is a
    // string like "grid-<seriesId>", never a PandaScore-valid numeric ID,
    // so this call would only ever waste a rate-limited request and log
    // a confusing 404/400. Go straight to the GRID fallback for these.
    const isGridNativeGame = typeof meta.matchId === 'string' && meta.matchId.startsWith('grid-');
    if (!isGridNativeGame) {
      try {
        const game = await fetchPandaGameStats(meta, env.PANDASCORE_TOKEN);
        rows = extractPandaPlayerRows(game, meta);
      } catch(e) { console.error(`Panda stats fetch error for game ${meta.gameId}: ${e.message}`); }
    }
    if (!rows.length && env.GRID_TOKEN) {
      rows = await fetchGridPlayerRows(meta, env.GRID_TOKEN, env, getSeriesListForDate);
    } else if (!rows.length) {
      console.warn(`[STATS] No PandaScore data for game ${meta.gameId} and GRID_TOKEN is not set — skipping GRID fallback entirely`);
    }
    rows.forEach(r => {
      const key = `${r.game_id}_${r.player_id ?? r.player_name}`;
      if (!existingKeys.has(key)) {
        existingStats.push(r);
        existingKeys.add(key);
        newRowCount++;
      }
    });
    if (rows.length) {
      done.add(meta.gameId);
      continue;
    }
    // Neither provider had data this attempt. Retry a bounded number of
    // times (covers a transient PandaScore/GRID hiccup), then give up for
    // good. Without this cap, a game with no data on either source (e.g.
    // a match PandaScore returns 403 for and GRID never covered) requeues
    // itself forever: same 5 games in, same 5 games out, every cron tick,
    // hitting both providers for nothing every time.
    const attempts = (meta.attempts || 0) + 1;
    if (attempts >= STATS_MAX_ATTEMPTS) {
      done.add(meta.gameId);
      gaveUpCount++;
      console.warn(`Player stats: giving up on game ${meta.gameId} after ${attempts} attempts, no data from PandaScore or GRID`);
    } else {
      remaining.push({ ...meta, attempts });
    }
  }
  await safePut(env, KV_PLAYER_STATS, JSON.stringify(existingStats));
  await safePut(env, KV_STATS_DONE, JSON.stringify([...done]));
  await safePut(env, KV_STATS_QUEUE, JSON.stringify(remaining));
  return { processed: batch.length, newRows: newRowCount, remaining: remaining.length, gaveUp: gaveUpCount };
}

// ─── SCHEDULED HANDLER ───────────────────────────────────────────────────
// Cloudflare's free-tier Workers cap a single invocation at 50 subrequests
// (fetch() calls). Bundling team-metadata refresh + history rotation +
// player-stats-queue processing onto the SAME heavy tick could blow that
// budget in one shot once GRID fallbacks are involved: Swedish-player
// pagination (up to ~6 calls) + per-team GRID roster fallback (up to 2
// calls × 5 teams) + history rotation's own GRID fallback (1-2 calls) +
// stats queue (up to 3 calls × STATS_BATCH_SIZE games) can all land in one
// invocation and trip "Too many subrequests", silently truncating whatever
// ran last (player stats, in practice). Splitting these across two
// different tick offsets keeps each invocation's subrequest count well
// under the cap while preserving the same overall cadence.
const METADATA_TICK_OFFSET = 0;
const STATS_TICK_OFFSET    = 4; // half a HEAVY_TASK_EVERY_N_TICKS cycle away from METADATA_TICK_OFFSET

function tickIndexFor(scheduledTime) {
  if (!scheduledTime) return null; // manual/test invocation
  return Math.floor(scheduledTime / (CRON_INTERVAL_MINUTES * 60 * 1000));
}

function isMetadataTick(scheduledTime) {
  const idx = tickIndexFor(scheduledTime);
  if (idx === null) return true;
  return idx % HEAVY_TASK_EVERY_N_TICKS === METADATA_TICK_OFFSET;
}

function isStatsTick(scheduledTime) {
  const idx = tickIndexFor(scheduledTime);
  if (idx === null) return true;
  return idx % HEAVY_TASK_EVERY_N_TICKS === STATS_TICK_OFFSET;
}

async function handleScheduled(env, scheduledTime) {
  try {
    const metadataTick = isMetadataTick(scheduledTime);
    const statsTick     = isStatsTick(scheduledTime);
    console.log(`Scheduled handler triggered${metadataTick ? ' (metadata tick)' : ''}${statsTick ? ' (stats tick)' : ''}`);

    // One-time requeue after the GRID GamePlayerState interface fragment fix
    // (see maybeRequeueStatsAfterFix's own comment). Guarded internally by
    // KV_STATS_MIGRATION so this is a single cheap KV read on every tick
    // after the one time it actually runs. Must happen before the stats
    // tick below, or the fix has nothing to retry — every affected game is
    // still sitting in KV_STATS_DONE from the broken query.
    await maybeRequeueStatsAfterFix(env);

    // Incidents feed: catches roster/score-correction changes between
    // metadata ticks instead of waiting up to ~24 min for the next full
    // players pull to notice a swap. One extra PandaScore call, gated to
    // the metadata tick so it runs on the same ~24-min cadence as the rest
    // of the "not every tick needs this" work; zero extra KV writes on the
    // happy path (it only deletes a stale roster cache key, which forces a
    // fresh pull the next time that team's roster is requested).
    if (metadataTick && env.PANDASCORE_TOKEN) {
      try {
        const sinceIso = new Date(Date.now() - (HEAVY_TASK_EVERY_N_TICKS * CRON_INTERVAL_MINUTES + 5) * 60 * 1000).toISOString();
        const incidents = await fetchRecentPandaIncidents(env.PANDASCORE_TOKEN, sinceIso);
        if (incidents) await invalidateRostersForIncidents(incidents, env);
      } catch (e) {
        console.warn(`[INCIDENTS] Fetch/invalidate failed: ${e.message}`);
      }
    }

    const oldLiveJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
    const oldLive = oldLiveJson ? JSON.parse(oldLiveJson) : null;

    // 1) Swedish player/team discovery. Order of preference:
    //    a) PandaScore (source of truth — has real nationality data)
    //    b) GRID, queried directly by nationality (fetchGridSwedishPlayers) —
    //       a real fallback, not just a name-matching workaround, since
    //       GRID's `players` query supports a nationality filter.
    //    c) Last-known player list already in KV_LIVE_DATA ("freeze the
    //       roster" — rosters don't change fast enough for this to be
    //       stale in any way that matters over a PandaScore outage).
    let players = await tryPanda(
      () => fetchSwedishPlayers(env.PANDASCORE_TOKEN),
      null
    );

    let swedishTeamNames = [];
    if (players && players.length) {
      swedishTeamNames = [...new Set(
        players.map(p => p.current_team?.name).filter(Boolean)
      )];
      // Team metadata (KV_SWEDISH_TEAMS/NAMES) only feeds the history-rotation
      // cursor and the Panda-outage fallback below — rosters barely change,
      // so this write doesn't need to happen every tick. swedishTeamNames
      // itself is still recomputed fresh every tick for match filtering.
      if (metadataTick) await saveSwedishTeamMetadata(players, env);
    } else {
      // PandaScore returned nothing usable (null = failed, or a genuinely
      // empty list). Try GRID's own nationality filter before giving up.
      if (env.GRID_TOKEN) {
        const gridPlayers = await fetchGridSwedishPlayers('SE', env.GRID_TOKEN, env);
        if (gridPlayers && gridPlayers.length) {
          players = gridPlayers;
          swedishTeamNames = [...new Set(
            players.map(p => p.current_team?.name).filter(Boolean)
          )];
          if (metadataTick) await saveSwedishTeamMetadata(players, env);
        }
      }
      if (!players || !players.length) {
        // GRID fallback unavailable or also came back empty — freeze the
        // roster at its last known-good state rather than showing nothing.
        swedishTeamNames = await getCachedSwedishTeamNames(env);
        players = (oldLive?.players?.length ? oldLive.players : []);
      }
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

    const liveWritten = await putIfChanged(env, KV_LIVE_DATA, liveData);
    console.log(`Live data ${liveWritten ? 'updated' : 'unchanged, write skipped'} — ${runningMatches.length || 0} running + ${upcomingMatches.length || 0} upcoming matches`);

    // 3) History rotation — only on the metadata tick (see the subrequest
    // budget note above handleScheduled).
    if (metadataTick) {
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
          await safePut(env, KV_HISTORY_DATA, JSON.stringify(mergedHistory));
        } else if (env.GRID_TOKEN && swedishTeamNames.length) {
          const historyGte = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          const historyLte = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          const gridHistory = await fetchGridMatches(
            env.GRID_TOKEN, swedishTeamNames, historyGte, historyLte, true
          );
          const existingHistoryJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
          const existingHistory = existingHistoryJson ? JSON.parse(existingHistoryJson) : [];
          const mergedHistory = await mergeHistoryData(existingHistory, gridHistory);
          await safePut(env, KV_HISTORY_DATA, JSON.stringify(mergedHistory));
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
        await safePut(env, KV_HISTORY_DATA, JSON.stringify(mergedHistory));
      }
    }

    // 4) Player stats queue — on its own tick, offset from the metadata
    // tick, so it gets its own ~50-subrequest budget instead of splitting
    // it with team-metadata/history-rotation work above.
    if (statsTick) {
      try {
        const historyJson = await env.MATCH_DATA.get(KV_HISTORY_DATA);
        const historyForQueue = historyJson ? JSON.parse(historyJson) : [];
        const added = await enqueueFinishedGames(historyForQueue, env);
        if (added) console.log(`Queued ${added} newly finished games for stats`);
        const { processed, newRows, remaining, gaveUp } = await processStatsQueue(env);
        if (processed) {
          console.log(`Player stats: processed ${processed} games, ${newRows} new rows, ${gaveUp} gave up, ${remaining} left in queue`);
        }
      } catch (e) {
        console.error(`Player stats pipeline error: ${e.message}`);
      }
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
      const nameHint = url.searchParams.get('name') || null;
      try {
        const data = await fetchTeamRoster(teamId, env.PANDASCORE_TOKEN, env, nameHint);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
        });
      } catch (err) {
        console.error(`Team roster fetch error for team ${teamId}: ${err.message}`);
        // fetchTeamRoster already checked both the fresh and durable stale
        // KV copies before throwing, so reaching this point means neither
        // exists yet for this team. Nothing left to serve.
        return new Response(JSON.stringify({ error: 'Could not fetch team roster and no cached roster exists', detail: err.message }), {
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
      // Fallback: PandaScore, then GRID nationality query, then stale cached players.
      try {
        const players = await fetchPandascoreWithPagination(
          `${PANDA_BASE}/csgo/players?filter[nationality]=SE&per_page=100`,
          env.PANDASCORE_TOKEN
        );
        if (players !== null) {
          return new Response(JSON.stringify(players), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
          });
        }
        throw new Error('PandaScore players request failed');
      } catch (err) {
        // PandaScore failed outright (not just "zero results") — try GRID's
        // nationality filter before falling back to a stale KV copy.
        if (env.GRID_TOKEN) {
          const gridPlayers = await fetchGridSwedishPlayers('SE', env.GRID_TOKEN, env);
          if (gridPlayers && gridPlayers.length) {
            return new Response(JSON.stringify(gridPlayers), {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
            });
          }
        }
        // Last resort: stale KV copy from the last successful scheduler run.
        const cachedJson = await env.MATCH_DATA.get(KV_LIVE_DATA);
        if (cachedJson) {
          const liveData = JSON.parse(cachedJson);
          return new Response(JSON.stringify(liveData.players || []), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
          });
        }
        return new Response(JSON.stringify({ error: 'Failed to fetch players from PandaScore and GRID, and no cached data exists' }), {
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
        return new Response(JSON.stringify(matches || []), {
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
        return new Response(JSON.stringify(matches || []), {
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
        // mergeHistoryData() is the only writer of KV_HISTORY_DATA and
        // already sorts newest-first before every write, so trust that
        // order here instead of re-sorting on every single GET. Re-sorting
        // the whole array on each request scaled with total history size
        // (which only ever grows — mergeHistoryData never evicts) and was
        // hitting the Worker's CPU time limit on the higher-numbered pages
        // the client's full-history walk requests.
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

    // /csgo/teams/ranking — HLTV primary, PandaScore fallback
    if (path === '/csgo/teams/ranking') {
      let ranking = await fetchHLTV('/api/teams/ranking', env);
      if (ranking) {
        const normalized = normalizeHLTVRanking(ranking);
        return new Response(JSON.stringify(normalized), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...corsHeaders(origin) },
        });
      }
      // Fall back to PandaScore if HLTV fails
      try {
        const ps = await fetchPandascoreWithPagination(
          `${PANDA_BASE}/csgo/teams/ranking?per_page=50`,
          env.PANDASCORE_TOKEN, 1
        );
        return new Response(JSON.stringify(ps || []), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...corsHeaders(origin) },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Rankings unavailable' }), {
          status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    // /csgo/season-totals — GRID series-aggregated per-player totals (see
    // updateSeasonTotals). Small enough to always return whole, no paging.
    if (path.includes('/season-totals')) {
      const totalsJson = await env.MATCH_DATA.get(KV_SEASON_TOTALS);
      const totals = totalsJson ? JSON.parse(totalsJson) : {};
      return new Response(JSON.stringify(Object.values(totals)), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...corsHeaders(origin) },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // GET /news — Fragbite.se CS2 news, cached in KV so the frontend never
  // hits rss.fragbite.se directly (that feed has no CORS headers for
  // browser fetches, and hammering it on every page load would be rude
  // anyway). NEWS_TTL_MS controls how often this worker re-pulls the feed;
  // everything in between is served straight from KV_NEWS_DATA.
  if (request.method === 'GET' && path === '/news') {
    const NEWS_TTL_MS = 15 * 60 * 1000;
    const cachedJson = await env.MATCH_DATA.get(KV_NEWS_DATA);
    const cached = cachedJson ? JSON.parse(cachedJson) : null;
    if (cached && Date.now() - cached.fetchedAt < NEWS_TTL_MS) {
      return new Response(JSON.stringify(cached.items), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders(origin) },
      });
    }
    try {
      const items = await fetchFragbiteNews();
      await safePut(env, KV_NEWS_DATA, JSON.stringify({ fetchedAt: Date.now(), items }));
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...corsHeaders(origin) },
      });
    } catch (err) {
      console.error(`Fragbite news fetch error: ${err.message}`);
      // Serve a stale KV copy rather than nothing, if one exists.
      if (cached) {
        return new Response(JSON.stringify(cached.items), {
          status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
      return new Response(JSON.stringify({ error: 'Failed to fetch Fragbite news' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  return new Response('Method not allowed', { status: 405 });
}

// ─── EXPORT ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    return handleFetch(request, env);
  },
  async scheduled(event, env) {
    await handleScheduled(env, event.scheduledTime);
  },
};