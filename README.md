# SweCS2 🇸🇪

A fan-run, non-commercial tracker for Swedish Counter-Strike 2 teams, players, and matches — live scores, results history, regional/world rankings, and player stats, all in one place.

**Live site:** https://rskcs2.github.io/SwedishCS2

> SweCS2 is not affiliated with, endorsed by, or connected to Valve, PandaScore, GRID, or any of the teams/players/leagues referenced on the site.

---

## Features

- Live scores and upcoming matches for Swedish teams
- Match history with W/L record
- Team rankings, regional and world
- Player stats
- Latest CS2 news

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
