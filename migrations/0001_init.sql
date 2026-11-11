-- Initial schema for the watchlist app.
CREATE TABLE titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie','tv')),
  imdb_id TEXT,
  title TEXT NOT NULL,
  year INTEGER,
  poster_path TEXT,
  overview TEXT,
  trailer_key TEXT,
  list_status TEXT NOT NULL DEFAULT 'want' CHECK (list_status IN ('want','watching','watched')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- ratings (OMDb)
  imdb_rating REAL,
  imdb_votes INTEGER,
  rt_score TEXT,
  metascore INTEGER,
  ratings_refreshed_at TEXT,

  -- movie release dates (US, earliest per TMDB release type)
  us_premiere TEXT,
  us_theatrical_limited TEXT,
  us_theatrical TEXT,
  us_digital TEXT,
  us_physical TEXT,
  us_tv TEXT,

  -- series info
  tv_status TEXT,
  networks TEXT,
  seasons_count INTEGER,
  next_ep_date TEXT,
  next_ep_season INTEGER,
  next_ep_number INTEGER,
  full_season_drop INTEGER DEFAULT 0,

  -- where to watch (US)
  providers_json TEXT,
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

CREATE INDEX idx_titles_status ON titles(list_status);
CREATE INDEX idx_events_unseen ON events(seen, created_at);
