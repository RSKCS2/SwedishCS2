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

// ── SESSION TOKEN (replaces static X-Worker-Secret) ───────────────────────
// Flow: solve Turnstile once (invisible, no user interaction in normal cases)
// → exchange the Turnstile token for a short-lived signed session token at
// the Worker → reuse that session token on every poll until it expires.
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
    execution: 'execute', // don't run automatically, only when we call turnstile.execute()
    callback: (token) => { if (_turnstilePendingResolve) _turnstilePendingResolve(token); },
    'error-callback': () => { if (_turnstilePendingReject) _turnstilePendingReject(new Error('Turnstile verification failed')); },
    'timeout-callback': () => { if (_turnstilePendingReject) _turnstilePendingReject(new Error('Turnstile timed out')); },
  });
}

// turnstile.js loads with async/defer, so it can finish downloading after
// our own code has already started running. Poll briefly instead of
// assuming it is ready.
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

// Returns a valid session token, refreshing it (via Turnstile) only when
// the cached one is missing or close to expiry. Concurrent callers share
// the same in-flight exchange instead of triggering duplicate challenges.
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

// ── PANDASCORE REST ───────────────────────────────────────────────────────
async function pandaFetch(path) {
  const session = await getSessionToken();
  let res = await fetch(WORKER_URL + path, { headers: { 'X-Session-Token': session } });
  if (res.status === 401) {
    const fresh = await getSessionToken(true);
    res = await fetch(WORKER_URL + path, { headers: { 'X-Session-Token': fresh } });
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

  // Try cache first (1 hour TTL)
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
    Object.values(_sweTeamData).forEach(d => { d.isFull = d.count >= 5; });
    cacheSet('swe_players_v2', { teams: _sweTeamData, players: _swePlayers });
  } catch(e) { console.warn('[SWE] Failed to load Swedish player data:', e); }
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

// ── TEAM MATCH HISTORY (shared by history.html and teams.html) ────────────
async function ensureMatchHistory() {
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
      const pastList = await pandaFetch('/csgo/matches/past?per_page=100&include=opponents,results,games,winner');
      const fetched  = pastList.filter(m => m.opponents?.length === 2 && (sweInfo(m.opponents[0]?.opponent) || sweInfo(m.opponents[1]?.opponent)));
      const seen = new Set();
      matches = [...fetched, ...matches].filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      cacheSet(HISTORY_KEY, matches);
      localStorage.setItem(HISTORY_FETCH_KEY, Date.now().toString());
    } catch(e) { console.warn('[SWE] Failed to load match history:', e); }
  }
  return matches;
}

// Builds a per-Swedish-team profile (logo, recent form, N-month record) from
// cached/fetched match history. Used by teams.html and players.html.
// cutoffMonths controls the window used for wins3m/losses3m (default 3, kept
// for backwards compatibility with existing callers).
function buildTeamProfiles(matches, cutoffMonths = 3) {
  const profiles = {};
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - cutoffMonths);

  matches.forEach(m => {
    const t1 = m.opponents?.[0]?.opponent;
    const t2 = m.opponents?.[1]?.opponent;
    [[t1, t2], [t2, t1]].forEach(([self, opp]) => {
      if (!self?.id || !sweInfo(self)) return;
      if (!profiles[self.id]) {
        profiles[self.id] = { id: self.id, name: self.name, logo: self.image_url || null, matches: [], wins3m: 0, losses3m: 0 };
      }
      const p = profiles[self.id];
      if (self.image_url) p.logo = self.image_url;
      const { t1Maps, t2Maps } = extractMapScore(m);
      const selfMaps = self.id === t1?.id ? t1Maps : t2Maps;
      const oppMaps  = self.id === t1?.id ? t2Maps : t1Maps;
      const won = m.winner?.id === self.id;
      p.matches.push({ oppName: opp?.name || 'TBD', selfMaps, oppMaps, won, date: m.begin_at });
      if (new Date(m.begin_at) >= cutoff) { if (won) p.wins3m++; else p.losses3m++; }
    });
  });

  Object.values(profiles).forEach(p => p.matches.sort((a, b) => new Date(b.date) - new Date(a.date)));
  return profiles;
}

