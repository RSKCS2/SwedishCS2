/**
 * shared.js — Hybrid PandaScore + GRID helpers
 *
 * PandaScore → detects Swedish players/teams by nationality
 * GRID       → provides live round scores and map names
 */
const WORKER_URL = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';

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
  if (json.errors?.length) {
    console.warn('[GRID] errors:', json.errors.map(e => e.message).join(', '));
    // Don't throw — partial data is still useful
  }
  return json.data;
}

// ── SWEDISH PLAYER DATA (PandaScore) ──────────────────────────────────────
let _sweTeamData = {};
let _sweLoaded   = false;

async function ensureSwedishData() {
  if (_sweLoaded) return;
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
  } catch (e) { console.warn('[SWE] Failed to load Swedish player data:', e); }
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
        teams { name score }
      }
    }
  }
`;

// ── TEAM NAME MATCHING ────────────────────────────────────────────────────
// Normalize team names for fuzzy matching between PandaScore and GRID
function normName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/esports?|gaming|team\s|\.|\s/g, '')
    .trim();
}

function findGridSeries(pandaTeam1Name, pandaTeam2Name, gridSeriesList) {
  const n1 = normName(pandaTeam1Name);
  const n2 = normName(pandaTeam2Name);
  return gridSeriesList.find(s => {
    const gn = s.teams?.map(t => normName(t.baseInfo?.name)) || [];
    return (gn.some(n => n === n1 || n.includes(n1) || n1.includes(n)) &&
            gn.some(n => n === n2 || n.includes(n2) || n2.includes(n)));
  }) || null;
}

// ── MAP SCORE FROM PANDASCORE ─────────────────────────────────────────────
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
  return { t1Maps, t2Maps };
}

// ── UI HELPERS ────────────────────────────────────────────────────────────
function swePill(info, align = 'left') {
  if (!info) return '';
  const cls  = info.isFull ? 'full' : 'partial';
  const text = info.isFull ? '🇸🇪 Full squad' : '🇸🇪 ' + info.count + '/5 Swedish';
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
