/**
 * shared.js — Hybrid PandaScore + GRID, with localStorage caching
 *
 * Cache keys:
 *   swe_players        Swedish team data (1 hour TTL)
 *   swe_live           Live+upcoming matches (30s / 5min TTL)
 *   swe_history        Accumulated past matches (grows forever, never deleted)
 */
const WORKER_URL = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';

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
  const res = await fetch(WORKER_URL + path);
  if (!res.ok) throw Object.assign(new Error('PandaScore error'), { status: res.status });
  return res.json();
}

// ── GRID GRAPHQL ──────────────────────────────────────────────────────────
async function gridFetch(endpoint, query, variables = {}) {
  const res = await fetch(WORKER_URL + endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw Object.assign(new Error('GRID error'), { status: res.status });
  const json = await res.json();
  if (json.errors?.length) console.warn('[GRID] errors:', json.errors.map(e => e.message).join(', '));
  return json.data;
}

// ── SWEDISH PLAYER DATA ───────────────────────────────────────────────────
let _sweTeamData = {};
let _sweLoaded   = false;

async function ensureSwedishData() {
  if (_sweLoaded) return;

  // Try cache first (1 hour TTL)
  const cached = cacheGet('swe_players', 60 * 60 * 1000);
  if (cached) { _sweTeamData = cached; _sweLoaded = true; return; }

  try {
    _sweTeamData = {};
    let page = 1;
    while (true) {
      const players = await pandaFetch(`/csgo/players?filter[nationality]=SE&per_page=100&page=${page}`);
      if (!players.length) break;
      players.forEach(p => {
        const tid = p.current_team?.id;
        if (!tid) return;
        if (!_sweTeamData[tid]) _sweTeamData[tid] = { count: 0, isFull: false, name: p.current_team?.name };
        _sweTeamData[tid].count++;
      });
      if (players.length < 100) break;
      page++;
    }
    Object.values(_sweTeamData).forEach(d => { d.isFull = d.count >= 5; });
    cacheSet('swe_players', _sweTeamData);
  } catch(e) { console.warn('[SWE] Failed to load Swedish player data:', e); }
  _sweLoaded = true;
}

function sweInfo(team) {
  return (team && _sweTeamData[team.id]) ? _sweTeamData[team.id] : null;
}

function hasSweTeam(match) {
  return !!(sweInfo(match.opponents?.[0]?.opponent) || sweInfo(match.opponents?.[1]?.opponent));
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
  const text = info.isFull ? '🇸🇪 Fullt lag' : '🇸🇪 ' + info.count + '/5 svenska';
  return `<span class="swe-pill ${cls}" style="${align==='right'?'align-self:flex-end':''}">${text}</span>`;
}

function teamLogo(t, cls = 'team-logo') {
  const url  = t?.image_url || t?.logoUrl;
  const name = t?.name || '?';
  if (url)
    return `<img class="${cls}" src="${url}" alt="${name}" onerror="this.style.display='none'" />`;
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

const REGION_MAP = {
  SE:'EU',DK:'EU',NO:'EU',FI:'EU',DE:'EU',FR:'EU',NL:'EU',BE:'EU',PL:'EU',GB:'EU',
  US:'NA',CA:'NA',MX:'NA',BR:'SA',AR:'SA',CL:'SA',
  CN:'APAC',KR:'APAC',AU:'APAC',JP:'APAC',RU:'CIS',UA:'CIS',KZ:'CIS',
};

function teamLocationBadge(team) {
  if (!team?.location) return '';
  const flag   = countryFlag(team.location);
  const region = REGION_MAP[team.location.toUpperCase()] || team.location.toUpperCase();
  return `<span class="location-badge">${flag} ${region}</span>`;
}