// Ranks team profiles by real recent form: 3-month win differential first,
// then total 3-month wins, then squad completeness, then name. Used by
// both teams.html and players.html so a player's rank always matches
// their team's rank on the Teams page.
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

// ── PICK/BAN HELPERS ──────────────────────────────────────────────────────
/**
 * Returns an array of picks in game order (index 0 = game 1, index 1 = game 2, …)
 * Each entry: { teamId, teamName } or null for deciders (no pick).
 */
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

// Small inline badge showing how many current Swedish players are on a
// team, e.g. "3/5 SWE". Returns '' for teams with no Swedish players.
function sweCountBadge(team, cls = '') {
  const info = team ? sweInfo(team) : null;
  if (!info || !info.count) return '';
  return `<span class="font-label-caps text-label-caps text-swedish-gold/90 bg-swedish-gold/10 px-1.5 py-0.5 rounded shrink-0 ${cls}">${info.count}/5 SWE</span>`;
}

// ── LOGO CACHE ────────────────────────────────────────────────────────────
// Persists team logo URLs in localStorage so images never need re-fetching info
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
  // Save to cache whenever we have a fresh url from API
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

// Orders two teams so the Swedish side renders on the left, unless both or
// neither team is Swedish (in which case the original order is kept).
function orderBySwedish(t1, t2) {
  const t1swe = !!sweInfo(t1);
  const t2swe = !!sweInfo(t2);
  if (t2swe && !t1swe) return [t2, t1];
  return [t1, t2];
}

// ── VALVE REGIONAL STANDINGS (world/EU rank source) ───────────────────────
// Reads Valve's own published CS2 Regional Standings from the GitHub repo
// so team rank badges reflect Valve's official numbers rather than our own
// derived win/loss form. Falls back gracefully (returns null / empty) if
// GitHub is unreachable — callers should treat a null rank as "unranked"
// rather than an error.
const VALVE_REPO_API   = 'https://api.github.com/repos/ValveSoftware/counter-strike_regional_standings/contents';
const VALVE_CACHE_TTL  = 24 * 60 * 60 * 1000; // Valve publishes on a roughly weekly cadence

function _valveCacheKey(region, dateStr) {
  return `valve_standings_${region}_${dateStr || 'latest'}`;
}

// Lists available snapshot files (e.g. standings_global_2026_08_03.md) for
// a region across the given years, newest first.
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
  all.sort((a, b) => b.date.localeCompare(a.date)); // newest first
  if (all.length) cacheSet(cacheKey, all);
  return all;
}

// Parses a Valve standings markdown table into [{ rank, points, name, roster }, …]
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

// Fetches (and caches) a specific dated snapshot, or the latest one if no
// date is given. Returns [] on any failure so callers can degrade quietly.
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

// Finds a team's entry in a Valve standings list by fuzzy name match
// (reuses the same normalization used for GRID team matching).
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

// Orders Swedish teams among themselves by their Valve world rank (lower
// number = better). Teams with no Valve entry sort last and receive no
// rank. Returns a map of teamId -> Swedish rank (1, 2, 3, …).
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

// Builds a readable "tournament / stage" label from a PandaScore match
// object, e.g. "ESL Pro League Season 21 · Semifinal" instead of a bare
// tournament name. Falls back gracefully as fields are missing.
function matchContext(match) {
  const league = match.league?.name || null;
  const serie  = match.serie?.full_name || match.serie?.name || null;
  const tourn  = match.tournament?.name || null;
  const stage  = (match.name && match.name !== tourn) ? match.name : null;

  const parts = [];
  if (league) parts.push(league);
  if (serie && serie !== league) parts.push(serie);
  if (tourn && tourn !== serie && tourn !== league) parts.push(tourn);
  const label = parts.join(' – ') || 'CS2';
  return stage ? `${label} · ${stage}` : label;
}
