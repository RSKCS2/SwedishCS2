/**
 * shared.js — Hybrid PandaScore + GRID, with localStorage caching
 *
 * Cache keys:
 *   swe_players        Swedish team data (1 hour TTL)
 *   swe_live           Live+upcoming matches (30s / 5min TTL)
 *   swe_history        Accumulated past matches (grows forever, never deleted)
 */
const WORKER_URL         = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';
const TURNSTILE_SITE_KEY = '0x4AAAAAAEau1bQWCYwLDKfv';
const SESSION_TTL_MS     = 30 * 60 * 1000; // must match the Worker's expiry window
const SESSION_STORE_KEY  = 'swe_session';

// ── SESSION TOKEN ───────────────────────────────────────────────────────────
let _sessionToken   = null;
let _sessionExpiry  = 0;
let _sessionInFlight = null;
let _turnstileWidgetId = null;
let _turnstilePendingResolve = null;
let _turnstilePendingReject  = null;

(function _loadStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORE_KEY);
    if (!raw) return;
    const { token, expiry } = JSON.parse(raw);
    if (expiry > Date.now()) { _sessionToken = token; _sessionExpiry = expiry; }
  } catch(_) {}
})();

function _storeSession(token, expiry) {
  _sessionToken  = token;
  _sessionExpiry = expiry;
  try { sessionStorage.setItem(SESSION_STORE_KEY, JSON.stringify({ token, expiry })); } catch(_) {}
}

function _initTurnstileWidget() {
  if (_turnstileWidgetId !== null) return;
  _turnstileWidgetId = turnstile.render('#turnstile-container', {
    sitekey: TURNSTILE_SITE_KEY,
    execution: 'execute',
    callback: (token) => { if (_turnstilePendingResolve) _turnstilePendingResolve(token); },
    'error-callback': () => { if (_turnstilePendingReject) _turnstilePendingReject(new Error('Turnstile verification failed')); },
    'timeout-callback': () => { if (_turnstilePendingReject) _turnstilePendingReject(new Error('Turnstile timed out')); },
  });
}

function _waitForTurnstile(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (typeof turnstile !== 'undefined') { resolve(); return; }
    const start = Date.now();
    const iv = setInterval(() => {
      if (typeof turnstile !== 'undefined') {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('Turnstile script failed to load'));
      }
    }, 100);
  });
}

async function _getTurnstileToken() {
  await _waitForTurnstile();
  return new Promise((resolve, reject) => {
    _initTurnstileWidget();
    _turnstilePendingResolve = resolve;
    _turnstilePendingReject  = reject;
    turnstile.reset(_turnstileWidgetId);
    turnstile.execute(_turnstileWidgetId);
  });
}

async function _exchangeSession() {
  const turnstileToken = await _getTurnstileToken();
  const res = await fetch(WORKER_URL + '/session', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ token: turnstileToken }),
  });
  if (!res.ok) throw Object.assign(new Error('Session exchange failed'), { status: res.status });
  const { session, expiresAt } = await res.json();
  _storeSession(session, expiresAt);
  return session;
}

async function getSessionToken(forceRefresh = false) {
  if (!forceRefresh && _sessionToken && _sessionExpiry - Date.now() > 60 * 1000) {
    return _sessionToken;
  }
  if (!_sessionInFlight) {
    _sessionInFlight = _exchangeSession().finally(() => { _sessionInFlight = null; });
  }
  return _sessionInFlight;
}

// ── LOCAL STORAGE CACHE ───────────────────────────────────────────────────
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch(_) {}
}
function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (maxAgeMs && Date.now() - ts > maxAgeMs) return null;
    return data;
  } catch(_) { return null; }
}

// ── GLOBAL FLAG: stop retrying if PandaScore is unreachable ──────────────
// Scope note: only guard calls that hit a Worker route which itself calls
// PandaScore live with no fallback (currently just /csgo/teams/{id}, via
// ensureTeamCountries). Routes that are KV-backed on the Worker side
// (/csgo/matches/past, /csgo/player-stats) already have GRID blended in
// server-side by the scheduled job, so they must not be gated by this flag.
let _pandaScoreUnavailable = false;

