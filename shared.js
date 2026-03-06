/**
 * shared.js — GRID API helpers shared by index.html and history.html
 */
const WORKER_URL = 'https://floral-moon-0400.epicminecraftboy12.workers.dev';

// ── GRID GraphQL fetch ────────────────────────────────────────────────────
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

// ── SWEDISH TEAM LIST ─────────────────────────────────────────────────────
// Add or remove teams here as the Swedish scene changes.
const SWEDISH_TEAM_NAMES = new Set([
  'ninjas in pyjamas', 'nip',
  'fnatic',
  'eyeballers',
  'lilmix',
  'godsent',
  'alliance',
  'team finest',
  'anonymo esports', 'anonymo',
  'sashi esport', 'sashi',
  'havu gaming', 'havu',
  'wolves esports',
  'nordic esports',
]);

function isSwedishTeam(teamName) {
  if (!teamName) return false;
  return SWEDISH_TEAM_NAMES.has(teamName.toLowerCase().trim());
}

function hasSweTeam(series) {
  return series.teams?.some(t => isSwedishTeam(t.baseInfo?.name));
}

function sweInfo(teamName) {
  return isSwedishTeam(teamName) ? { isFull: true } : null;
}

// ── GRAPHQL QUERIES ───────────────────────────────────────────────────────
const QUERY_LIVE_SERIES = `
  query LiveAndUpcoming($to: String) {
    allSeries(
      filter: {
        titleId: 3,
        scheduledBefore: $to
      }
      first: 50
      orderBy: { field: SCHEDULED_START_TIME, order: ASC }
    ) {
      edges {
        node {
          id
          startTimeScheduled
          format { type }
          tournament { id name }
          teams {
            baseInfo { id name logoUrl }
            score
          }
          games {
            id
            sequenceNumber
            started
            finished
            map { name }
          }
        }
      }
    }
  }
`;

// NOTE: titleId 3 is CS2 on GRID. If matches aren't showing, check your
// GRID data portal for the correct titleId and update the query above.

const QUERY_SERIES_STATE = `
  query SeriesState($id: ID!) {
    seriesState(id: $id) {
      id
      started
      finished
      teams { id score }
      games {
        sequenceNumber
        started
        finished
        map { name }
        teams {
          id
          side
          score
        }
      }
    }
  }
`;

const QUERY_PAST_SERIES = `
  query PastSeries($page: Int) {
    allSeries(
      filter: { titleIds: [3], status: [FINISHED] }
      first: 50
      page: $page
      orderBy: { field: SCHEDULED_START_TIME, order: DESC }
    ) {
      totalCount
      edges {
        node {
          id
          startTimeScheduled
          format { type }
          tournament { id name }
          teams {
            baseInfo { id name logoUrl }
            score
          }
          games {
            id
            sequenceNumber
            started
            finished
            map { name }
          }
        }
      }
    }
  }
`;

// ── UI HELPERS ────────────────────────────────────────────────────────────
function swePill(isSwe, align = 'left') {
  if (!isSwe) return '';
  return `<span class="swe-pill full" style="${align==='right'?'align-self:flex-end':''}">🇸🇪 Swedish</span>`;
}

function teamLogo(team, cls = 'team-logo') {
  const url  = team?.logoUrl || team?.baseInfo?.logoUrl;
  const name = team?.name    || team?.baseInfo?.name || '?';
  if (url)
    return `<img class="${cls}" src="${url}" alt="${name}" onerror="this.style.display='none'" />`;
  return `<div class="${cls}-ph">${name[0].toUpperCase()}</div>`;
}

function formatMapName(raw) {
  if (!raw) return null;
  return raw.replace(/^de_|^cs_/i, '').toUpperCase();
}

function seriesFormat(series) {
  const t = series.format?.type || '';
  const m = t.match(/\d+/);
  return m ? `BO${m[0]}` : 'BO?';
}
