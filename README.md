# Movie & Series Watchlist

Personal watchlist app on Cloudflare Pages + D1. See `watchlist-app-build-spec.md` for the full spec.

## Layout
- `public/` – static front end (plain HTML/CSS/JS)
- `functions/api/` – Pages Functions (API)
- `shared/titles.js` – shared TMDB/OMDb fetch + normalize logic (also used by the cron Worker)
- `migrations/` – D1 schema migrations

## Local dev
```sh
npm install
cp .dev.vars.example .dev.vars   # add TMDB_TOKEN and OMDB_KEY
npm run db:migrate:local
npm run dev                       # http://localhost:8788
```

## Deploy
Pages deploys from `main`. Secrets (`TMDB_TOKEN`, `OMDB_KEY`, `APP_PASSWORD`) are set in the Pages project.

## Access
The whole app (pages and `/api`) is behind a password login (`functions/_middleware.js`).
A signed, HttpOnly session cookie lasts 30 days. Changing `APP_PASSWORD` logs out every session.
Schema changes: add a migration file, then `npm run db:migrate:remote`.
