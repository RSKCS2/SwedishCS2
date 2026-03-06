/**
 * shared.js — GRID API helpers for SWE CS2 Tracker
 */
const WORKER_URL = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';

async function gridFetch(endpoint, query, variables = {}) {
  const res = await fetch(WORKER_URL + endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw Object.assign(new Error('API error'), { status: res.status });
  const json = await res.json();
  if (json.errors?.length) {
    console.error('[GRID] GraphQL errors:', json.errors);
    throw Object.assign(new Error(json.errors[0].message), { status: 400 });
  }
  return json.data;
}

// ── SWEDISH TEAM DETECTION ────────────────────────────────────────────────
const SWEDISH_TEAMS = new Set([
  'ninjas in pyjamas', 'nip', 'fnatic', 'eyeballers', 'lilmix',
  'godsent', 'alliance', 'team finest', 'anonymo esports', 'anonymo',
  'sashi esport', 'sashi', 'havu gaming', 'havu', 'wolves esports',
  'nordic esports',
]);

function isSwedishTeam(name) {
  return !!name && SWEDISH_TEAMS.has(name.toLowerCase().trim());
}

// ── GRAPHQL QUERIES ───────────────────────────────────────────────────────
// Correct field names per GRID docs:
//   teams.scoreAdvantage  (not score)
//   format.nameShortened  (not type/bestOf)
//   orderBy: StartTimeScheduled  (plain enum)
//   filter.startTimeScheduled: { gte, lte }  (date range)

const QUERY_LIVE_SERIES = `
  query LiveAndUpcoming($gte: String!, $lte: String!) {
    allSeries(
      filter: { startTimeScheduled: { gte: $gte, lte: $lte } }
      orderBy: StartTimeScheduled
      first: 100
    ) {
      edges {
        node {
          id
          startTimeScheduled
          title { nameShortened }
          tournament { id name }
          format { nameShortened }
          teams {
            baseInfo { id name logoUrl }
            scoreAdvantage
          }
          games {
            id
            sequenceNumber
            started
            finished
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
      teams {
        name
        won
      }
      games {
        sequenceNumber
        started
        finished
        teams {
          name
          score
        }
      }
    }
  }
`;

const QUERY_PAST_SERIES = `
  query PastSeries($gte: String!, $lte: String!) {
    allSeries(
      filter: { startTimeScheduled: { gte: $gte, lte: $lte } }
      orderBy: StartTimeScheduled
      first: 100
    ) {
      totalCount
      edges {
        node {
          id
          startTimeScheduled
          title { nameShortened }
          tournament { id name }
          format { nameShortened }
          teams {
            baseInfo { id name logoUrl }
            scoreAdvantage
          }
          games {
            id
            sequenceNumber
            started
            finished
          }
        }
      }
    }
  }
`;

// ── UI HELPERS ────────────────────────────────────────────────────────────
function swePill(isSwe, align = 'left') {
  if (!isSwe) return '';
  return `<span class="swe-pill full" style="${align === 'right' ? 'align-self:flex-end' : ''}">🇸🇪 Swedish</span>`;
}

function teamLogo(team, cls = 'team-logo') {
  const url  = team?.logoUrl;
  const name = team?.name || '?';
  if (url)
    return `<img class="${cls}" src="${url}" alt="${name}" onerror="this.style.display='none'" />`;
  return `<div class="${cls}-ph">${name[0].toUpperCase()}</div>`;
}

function formatMapName(raw) {
  if (!raw) return null;
  return raw.replace(/^de_|^cs_/i, '').toUpperCase();
}

function seriesFormat(series) {
  const n = series.format?.nameShortened || '';
  return n || 'BO?';
}
