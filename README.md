# SweCS2 🇸🇪

A fan-run, non-commercial tracker for Swedish Counter-Strike 2 teams, players, and matches — live scores, results history, regional/world rankings, and player stats, all in one place.

**Live site:** https://rskcs2.github.io/SwedishCS2

> SweCS2 is not affiliated with, endorsed by, or connected to Valve, PandaScore, GRID, or any of the teams/players/leagues referenced on the site.

---

## Features

- **Live Scores** — running and upcoming matches for Swedish teams
- **Results** — match history with W/L record and recent form
- **Teams** — Swedish rosters ranked against Valve's Regional Standings (Europe / Americas / Asia) and World rank, with medal styling for the top 3
- **Players** — individual stats (K/D, ADR, maps played, HS%, multi-kills where available) and a Top 3 podium
- **News** — latest CS2 headlines pulled from Fragbite
- A dark, gold-and-navy theme with a bit of Swedish flag styling throughout

## Tech stack

**Frontend** — plain HTML + vanilla JS, no build step or framework:
- `index.html`, `history.html`, `teams.html`, `players.html`, `terms.html`, `privacy.html`
- `shared.js` — all fetching/rendering logic shared across pages
- `theme.css` + `tailwind-config.js` — design tokens, loaded via the Tailwind CDN build

**Backend** — a Cloudflare Worker that does all the heavy lifting so the frontend only ever talks to one small, cached API:
- Scheduled (cron) handler pulls match/roster/stat data from **PandaScore** (primary) and **GRID** (fallback + supplemental stats), merges it, and writes it to **Cloudflare KV**
- **Cloudflare Turnstile** gates the API behind a short-lived session token, so only real browsers on the site's own origin can hit it
- Careful KV write-budgeting to stay under Cloudflare's free-tier caps (1,000 writes/day) — heavy tasks (team metadata, history rotation, player-stats processing) are spread across separate tick offsets instead of running every 3 minutes

## How it works

1. A cron trigger fires the Worker's `scheduled()` handler every 3 minutes.
2. Every tick refreshes live scores and upcoming matches (PandaScore, falling back to GRID by team name/nationality if PandaScore is unavailable).
3. Every 8th tick ("metadata tick") also refreshes team rosters and rotates through one Swedish team's match history.
4. A separate, offset "stats tick" processes a queue of finished games to pull per-player stats, so it doesn't compete with the metadata tick for the same request budget.
5. Everything gets cached in KV; the frontend just reads the cache through a handful of `/csgo/*` endpoints, so page loads never wait on PandaScore/GRID directly.

## Project structure

```
├── index.html          # Live Scores
├── history.html         # Results / match history
├── teams.html            # Team rankings
├── players.html          # Player stats
├── terms.html / privacy.html
├── favicon.svg
├── shared.js             # shared data + rendering logic
├── theme.css              # hand-written rules on top of Tailwind
├── tailwind-config.js     # design tokens (colors, spacing, type scale)
├── tailwind-built.css     # purged Tailwind build used by some pages
└── worker/                # Cloudflare Worker backend (API + scheduled data pipeline)
```

## Data sources

- [PandaScore](https://pandascore.co/) — primary source for matches, rosters, and stats
- [GRID](https://grid.gg/) — fallback source and supplemental per-map stats
- [Valve's Regional Standings](https://github.com/ValveSoftware/counter-strike_regional_standings) — official regional/world rank data
- [Fragbite](https://fragbite.se/) — CS news via RSS

Match data may occasionally be delayed or incomplete — nothing on this site should be used for betting or wagering decisions.

## Local development

**Frontend** — no build step needed. Serve the folder with any static server, e.g.:
```bash
npx serve .
```
If you're pointing at your own Worker deployment instead of the production API, update the base URL used in `shared.js`.

**Backend** — deployed with [Wrangler](https://developers.cloudflare.com/workers/wrangler/):
1. Create a KV namespace and bind it as `MATCH_DATA` in `wrangler.toml`
2. Set secrets: `PANDASCORE_TOKEN`, `GRID_TOKEN`, `WORKER_SECRET`, `TURNSTILE_SECRET`
3. Set the cron trigger to `*/3 * * * *`
4. `wrangler deploy`

## Contributing

This is a small, one-person hobby project so far, and I'd genuinely like help — with the frontend, new stat views, data-source reliability, whatever. A few ways to get involved:

- **Open an Issue** for bugs, ideas, or anything that looks broken — this is the easiest way to flag something even if you don't want to write code
- **Turn on GitHub Discussions** for this repo (repo → Settings → Features → Discussions) — that gives people a low-friction place to say "I'd like to help with X" or ask questions before diving into a PR, without needing anyone's personal contact info
- **Pull requests are welcome** — fork the repo, branch off, and open a PR describing the change. For anything bigger than a small fix, opening an Issue or Discussion first is a good way to make sure the approach makes sense before investing time in it
- Labeling a few open Issues `good first issue` or `help wanted` once you know what needs doing makes it much easier for new contributors to find something to pick up

If you'd rather reach out directly first, the contact address already listed on the site (`contact@rskcs2.github.io`) works too.

## License

No license has been chosen yet — until one is added, all rights are reserved by default. If you want outside contributions, adding a permissive license (e.g. MIT) is worth doing early, since it tells contributors up front what they're agreeing to.

## Disclaimer

This site is provided for informational purposes only and is not affiliated with Valve, PandaScore, GRID, or any team, player, league, or organizer referenced on it. All team names, player names, and logos belong to their respective owners. See [Terms of Service](https://rskcs2.github.io/SwedishCS2/terms) and [Privacy Policy](https://rskcs2.github.io/SwedishCS2/privacy) for details.