// ── PANDASCORE REST ───────────────────────────────────────────────────────
// bypassGuard: set true for Worker routes that are KV-backed and never call
// PandaScore live in the request path (/csgo/matches/past, /csgo/player-stats).
// Those routes always return 200, so calling them while _pandaScoreUnavailable
// is true is safe and should not be blocked by an unrelated outage.
async function pandaFetch(path, { bypassGuard = false } = {}) {
  if (_pandaScoreUnavailable && !bypassGuard) {
    throw new Error('PandaScore unavailable (previous failure)');
  }
  const session = await getSessionToken();
  let res = await fetch(WORKER_URL + path, { headers: { 'X-Session-Token': session } });
  if (res.status === 401) {
    const fresh = await getSessionToken(true);
    res = await fetch(WORKER_URL + path, { headers: { 'X-Session-Token': fresh } });
  }
  // The Worker may transparently fall back to GRID. Only mark PandaScore
  // unavailable when the Worker itself cannot satisfy the request.
  if (res.status === 429 || res.status >= 500) {
    _pandaScoreUnavailable = true;
    throw new Error(`Data backend unavailable (HTTP ${res.status})`);
  }
  if (res.status === 401 || res.status === 403) {
    _pandaScoreUnavailable = true;
    throw new Error(`Data backend authorization failed (HTTP ${res.status})`);
  }
  if (!res.ok) throw Object.assign(new Error('PandaScore error'), { status: res.status });
  return res.json();
}

// ── GRID GRAPHQL ──────────────────────────────────────────────────────────
async function gridFetch(endpoint, query, variables = {}) {
  const session = await getSessionToken();
  const doFetch = (token) => fetch(WORKER_URL + endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
    body:    JSON.stringify({ query, variables }),
  });
  let res = await doFetch(session);
  if (res.status === 401) {
    const fresh = await getSessionToken(true);
    res = await doFetch(fresh);
  }
  if (!res.ok) throw Object.assign(new Error('GRID error'), { status: res.status });
  const json = await res.json();
  if (json.errors?.length) console.warn('[GRID] errors:', json.errors.map(e => e.message).join(', '));
  return json.data;
}

// ── SWEDISH PLAYER DATA ───────────────────────────────────────────────────
let _sweTeamData = {};
let _swePlayers  = [];
let _sweLoaded   = false;

async function ensureSwedishData() {
  if (_sweLoaded) return;

  const cached = cacheGet('swe_players_v2', 6 * 60 * 60 * 1000);
  if (cached) { _sweTeamData = cached.teams || {}; _swePlayers = cached.players || []; _sweLoaded = true; return; }

  try {
    _sweTeamData = {};
    _swePlayers  = [];
    let page = 1;
    while (true) {
      const players = await pandaFetch(`/csgo/players?filter[nationality]=SE&per_page=100&page=${page}`);
      if (!players.length) break;
      players.forEach(p => {
        _swePlayers.push(p);
        const tid = p.current_team?.id;
        if (!tid) return;
        if (!_sweTeamData[tid]) _sweTeamData[tid] = { count: 0, isFull: false, name: p.current_team?.name };
        _sweTeamData[tid].count++;
      });
      if (players.length < 100) break;
      page++;
    }
    Object.values(_sweTeamData).forEach(d => { d.isFull = d.count >= 5; d.isMajority = d.count >= 3; });
    cacheSet('swe_players_v2', { teams: _sweTeamData, players: _swePlayers });
  } catch(e) {
    console.warn('[SWE] Failed to load Swedish player data:', e);
  }
  _sweLoaded = true;
}

function sweInfo(team) {
  return (team && _sweTeamData[team.id]) ? _sweTeamData[team.id] : null;
}

function hasSweTeam(match) {
  return !!(sweInfo(match.opponents?.[0]?.opponent) || sweInfo(match.opponents?.[1]?.opponent));
}

function getSwedishPlayers() {
  return _swePlayers;
}

function getSwedishTeamIds() {
  return Object.keys(_sweTeamData);
}

// ── TEAM NATIONALITY with failure cache ────────────────────────────────────
const _teamCountryCacheKey = 'swe_team_country_v1';
let _teamCountryCache = null;
let _teamCountryFailures = new Set();

function _getTeamCountryCache() {
  if (_teamCountryCache) return _teamCountryCache;
  _teamCountryCache = cacheGet(_teamCountryCacheKey, 24 * 60 * 60 * 1000) || {};
  return _teamCountryCache;
}
function _saveTeamCountryCache() {
  cacheSet(_teamCountryCacheKey, _teamCountryCache);
}

