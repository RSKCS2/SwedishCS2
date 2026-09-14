/**
 * hltv-normalizer.js
 * 
 * Converts HLTV response shapes to PandaScore-compatible schema
 * so the frontend (shared.js) needs zero changes.
 */

/**
 * Normalize HLTV team ranking to PandaScore format
 * HLTV: { points, place, team: {name, id}, change, isNew }
 * PandaScore: { id, name, image_url, rank, points, ... }
 */
export function normalizeHLTVRanking(hltvRanking) {
  if (!Array.isArray(hltvRanking)) return [];
  
  return hltvRanking.map(entry => ({
    id: entry.team?.id || null,
    name: entry.team?.name || null,
    image_url: null, // HLTV doesn't provide logos in ranking endpoint
    rank: entry.place || null,
    points: entry.points || 0,
    change: entry.change || 0,
    isNew: entry.isNew || false,
    _source: 'hltv',
  }));
}

/**
 * Normalize a single HLTV match to PandaScore format
 * Used for upcoming/past matches when available
 * 
 * HLTV match structure (approximate, based on docs):
 * { id, team1, team2, date, event, map, result, ... }
 * 
 * PandaScore match structure (what shared.js expects):
 * { id, begin_at, opponents, results, games, winner, tournament, ... }
 */
export function normalizeHLTVMatch(hltvMatch) {
  if (!hltvMatch) return null;
  
  const t1 = hltvMatch.team1 || {};
  const t2 = hltvMatch.team2 || {};
  
  return {
    id: `hltv_${hltvMatch.id}`,
    begin_at: hltvMatch.date ? new Date(hltvMatch.date).toISOString() : null,
    opponents: [
      {
        opponent: {
          id: `hltv_${t1.id}` || null,
          name: t1.name || 'TBD',
          image_url: t1.logo || null,
        }
      },
      {
        opponent: {
          id: `hltv_${t2.id}` || null,
          name: t2.name || 'TBD',
          image_url: t2.logo || null,
        }
      }
    ],
    results: [
      { team_id: `hltv_${t1.id}`, score: hltvMatch.result?.t1 || 0 },
      { team_id: `hltv_${t2.id}`, score: hltvMatch.result?.t2 || 0 },
    ],
    games: [],
    tournament: { name: hltvMatch.event?.name || 'HLTV' },
    _source: 'hltv',
  };
}

/**
 * Normalize HLTV matches array
 */
export function normalizeHLTVMatches(hltvMatches) {
  if (!Array.isArray(hltvMatches)) return [];
  return hltvMatches.map(m => normalizeHLTVMatch(m)).filter(Boolean);
}
