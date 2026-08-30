# 🇸🇪 SweCS2

**Live site:** https://rskcs2.github.io/SwedishCS2

A try at an all in one place for follwing Swedish Counter-Strike 2 in Esports.

---

## Features

- Live scores and upcoming matches for Swedish teams or Swedish players in international teams.
- Match history with Win/Loss record
- Team rankings, regional and world
- Player stats
- Latest Swedish CS2 Esport news by Fragbite
- API usage is PandaScore and GRID Esports

## Project structure

```
├── index.html          # Live Scores
├── history.html         # Results / match history
├── teams.html            # Team rankings
├── players.html          # Player stats
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

## Contributing

This is a small, one-person hobby project so far, and I'd genuinely like help — with the frontend, new stat views, data-source reliability, whatever. A few ways to get involved:

- **Open an Issue** for bugs, ideas, or anything that looks broken — this is the easiest way to flag something even if you don't want to write code
- **Pull requests are welcome** — fork the repo, branch off, and open a PR describing the change. For anything bigger than a small fix, opening an Issue or Discussion first is a good way to make sure the approach makes sense before investing time in it

If you'd rather reach out directly first, the contact address already listed on the site (`contact@rskcs2.github.io`) works too.

## License

PolyForm Noncommercial 1.0.0 — you're free to use, fork, modify, and contribute to this code for any noncommercial purpose. Using it (or a derivative of it) to make money isn't permitted without the licensor's separate agreement.

## Disclaimer

Match data may occasionally be delayed or incomplete — nothing on this site should be used for betting or wagering decisions.

This site is provided for informational purposes only and is not affiliated with Valve, PandaScore, GRID, or any team, player, league, or organizer referenced on it. All team names, player names, and logos belong to their respective owners. See [Terms of Service](https://rskcs2.github.io/SwedishCS2/terms) and [Privacy Policy](https://rskcs2.github.io/SwedishCS2/privacy) for details.