/**
 * shared.js — config shared by index.html and history.html
 * ← Replace the URL below with your Cloudflare Worker URL
 */
const WORKER_URL = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';

async function pandaFetch(path) {
  const res = await fetch(WORKER_URL + path);
  if (!res.ok) throw Object.assign(new Error('API error'), { status: res.status });
  return res.json();
}

// ── SWEDISH PLAYER DATA ───────────────────────────────────────────────────
let _sweTeamData = {};
let _sweLoaded   = false;

async function ensureSwedishData() {
  if (_sweLoaded) return;
  try {
    const players = await pandaFetch('/csgo/players?filter[nationality]=SE&per_page=100');
    _sweTeamData = {};
    players.forEach(p => {
      const tid = p.current_team?.id;
      if (!tid) return;
      if (!_sweTeamData[tid]) _sweTeamData[tid] = { count: 0, isFull: false };
      _sweTeamData[tid].count++;
    });
    Object.values(_sweTeamData).forEach(d => { d.isFull = d.count >= 5; });
  } catch (_) { /* non-fatal */ }
  _sweLoaded = true;
}

function sweInfo(team) {
  return (team && _sweTeamData[team.id]) ? _sweTeamData[team.id] : null;
}

function hasSweTeam(match) {
  const t1 = match.opponents?.[0]?.opponent;
  const t2 = match.opponents?.[1]?.opponent;
  return !!(sweInfo(t1) || sweInfo(t2));
}

// ── SCORE EXTRACTION ──────────────────────────────────────────────────────
/**
 * Extract final MAP score (how many maps each team won).
 * Uses match.results first, falls back to counting game winners.
 */
function extractMapScore(match) {
  const t1 = match.opponents?.[0]?.opponent;
  const t2 = match.opponents?.[1]?.opponent;
  let t1Maps = 0, t2Maps = 0;

  if (match.results?.length) {
    match.results.forEach(r => {
      if (r.team_id === t1?.id) t1Maps = r.score;
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

/**
 * Extract ROUND score for a single game (map).
 *
 * PandaScore puts live scores in different places depending on API version:
 *  - game.teams[].score           (most common for live)
 *  - game.teams[].team_score
 *  - game.results[].score         (finished maps, sometimes live too)
 *  - game.players grouped by team (rare fallback)
 */
function extractRoundScore(game, t1Id, t2Id) {
  let r1 = 0, r2 = 0;

  // 1. game.teams — PandaScore live scores
  // Shape A: [{team: {id}, score: N}]
  // Shape B: [{team_id: N, score: N}]
  if (game.teams?.length) {
    game.teams.forEach(t => {
      const tid   = t.team?.id ?? t.team_id ?? t.id;
      const score = t.score ?? t.team_score ?? t.kills ?? 0;
      if (tid === t1Id)      r1 = Math.max(r1, score);
      else if (tid === t2Id) r2 = Math.max(r2, score);
    });
  }

  // 2. game.results — authoritative for finished, sometimes populated live too
  if (game.results?.length) {
    game.results.forEach(r => {
      const tid   = r.team_id ?? r.team?.id;
      const score = r.score ?? 0;
      if (tid === t1Id)      r1 = Math.max(r1, score);
      else if (tid === t2Id) r2 = Math.max(r2, score);
    });
  }

  // 3. game.score flat object {home, away} or {blue, orange} — last resort
  if (r1 === 0 && r2 === 0 && game.score && typeof game.score === 'object') {
    const vals = Object.values(game.score).filter(v => typeof v === 'number');
    if (vals.length >= 2) { r1 = vals[0]; r2 = vals[1]; }
  }

  // 4. game.rounds_score — used by /csgo/games/running
  // Shape: [{team_id, score}] or [{team: {id}, score}]
  if (r1 === 0 && r2 === 0 && game.rounds_score?.length) {
    game.rounds_score.forEach(rs => {
      const tid   = rs.team_id ?? rs.team?.id;
      const score = rs.score ?? 0;
      if (tid === t1Id)      r1 = Math.max(r1, score);
      else if (tid === t2Id) r2 = Math.max(r2, score);
    });
  }

  return { r1, r2 };
}

// ── TEAM LOCATION / FLAG ──────────────────────────────────────────────────
/**
 * Convert a 2-letter ISO country code to a flag emoji.
 * e.g. "SE" → 🇸🇪,  "FR" → 🇫🇷
 */
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  return [...code.toUpperCase()]
    .map(c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0)))
    .join('');
}

/**
 * Map ISO country code → broad esports region label.
 */
const REGION_MAP = {
  // Europe
  SE:'EU', DK:'EU', NO:'EU', FI:'EU', DE:'EU', FR:'EU', NL:'EU', BE:'EU',
  PL:'EU', CZ:'EU', SK:'EU', HU:'EU', RO:'EU', BG:'EU', HR:'EU', RS:'EU',
  SI:'EU', AT:'EU', CH:'EU', ES:'EU', PT:'EU', IT:'EU', GR:'EU', GB:'EU',
  IE:'EU', LT:'EU', LV:'EU', EE:'EU', BY:'EU', MK:'EU', BA:'EU', ME:'EU',
  AL:'EU', XK:'EU', LU:'EU', MT:'EU', IS:'EU', CY:'EU',
  // CIS
  RU:'CIS', UA:'CIS', KZ:'CIS', BY:'CIS', GE:'CIS', AZ:'CIS', AM:'CIS',
  UZ:'CIS', KG:'CIS', TJ:'CIS', TM:'CIS', MD:'CIS',
  // North America
  US:'NA', CA:'NA', MX:'NA',
  // South America
  BR:'SA', AR:'SA', CL:'SA', CO:'SA', PE:'SA', VE:'SA', UY:'SA', EC:'SA',
  // Asia-Pacific
  CN:'APAC', KR:'APAC', JP:'APAC', AU:'APAC', NZ:'APAC', TW:'APAC',
  SG:'APAC', MY:'APAC', PH:'APAC', TH:'APAC', ID:'APAC', VN:'APAC',
  HK:'APAC', IN:'APAC', PK:'APAC',
  // Middle East / Africa
  IL:'MENA', TR:'MENA', SA:'MENA', AE:'MENA', EG:'MENA', ZA:'MENA',
  MA:'MENA', NG:'MENA',
};

function teamRegion(locationCode) {
  if (!locationCode) return '';
  return REGION_MAP[locationCode.toUpperCase()] || locationCode.toUpperCase();
}

/**
 * Render team location badge: flag emoji + region label.
 * e.g.  🇫🇷 EU
 */
function teamLocationBadge(team) {
  if (!team?.location) return '';
  const flag   = countryFlag(team.location);
  const region = teamRegion(team.location);
  return `<span class="location-badge">${flag} ${region}</span>`;
}

// ── UI HELPERS ────────────────────────────────────────────────────────────
function swePill(info, align = 'left') {
  if (!info) return '';
  const cls  = info.isFull ? 'full' : 'partial';
  const text = info.isFull ? '🇸🇪 Full squad (5/5)' : `🇸🇪 ${info.count}/5 Swedish`;
  return `<span class="swe-pill ${cls}" style="${align==='right'?'align-self:flex-end':''}">${text}</span>`;
}

function teamLogo(t, cls = 'team-logo') {
  if (t?.image_url)
    return `<img class="${cls}" src="${t.image_url}" alt="${t.name||''}" onerror="this.style.display='none'" />`;
  return `<div class="${cls}-ph">${(t?.name||'?')[0].toUpperCase()}</div>`;
}
