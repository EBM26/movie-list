-- Longer overview (Wikipedia intro, or OMDb full plot as fallback), cached for saved titles.
ALTER TABLE titles ADD COLUMN long_overview TEXT;
ALTER TABLE titles ADD COLUMN long_overview_source TEXT;      -- 'wikipedia' | 'omdb'
ALTER TABLE titles ADD COLUMN long_overview_url TEXT;
ALTER TABLE titles ADD COLUMN long_overview_fetched_at TEXT;  -- set even when nothing was found

-- Credits from TMDB: {directors, producers, created_by, executive_producers, cast:[{name, character, profile_path}]}
ALTER TABLE titles ADD COLUMN credits_json TEXT;