const EUROPE_CODES = new Set([
  'SE','NO','DK','FI','IS','DE','FR','GB','IE','NL','BE','LU','ES','PT','IT',
  'CH','AT','PL','CZ','SK','HU','SI','HR','BA','RS','ME','MK','AL','GR','RO',
  'BG','UA','BY','LT','LV','EE','MD','MT','CY','AD','MC','SM','VA','LI','KZ',
]);

function classifyTeamCountry(players) {
  const counts = {};
  let total = 0;
  (players || []).forEach(p => {
    const nat = p?.nationality;
    if (!nat) return;
    counts[nat] = (counts[nat] || 0) + 1;
    total++;
  });
  if (!total) return { type: 'international' };

  let best = null, bestCount = 0;
  Object.entries(counts).forEach(([code, n]) => {
    if (n > bestCount) { best = code; bestCount = n; }
  });
  if (bestCount >= 3 || bestCount / total > 0.6) {
    return { type: 'majority', code: best };
  }

  const europeCount = Object.entries(counts)
    .filter(([code]) => EUROPE_CODES.has(code))
    .reduce((sum, [, n]) => sum + n, 0);
  if (europeCount / total > 0.5) return { type: 'europe' };

  return { type: 'international' };
}

async function ensureTeamCountries(teamIds) {
  if (_pandaScoreUnavailable) {
    console.warn('[SWE] Skipping team country fetches – PandaScore unavailable');
    return _getTeamCountryCache();
  }
  const cache = _getTeamCountryCache();
  const missing = [...new Set(teamIds)]
    .filter(id => id && !(id in cache) && !_teamCountryFailures.has(id));

  if (!missing.length) return cache;

  // The Worker's GRID fallback has no PandaScore-compatible team ID and has
  // to search by name. It can reconstruct a name from its own KV_LIVE_DATA,
  // but that cache can itself be empty for this team during a PandaScore
  // outage. We already have the name right here, so send it along.
  const nameById = {};
  _swePlayers.forEach(p => { if (p.current_team?.id) nameById[p.current_team.id] = p.current_team.name; });

  let dirty = false;
  const BATCH_SIZE = 5;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async id => {
      try {
        const nameHint = nameById[id] ? `?name=${encodeURIComponent(nameById[id])}` : '';
        const team = await pandaFetch(`/csgo/teams/${id}${nameHint}`);
        cache[id] = classifyTeamCountry(team?.players);
        dirty = true;
      } catch(e) {
        _teamCountryFailures.add(id);
        // Only log if not an auth failure (already logged globally)
        if (!_pandaScoreUnavailable) {
          console.warn('[SWE] Could not fetch roster for team', id, e);
        }
      }
    }));
  }
  if (dirty) _saveTeamCountryCache();
  return cache;
}

function teamCountryInfo(teamId) {
  return _getTeamCountryCache()[teamId] || null;
}

function teamCountryLine(teamId) {
  const info = teamCountryInfo(teamId);
  if (!info) return '🌐 International';
  if (info.type === 'majority' && info.code) return `${countryFlag(info.code)} ${info.code.toUpperCase()}`;
  if (info.type === 'europe') return '🇪🇺 Europe';
  return '🌐 International';
}

// ── TEAM MATCH HISTORY ──────────────────────────────────────────────────────
async function ensureMatchHistory() {
  // Not gated on _pandaScoreUnavailable: the Worker's /csgo/matches/past
  // route only reads KV_HISTORY_DATA, which the scheduled job populates
  // from PandaScore or GRID. It does not call PandaScore live per request.
  const CACHE_VERSION     = 'v3';
  const HISTORY_KEY       = 'swe_history_' + CACHE_VERSION;
  const HISTORY_FETCH_KEY = 'swe_history_fetched_' + CACHE_VERSION;
  const HISTORY_STALE_MS  = 2 * 60 * 60 * 1000;

  await ensureSwedishData();
  let matches = (cacheGet(HISTORY_KEY) || []).filter(m => m.begin_at && m.opponents?.length === 2);

  const lastFetch = parseInt(localStorage.getItem(HISTORY_FETCH_KEY) || '0', 10);
  const isStale   = Date.now() - lastFetch > HISTORY_STALE_MS;
  if (isStale || !matches.length) {
    try {
      // The Worker's KV_HISTORY_DATA keeps every match it has ever merged
      // in (mergeHistoryData never evicts), so a single per_page=100 fetch
      // only ever returned page 1 — the newest 100 matches — and every
      // older match was permanently unreachable from the client, however
      // deep the Worker's own cache actually went. Page through the full
      // /csgo/matches/past result set the same way ensureSwedishData()
      // already pages through /csgo/players, stopping once a page comes
      // back short of a full 100.
      const fetched = [];
      let page = 1;
      while (true) {
        const pastPage = await pandaFetch(`/csgo/matches/past?per_page=100&page=${page}&include=opponents,results,games,winner`, { bypassGuard: true });
        if (!pastPage.length) break;
        fetched.push(...pastPage.filter(m => m.opponents?.length === 2 && (sweInfo(m.opponents[0]?.opponent) || sweInfo(m.opponents[1]?.opponent))));
        if (pastPage.length < 100) break;
        page++;
      }
      const seen = new Set();
      matches = [...fetched, ...matches].filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      cacheSet(HISTORY_KEY, matches);
      localStorage.setItem(HISTORY_FETCH_KEY, Date.now().toString());
    } catch(e) {
      console.warn('[SWE] Failed to load match history:', e);
    }
  }
  return matches;
}

