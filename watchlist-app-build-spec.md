# Build Spec: Personal Movie & Series Watchlist

## Goal
A personal web app (single user) to search movies and TV series, save the ones I want to watch, and see key data for each: IMDb rating and vote count, where to watch in the US, cinema and home release dates for movies, and next-episode / season-premiere info for series. A daily job refreshes saved titles and logs changes (e.g. "now available to rent", "Season 3 premiere date announced").

## Stack and conventions
- Plain HTML, CSS and vanilla JS. No frameworks, no build step.
- Cloudflare Pages (front end + Pages Functions for the API) with a D1 database.
- A separate small Cloudflare Worker with a Cron Trigger for the daily refresh, bound to the same D1 database (Pages Functions can't run on a schedule).
- Code lives in a GitHub repo; Pages deploys from it.
- White background, clean minimal UI, mobile-friendly. Keep it simple and low-maintenance.
- API keys stored as Cloudflare secrets, never in front-end code. All third-party calls go through Pages Functions.
- Protect the whole app (pages and /api) with a password login in a Pages Functions `_middleware.js` (`APP_PASSWORD` secret, signed HttpOnly session cookie valid 30 days, logout link).

## Data sources
Region is always **US**.

### TMDB (primary) — https://api.themoviedb.org/3
Auth: `Authorization: Bearer <TMDB_TOKEN>` (v4 read access token).
- Search: `GET /search/multi?query=...` (filter results to `media_type` movie or tv).
- Movie details: `GET /movie/{id}?append_to_response=release_dates,watch/providers,external_ids,videos,credits`
- TV details: `GET /tv/{id}?append_to_response=watch/providers,external_ids,videos,aggregate_credits`
- TV season: `GET /tv/{id}/season/{n}` (only needed for the full-season-drop check).
- Upcoming in US cinemas: `GET /movie/upcoming?region=US`
- Images: `https://image.tmdb.org/t/p/w342{poster_path}`

### OMDb (IMDb ratings) — https://www.omdbapi.com/
Auth: `?apikey=<OMDB_KEY>`. Free tier is 1,000 requests/day.
- `GET /?i={imdb_id}` → use `imdbRating`, `imdbVotes`, and the `Ratings` array (Rotten Tomatoes, Metacritic). Treat `"N/A"` as null.
- Use the IMDb ID from TMDB `external_ids.imdb_id`.

### Attribution (required by TMDB)
Footer: "This product uses the TMDB API but is not endorsed or certified by TMDB. Where-to-watch data provided by JustWatch." Include the TMDB logo.

## Database (D1)

```sql
CREATE TABLE titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  imdb_id TEXT,
  title TEXT NOT NULL,
  year INTEGER,
  poster_path TEXT,
  overview TEXT,
  trailer_key TEXT,                -- YouTube key: site YouTube + type Trailer, official first, then newest
  list_status TEXT NOT NULL DEFAULT 'want' CHECK (list_status IN ('want','watching','watched')),  -- unused by the UI since watched titles are deleted
  added_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- ratings (OMDb)
  imdb_rating REAL,
  imdb_votes INTEGER,
  rt_score TEXT,
  metascore INTEGER,
  ratings_refreshed_at TEXT,

  -- movie release dates (US, from TMDB release_dates)
  us_premiere TEXT,                -- type 1
  us_theatrical_limited TEXT,      -- type 2
  us_theatrical TEXT,              -- type 3
  us_digital TEXT,                 -- type 4
  us_physical TEXT,                -- type 5
  us_tv TEXT,                      -- type 6

  -- series info (TMDB tv details)
  tv_status TEXT,                  -- Returning Series, Ended, Canceled, In Production, Planned
  networks TEXT,                   -- comma-separated names
  seasons_count INTEGER,
  next_ep_date TEXT,
  next_ep_season INTEGER,
  next_ep_number INTEGER,
  full_season_drop INTEGER DEFAULT 0,

  -- where to watch (US)
  providers_json TEXT,             -- {flatrate:[], rent:[], buy:[], link:""}
  has_rent_or_buy INTEGER DEFAULT 0,
  has_streaming INTEGER DEFAULT 0,

  last_refreshed_at TEXT,
  UNIQUE (tmdb_id, media_type)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen INTEGER NOT NULL DEFAULT 0
);
```

Store dates as ISO `YYYY-MM-DD`. For each release type, keep the earliest US date of that type.

## API (Pages Functions under /functions/api)
- `GET /api/search?q=` → proxied TMDB multi-search, trimmed to id, media_type, title/name, year, poster_path, and whether it's already saved.
- `GET /api/titles?status=&type=` → saved titles list.
- `POST /api/titles` `{tmdb_id, media_type}` → fetch TMDB + OMDb, insert, return the row.
- `PATCH /api/titles/:id` `{list_status}` → update status.
- `DELETE /api/titles/:id`
- `POST /api/titles/:id/refresh` → manual refresh of one title.
- `GET /api/events?unseen=1` and `POST /api/events/seen` → the updates feed.
- `GET /api/preview/:media_type/:tmdb_id` → fetch + normalize TMDB and OMDb data for an unsaved title, without writing to the database.
- `GET /api/upcoming` → TMDB upcoming US movies (not saved, just for browsing).

Put the shared "fetch and normalize a title" logic in one module used by both the Pages Functions and the cron Worker.

## Normalization rules

### Movies
- From `release_dates.results`, take the `iso_3166_1 = "US"` entry and map types 1–6 to the columns above.
- Display line (first match wins):
  1. Theatrical date in the future → "In theaters {date}" (use limited date with "(limited)" if no wide date).
  2. Currently in theaters (theatrical date within the last ~60 days) and no rent/buy providers → "In theaters now".
  3. Streaming providers present → "Streaming on {names}".
  4. Rent/buy present → "Available to rent/buy".
  5. Digital or physical date in the future → "Digital {date}" / "Blu-ray/DVD {date}".
  6. Otherwise show nothing.
- Physical and digital dates in TMDB are often missing or added late. Treat **rent/buy appearing in watch providers** as the reliable "out at home" signal.
- Streaming originals often have no theatrical date. Don't treat that as missing data.

### Series
- Status line (first match wins):
  1. `next_episode_to_air` exists and `episode_number == 1` → "Season {n} premieres {date}" (append "– full season" if `full_season_drop`).
  2. `next_episode_to_air` exists → "New episode {weekday or date} (S{s}E{e})".
  3. `status == "Returning Series"` and no next episode → "Renewed, no date yet".
  4. `status in ("Ended","Canceled")` → "Complete · {seasons_count} seasons".
  5. `In Production` / `Planned` → "In production" / "Announced".
- Full-season-drop check: when the next episode is a season premiere, fetch that season. If every episode shares the same air date, set `full_season_drop = 1`.
- Show networks (e.g. "Netflix", "HBO") on the card.

### Overview
- The existing OMDb request uses `plot=full` (no extra call); the plot is stored in `omdb_plot`, refreshed with the ratings.
- Show one overview: OMDb's full plot, falling back to the TMDB overview when the plot is "N/A" or shorter than TMDB's.

### Credits
- Movies (`credits`): Director(s) and the top 6 cast in billing order with profile photo (w185), name, character.
- Series (`created_by` + `aggregate_credits`): Created by and the top 6 cast by episode count with character names.
- Placeholder silhouette when there's no photo; cast row scrolls horizontally on phones. Stored in `credits_json`.

### Where to watch
- From `watch/providers.results.US`: `flatrate` (streaming), `rent`, `buy`, and `link` (JustWatch page). Store all of them, but on cards and in the detail panel show only streaming (`flatrate`) logos (`https://image.tmdb.org/t/p/w92{logo_path}`), with no JustWatch link. Rent/buy still drives `has_rent_or_buy`, the status line and refresh alerts.

## Daily refresh (cron Worker)
- Schedule: once a day (e.g. `0 9 * * *` UTC).
- Refresh all saved titles (watched titles are deleted from the list, so there is nothing to skip).
- TMDB data every run. OMDb ratings only if `ratings_refreshed_at` is older than 7 days (saves quota).
- Compare old vs new values and insert an `events` row for:
  - Rent/buy providers appeared → "{title} is now available to rent/buy"
  - New streaming provider → "{title} is now streaming on {name}"
  - Theatrical, digital or physical date newly set or changed
  - Series: next-episode date newly set (premiere announced) or changed; status changed to Ended/Canceled; renewed
- Throttle calls (small delay between titles) and catch errors per title so one failure doesn't stop the run.

## Front end
Single page, three areas:
1. **Search bar** at top with debounced (300ms) results dropdown: poster thumb, title, year, Movie/Series tag, "Save" button (or "Saved").
2. **Updates feed**: unseen events at the top, dismissable ("mark all seen"). Also show a browser notification for new unseen events when the page loads, if permission was granted.
3. **My list**: card grid with two tabs, Movies (default) and Series. Sort by: recently added, IMDb rating, next release date.
   - Card: poster, title, year, IMDb rating + vote count (e.g. "7.8 · 412K votes"), RT/Metascore if present, the status line from the rules above, streaming provider logos, remove button (no status dropdown: watched titles get deleted).
   - Click a card → detail panel: overview, all US release dates, trailer embed (`https://www.youtube-nocookie.com/embed/{key}`, `referrerpolicy="strict-origin-when-cross-origin"`, hidden when there's no trailer), streaming providers, IMDb link (`https://www.imdb.com/title/{imdb_id}/`), manual refresh button.
   - Click a search result → the same detail panel for an unsaved title via `GET /api/preview/:media_type/:tmdb_id` (fetch + normalize, no DB write), with a "Save to list" button (or "Saved").

Format vote counts as K/M. Format dates as "Mar 12, 2027". Use relative words for near dates ("Thursday", "tomorrow").

## Build order
1. Repo scaffold, D1 schema migration, Pages project, secrets (`TMDB_TOKEN`, `OMDB_KEY`).
2. Shared fetch/normalize module + `/api/search` and `POST /api/titles`. Test with one movie and one series.
3. List UI with cards, Movies/Series tabs, delete.
4. Detail panel.
5. Cron Worker with change detection + events table.
6. Updates feed and browser notifications.
7. Password protection, attribution footer, final mobile pass.

## Out of scope for v1
Multiple users, recommendations, episode-by-episode watch tracking, non-US regions.
