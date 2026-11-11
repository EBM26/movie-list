-- Replace the Wikipedia-based long overview with OMDb's full plot (fetched with the ratings call).
ALTER TABLE titles DROP COLUMN long_overview;
ALTER TABLE titles DROP COLUMN long_overview_source;
ALTER TABLE titles DROP COLUMN long_overview_url;
ALTER TABLE titles DROP COLUMN long_overview_fetched_at;
ALTER TABLE titles ADD COLUMN omdb_plot TEXT;

-- Credits now keep only directors / created_by and the cast: drop producer fields from stored rows.
UPDATE titles
SET credits_json = json_remove(credits_json, '$.producers', '$.producers_total', '$.executive_producers', '$.executive_producers_total')
WHERE credits_json IS NOT NULL;