function buildTeamProfiles(matches, cutoff = monthsAgo(3), end = null) {
  const profiles = {};

  matches.forEach(m => {
    const t1 = m.opponents?.[0]?.opponent;
    const t2 = m.opponents?.[1]?.opponent;
    [[t1, t2], [t2, t1]].forEach(([self, opp]) => {
      if (!self?.id || !sweInfo(self)) return;
      if (!profiles[self.id]) {
        profiles[self.id] = { id: self.id, name: self.name, logo: self.image_url || null, location: self.location || null, matches: [], wins3m: 0, losses3m: 0 };
      }
      const p = profiles[self.id];
      if (self.image_url) p.logo = self.image_url;
      if (self.location && !p.location) p.location = self.location;
      const { t1Maps, t2Maps } = extractMapScore(m);
      const selfMaps = self.id === t1?.id ? t1Maps : t2Maps;
      const oppMaps  = self.id === t1?.id ? t2Maps : t1Maps;
      const won = m.winner?.id === self.id;
      p.matches.push({ oppName: opp?.name || 'TBD', selfMaps, oppMaps, won, date: m.begin_at });
      const d = new Date(m.begin_at);
      if (d >= cutoff && (!end || d <= end)) { if (won) p.wins3m++; else p.losses3m++; }
    });
  });

  Object.values(profiles).forEach(p => p.matches.sort((a, b) => new Date(b.date) - new Date(a.date)));
  return profiles;
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

// Shared period-range logic — used by any page that needs to turn a period
// key (plus optional custom bounds) into a concrete date range. Keys match
// what history.html's period tabs already used, so behavior stays consistent
// across pages.
function computePeriodRange(key, customStart, customEnd) {
  const now = new Date();
  let start;
  switch (key) {
    case 'year':  start = new Date(now.getFullYear(), 0, 1); break;
    case '9m':    start = new Date(now); start.setMonth(now.getMonth() - 9); break;
    case '6m':    start = new Date(now); start.setMonth(now.getMonth() - 6); break;
    case '3m':    start = new Date(now); start.setMonth(now.getMonth() - 3); break;
    case 'month': start = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'week':  start = new Date(now); start.setDate(now.getDate() - now.getDay()); break;
    case 'day':   start = new Date(now); start.setHours(0, 0, 0, 0); break;
    case 'custom': {
      const s = customStart ? new Date(customStart) : null;
      const e = customEnd ? new Date(customEnd) : null;
      if (e) e.setHours(23, 59, 59, 999);
      return { start: s || new Date(0), end: e };
    }
    case 'all':
    default: start = new Date(0);
  }
  return { start, end: null };
}

// Prevents a single trailing word (e.g. "Season", "C") from being stranded
// alone on the last line of wrapped metadata text — ties the final two
// words together with a non-breaking space.
//
// Context strings are usually several " · "-joined segments (league,
// stage, BO format, etc.), e.g. "ESL Pro League Season 20 · Regular Season
// · BO3". Only fixing the very end of the whole string used to leave
// "Regular Season" and "Group C" free to wrap apart from each other since
// neither sits at the true end — each segment needs its own last-two-words
// tie so a short trailing word never wraps onto a line by itself.
function noOrphan(text) {
  if (!text) return text;
  return text.split(' · ').map(segment => {
    const idx = segment.lastIndexOf(' ');
    if (idx === -1) return segment;
    return segment.slice(0, idx) + '&nbsp;' + segment.slice(idx + 1);
  }).join(' · ');
}

function rankTeamProfiles(profiles) {
  const list = Object.values(profiles);
  list.sort((a, b) => {
    const diffA = a.wins3m - a.losses3m, diffB = b.wins3m - b.losses3m;
    if (diffB !== diffA) return diffB - diffA;
    if (b.wins3m !== a.wins3m) return b.wins3m - a.wins3m;
    const infoA = sweInfo({ id: a.id }), infoB = sweInfo({ id: b.id });
    const fullA = infoA?.isFull ? 1 : 0, fullB = infoB?.isFull ? 1 : 0;
    if (fullB !== fullA) return fullB - fullA;
    return (a.name || '').localeCompare(b.name || '');
  });
  list.forEach((p, i) => { p.rank = i + 1; });
  return list;
}

// ── PLAYER GAME STATS ──────────────────────────────────────────────────────
async function ensurePlayerGameStats() {
  // Not gated on _pandaScoreUnavailable: the Worker's /csgo/player-stats
  // route only reads KV_PLAYER_STATS, which processStatsQueue() populates
  // by trying PandaScore then GRID per game. It does not call PandaScore
  // live per request, so a PandaScore outage elsewhere must not skip this.
  const CACHE_VERSION  = 'v1';
  const STATS_KEY       = 'swe_player_stats_' + CACHE_VERSION;
  const STATS_FETCH_KEY = 'swe_player_stats_fetched_' + CACHE_VERSION;
  const STATS_STALE_MS  = 2 * 60 * 60 * 1000;

  let rows = cacheGet(STATS_KEY) || [];
  const lastFetch = parseInt(localStorage.getItem(STATS_FETCH_KEY) || '0', 10);
  const isStale = Date.now() - lastFetch > STATS_STALE_MS;

  if (isStale || !rows.length) {
    try {
      const fetched = [];
      let page = 1;
      while (true) {
        const batch = await pandaFetch(`/csgo/player-stats?per_page=100&page=${page}`, { bypassGuard: true });
        if (!batch.length) break;
        fetched.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
      if (fetched.length) {
        rows = fetched;
        cacheSet(STATS_KEY, rows);
      }
      localStorage.setItem(STATS_FETCH_KEY, Date.now().toString());
    } catch(e) {
      console.warn('[SWE] Failed to load player stats:', e);
    }
  }
  return rows;
}

// ── FRAGBITE NEWS ─────────────────────────────────────────────────────────
async function ensureFragbiteNews() {
  // Not gated on _pandaScoreUnavailable: the Worker's /news route only
  // talks to Fragbite's RSS feed, it has nothing to do with PandaScore.
  const NEWS_KEY       = 'swe_fragbite_news_v1';
  const NEWS_FETCH_KEY = 'swe_fragbite_news_fetched_v1';
  const NEWS_STALE_MS  = 15 * 60 * 1000; // matches the Worker's own KV TTL

  let items = cacheGet(NEWS_KEY) || [];
  const lastFetch = parseInt(localStorage.getItem(NEWS_FETCH_KEY) || '0', 10);
  const isStale = Date.now() - lastFetch > NEWS_STALE_MS;

  if (isStale || !items.length) {
    try {
      const fetched = await pandaFetch('/news', { bypassGuard: true });
      if (Array.isArray(fetched) && fetched.length) {
        items = fetched;
        cacheSet(NEWS_KEY, items);
      }
      localStorage.setItem(NEWS_FETCH_KEY, Date.now().toString());
    } catch(e) {
      console.warn('[SWE] Failed to load Fragbite news:', e);
    }
  }
  return items;
}

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (isNaN(diffMs)) return '';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function buildPlayerStatProfiles(rows, cutoff, players = [], end = null) {
  const nameToId = {};
  players.forEach(p => { if (p.name) nameToId[normPlayerNameFE(p.name)] = p.id; });

  const agg = {};
  rows.forEach(r => {
    if (r.date) {
      const d = new Date(r.date);
      if (d < cutoff) return;
      if (end && d > end) return;
    }
    const pid = r.player_id ?? (r.player_name ? nameToId[normPlayerNameFE(r.player_name)] : null);
    if (!pid) return;
    if (!agg[pid]) agg[pid] = { kills: 0, deaths: 0, adrSum: 0, adrCount: 0, maps: 0, headshots: 0, multikills: 0, firstKills: 0 };
    const a = agg[pid];
    a.kills += r.kills || 0;
    a.deaths += r.deaths || 0;
    if (r.adr != null) { a.adrSum += r.adr; a.adrCount++; }
    a.maps++;
    // Only populated on GRID-sourced rows (see worker.js's
    // fetchGridPlayerRows) — PandaScore rows leave these undefined, which
    // just contributes 0 here rather than skewing anything.
    a.headshots += r.headshots || 0;
    if (r.multikills?.length) a.multikills += r.multikills.reduce((s, m) => s + (m.count || 0), 0);
    if (r.first_kill) a.firstKills++;
  });

  const profiles = {};
  Object.entries(agg).forEach(([pid, a]) => {
    profiles[pid] = {
      kd_ratio:    a.maps ? +(a.kills / Math.max(a.deaths, 1)).toFixed(2) : 0,
      adr:         a.adrCount ? Math.round(a.adrSum / a.adrCount) : 0,
      maps_played: a.maps,
      hs_pct:      a.kills ? Math.round((a.headshots / a.kills) * 100) : null,
      multikills:  a.multikills || null,
      first_kills: a.firstKills || null,
    };
  });
  return profiles;
}

function normPlayerNameFE(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── GRID QUERIES ──────────────────────────────────────────────────────────
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

// ── SCORE HELPERS ─────────────────────────────────────────────────────────
function extractMapScore(match) {
  const t1 = match.opponents?.[0]?.opponent;
  const t2 = match.opponents?.[1]?.opponent;
  let t1Maps = 0, t2Maps = 0;
  if (match.results?.length) {
    match.results.forEach(r => {
      if (r.team_id === t1?.id)      t1Maps = r.score;
      else if (r.team_id === t2?.id) t2Maps = r.score;
    });
  }
  if (t1Maps === 0 && t2Maps === 0 && match.games?.length) {
    match.games.forEach(g => {
      if (!g.winner) return;
      if (g.winner.id === t1?.id) t1Maps++;
      else if (g.winner.id === t2?.id) t2Maps++;
    });
  }
  return { t1Maps, t2Maps };
}

function extractRoundScore(game, t1Id, t2Id) {
  let r1 = 0, r2 = 0;
  if (game.teams?.length) {
    game.teams.forEach(t => {
      const tid   = t.team?.id ?? t.team_id ?? t.id;
      const score = t.score ?? t.team_score ?? 0;
      if (tid === t1Id)      r1 = Math.max(r1, score);
      else if (tid === t2Id) r2 = Math.max(r2, score);
    });
  }
  if (game.results?.length) {
    game.results.forEach(r => {
      const tid   = r.team_id ?? r.team?.id;
      const score = r.score ?? 0;
      if (tid === t1Id)      r1 = Math.max(r1, score);
      else if (tid === t2Id) r2 = Math.max(r2, score);
    });
  }
  return { r1, r2 };
}

function extractPicksInOrder(match) {
  const picks = (match.pick_bans || [])
    .filter(pb => pb.is_pick)
    .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));
  return picks.map(pb => ({
    teamId:   pb.team?.id   ?? null,
    teamName: pb.team?.name ?? null,
  }));
}

// ── UI HELPERS ────────────────────────────────────────────────────────────
function swePill(info, align = 'left') {
  if (!info) return '';
  const cls  = info.isFull ? 'full' : info.count >= 3 ? 'majority' : 'partial';
  const text = info.isFull ? '🇸🇪 Full Squad' : '🇸🇪 ' + info.count + '/5 Swedish';
  return `<span class="swe-pill ${cls}" style="${align==='right'?'align-self:flex-end':''}">${text}</span>`;
}

function sweCountBadge(team, cls = '') {
  const info = team ? sweInfo(team) : null;
  if (!info || !info.count) return '';
  return `<span class="font-label-caps text-label-caps text-swedish-gold/90 bg-swedish-gold/10 px-1.5 py-0.5 rounded shrink-0 ${cls}">${info.count}/5 SWE</span>`;
}

// ── LOGO CACHE ────────────────────────────────────────────────────────────
const _logoCacheKey = 'swe_logos';
let _logoCache = null;
function _getLogoCache() {
  if (_logoCache) return _logoCache;
  try { _logoCache = JSON.parse(localStorage.getItem(_logoCacheKey) || '{}'); }
  catch(_) { _logoCache = {}; }
  return _logoCache;
}
function _saveLogoCache() {
  try { localStorage.setItem(_logoCacheKey, JSON.stringify(_logoCache)); } catch(_) {}
}
function cacheLogoFromTeam(t) {
  if (!t?.id) return;
  const url = t.image_url || t.logoUrl;
  if (!url) return;
  const cache = _getLogoCache();
  if (cache[t.id] !== url) { cache[t.id] = url; _saveLogoCache(); }
}

function teamLogo(t, cls = 'team-logo') {
  const cache = _getLogoCache();
  const url   = t?.image_url || t?.logoUrl || (t?.id && cache[t.id]) || null;
  const name  = t?.name || '?';
  if (t?.id && (t.image_url || t.logoUrl)) cacheLogoFromTeam(t);
  if (url)
    return `<img class="${cls}" src="${url}" alt="${name}" loading="lazy" onerror="this.style.display='none'" />`;
  return `<div class="${cls}-ph">${name[0].toUpperCase()}</div>`;
}

function formatMapName(raw) {
  if (!raw) return null;
  return raw.replace(/^de_|^cs_/i, '').toUpperCase();
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0))).join('');
}

