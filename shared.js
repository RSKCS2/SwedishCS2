/**
 * shared.js — config shared by index.html and history.html
 *
 * After deploying your Cloudflare Worker, paste its URL below.
 */

// ← Replace with your Cloudflare Worker URL after deploying
const WORKER_URL = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';

/**
 * Fetch from PandaScore via the Worker proxy.
 * path example: '/csgo/matches/running?per_page=50&include=games,opponents'
 */
async function pandaFetch(path) {
  const res = await fetch(WORKER_URL + path);
  if (!res.ok) throw Object.assign(new Error('API error'), { status: res.status });
  return res.json();
}

/**
 * Swedish player team lookup.
 * teamId -> { count: number, isFull: boolean }
 * Populated once per page load, shared across both pages if loaded together.
 */
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

/**
 * Extract final map score from a finished or live match.
 * Uses match.results first (authoritative), falls back to counting game winners.
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
 * Render a Swedish player count pill badge.
 */
function swePill(info, align = 'left') {
  if (!info) return '';
  const cls  = info.isFull ? 'full' : 'partial';
  const text = info.isFull ? '🇸🇪 Full squad (5/5)' : `🇸🇪 ${info.count}/5 Swedish`;
  return `<span class="swe-pill ${cls}" style="${align==='right'?'align-self:flex-end':''}">${text}</span>`;
}

/**
 * Team logo or placeholder initials.
 */
function teamLogo(t, cls = 'team-logo') {
  if (t?.image_url) {
    return `<img class="${cls}" src="${t.image_url}" alt="${t.name||''}" onerror="this.style.display='none'" />`;
  }
  return `<div class="${cls}-ph">${(t?.name||'?')[0].toUpperCase()}</div>`;
}