// ── SHARE BUTTON ──────────────────────────────────────────────────────────
function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  const btn  = document.getElementById('mobile-menu-btn');
  if (!menu) return;
  const isOpen = !menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!isOpen));
    const icon = btn.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = isOpen ? 'menu' : 'close';
  }
}

async function sharePage(title) {
  const url = window.location.href;
  if (navigator.share) {
    try { await navigator.share({ title: title || document.title, url }); return; } catch(_) { /* user cancelled, ignore */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    _flashShareToast();
  } catch(_) {}
}

function _flashShareToast() {
  let el = document.getElementById('share-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'share-toast';
    el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-deep-navy border border-swedish-gold text-on-surface font-metadata text-metadata px-4 py-2 rounded-full z-[100] shadow-lg transition-opacity duration-300';
    document.body.appendChild(el);
  }
  el.textContent = 'Link copied to clipboard';
  el.style.opacity = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

function orderBySwedish(t1, t2) {
  const t1swe = !!sweInfo(t1);
  const t2swe = !!sweInfo(t2);
  if (t2swe && !t1swe) return [t2, t1];
  return [t1, t2];
}

// ── VALVE REGIONAL STANDINGS ─────────────────────────────────────────────
const VALVE_REPO_API   = 'https://api.github.com/repos/ValveSoftware/counter-strike_regional_standings/contents';
const VALVE_CACHE_TTL  = 24 * 60 * 60 * 1000;

function _valveCacheKey(region, dateStr) {
  return `valve_standings_${region}_${dateStr || 'latest'}`;
}

async function listValveStandingsDates(region = 'global', years = null) {
  const cacheKey = `valve_dates_${region}`;
  const cached = cacheGet(cacheKey, VALVE_CACHE_TTL);
  if (cached) return cached;

  const yearList = years || [new Date().getFullYear(), new Date().getFullYear() - 1];
  const all = [];
  for (const year of yearList) {
    try {
      const res = await fetch(`${VALVE_REPO_API}/live/${year}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) continue;
      const files = await res.json();
      if (!Array.isArray(files)) continue;
      files.forEach(f => {
        const m = f.name.match(new RegExp(`^standings_${region}_(\\d{4}_\\d{2}_\\d{2})\\.md$`));
        if (m) all.push({ date: m[1], name: f.name, download_url: f.download_url });
      });
    } catch(_) { /* ignore a missing/unreachable year directory */ }
  }
  all.sort((a, b) => b.date.localeCompare(a.date));
  if (all.length) cacheSet(cacheKey, all);
  return all;
}

function _parseValveStandingsMarkdown(md) {
  const rows = [];
  md.split('\n').forEach(line => {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(-?\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (!m) return;
    rows.push({
      rank:   parseInt(m[1], 10),
      points: parseInt(m[2], 10),
      name:   m[3].trim(),
      roster: m[4].split(',').map(s => s.trim()).filter(Boolean),
    });
  });
  return rows;
}

async function fetchValveStandings(region = 'global', dateStr = null) {
  const key = _valveCacheKey(region, dateStr);
  const cached = cacheGet(key, VALVE_CACHE_TTL);
  if (cached) return cached;

  try {
    const dates = await listValveStandingsDates(region);
    if (!dates.length) return [];
    const entry = dateStr ? dates.find(d => d.date === dateStr) : dates[0];
    if (!entry) return [];
    const res = await fetch(entry.download_url);
    if (!res.ok) return [];
    const md = await res.text();
    const parsed = _parseValveStandingsMarkdown(md);
    cacheSet(key, parsed);
    return parsed;
  } catch(e) {
    console.warn('[VALVE] Failed to fetch standings:', e);
    return [];
  }
}

function findValveRank(list, teamName) {
  const target = normName(teamName);
  if (!target || !list.length) return null;
  return list.find(t => normName(t.name) === target) || null;
}

function teamLocationBadge(team) {
  if (!team?.location) return '';
  const code = team.location.toUpperCase();
  const flag = countryFlag(code);
  return `<span class="location-badge">${flag} ${code}</span>`;
}

function computeSwedishValveRanks(teams, valveGlobal) {
  const withRank = teams.map(t => ({ t, rank: findValveRank(valveGlobal, t.name)?.rank ?? null }));
  withRank.sort((a, b) => {
    if (a.rank === null && b.rank === null) return 0;
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  });
  const map = {};
  let counter = 0;
  withRank.forEach(({ t, rank }) => { if (rank !== null) { counter++; map[t.id] = counter; } });
  return map;
}

function _looksLikeMatchupLabel(name, match) {
  if (/\bvs\.?\b/i.test(name)) return true;
  const t1 = match.opponents?.[0]?.opponent?.name;
  const t2 = match.opponents?.[1]?.opponent?.name;
  return (t1 && name.includes(t1)) || (t2 && name.includes(t2));
}

function matchContext(match) {
  const league = match.league?.name || null;
  const serie  = match.serie?.full_name || match.serie?.name || null;
  const tourn  = match.tournament?.name || null;
  const stage  = (match.name && match.name !== tourn && !_looksLikeMatchupLabel(match.name, match)) ? match.name : null;

  const parts = [];
  if (league) parts.push(league);
  if (serie && serie !== league) parts.push(serie);
  if (tourn && tourn !== serie && tourn !== league) parts.push(tourn);
  const label = parts.join(' – ') || 'CS2';
  return stage ? `${label} · ${stage}` : label;
}

// PandaScore's match objects already carry a full nested `tournament`
// object (tier, prizepool, etc.) by default — no extra `include=` needed —
// so this is a zero-extra-request, zero-extra-KV-write addition. Verify
// `tier`/`prizepool` are actually populated on your account's response
// shape before relying on this (pull one cached match and check), since
// field presence in nested includes can vary by plan.
function tournamentBadge(match) {
  const t = match?.tournament;
  if (!t) return '';
  const tierClass = {
    s: 'bg-swedish-gold text-deep-navy',
    a: 'bg-blue-500/20 text-blue-300',
  }[String(t.tier || '').toLowerCase()] || 'bg-outline-variant/20 text-on-surface-variant';

  const tierBadge = t.tier
    ? `<span class="font-label-caps text-label-caps px-1.5 py-0.5 rounded uppercase ${tierClass}">${t.tier}-Tier</span>`
    : '';
  const prizeLine = t.prizepool
    ? `<span class="font-metadata text-metadata text-on-surface-variant">🏆 ${t.prizepool}</span>`
    : '';
  if (!tierBadge && !prizeLine) return '';
  return `<span class="flex items-center gap-2 justify-center flex-wrap">${tierBadge}${prizeLine}</span>`;
}

// Head-to-head record between two specific teams, computed entirely from
// match history already cached client-side (ensureMatchHistory()) — no
// extra network request, no worker/KV involvement at all.
function headToHead(matches, teamAId, teamBId) {
  if (!teamAId || !teamBId) return null;
  let winsA = 0, winsB = 0;
  const relevant = (matches || []).filter(m => {
    const ids = [m.opponents?.[0]?.opponent?.id, m.opponents?.[1]?.opponent?.id];
    return ids.includes(teamAId) && ids.includes(teamBId);
  });
  relevant.forEach(m => {
    if (m.winner?.id === teamAId) winsA++;
    else if (m.winner?.id === teamBId) winsB++;
  });
  if (!relevant.length) return null;
  return { played: relevant.length, winsA, winsB };
}

function headToHeadLine(matches, teamA, teamB) {
  const h2h = headToHead(matches, teamA?.id, teamB?.id);
  if (!h2h) return '';
  return `<span class="font-metadata text-metadata text-on-surface-variant">H2H: ${teamA?.name || 'A'} ${h2h.winsA}-${h2h.winsB} ${teamB?.name || 'B'}</span>`;
}