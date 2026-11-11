// Shared "fetch and normalize a title" logic.
// Used by the Pages Functions (/functions/api/*) and, later, the cron Worker.
// Everything here is region US.

const TMDB_BASE = 'https://api.themoviedb.org/3';
const OMDB_BASE = 'https://www.omdbapi.com/';

// TMDB release_dates type -> titles column
const RELEASE_TYPE_COLUMNS = {
  1: 'us_premiere',
  2: 'us_theatrical_limited',
  3: 'us_theatrical',
  4: 'us_digital',
  5: 'us_physical',
  6: 'us_tv',
};

// Columns written by fetch/normalize (everything except id, list_status, added_at).
export const DATA_COLUMNS = [
  'tmdb_id', 'media_type', 'imdb_id', 'title', 'year', 'poster_path', 'overview', 'trailer_key',
  'imdb_rating', 'imdb_votes', 'rt_score', 'metascore', 'ratings_refreshed_at',
  'us_premiere', 'us_theatrical_limited', 'us_theatrical', 'us_digital', 'us_physical', 'us_tv',
  'tv_status', 'networks', 'seasons_count', 'next_ep_date', 'next_ep_season', 'next_ep_number',
  'full_season_drop',
  'providers_json', 'has_rent_or_buy', 'has_streaming',
  'last_refreshed_at',
];

export const RATING_COLUMNS = ['imdb_rating', 'imdb_votes', 'rt_score', 'metascore', 'ratings_refreshed_at'];

// ---------- HTTP helpers ----------

export async function tmdb(env, path, params = {}) {
  if (!env.TMDB_TOKEN) throw new Error('TMDB_TOKEN is not configured');
  const url = new URL(TMDB_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`TMDB ${path} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function omdb(env, imdbId) {
  if (!env.OMDB_KEY) throw new Error('OMDB_KEY is not configured');
  const url = new URL(OMDB_BASE);
  url.searchParams.set('apikey', env.OMDB_KEY);
  url.searchParams.set('i', imdbId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OMDb failed: ${res.status}`);
  const data = await res.json();
  if (data.Response === 'False') throw new Error(`OMDb: ${data.Error || 'not found'}`);
  return data;
}

// ---------- small normalizers ----------

const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' '); // matches datetime('now')
const toDate = (s) => (s ? String(s).slice(0, 10) : null); // ISO YYYY-MM-DD
const toYear = (s) => (s && /^\d{4}/.test(s) ? Number(s.slice(0, 4)) : null);
const na = (v) => (v === undefined || v === null || v === '' || v === 'N/A' ? null : v);

function pickTrailer(videos) {
  const yt = (videos?.results || []).filter((v) => v.site === 'YouTube');
  const score = (v) =>
    (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) + (v.official ? 1 : 0);
  yt.sort((a, b) => score(b) - score(a) || String(b.published_at).localeCompare(String(a.published_at)));
  const best = yt[0];
  return best && (best.type === 'Trailer' || best.type === 'Teaser') ? best.key : null;
}

export function normalizeProviders(watchProviders) {
  const us = watchProviders?.results?.US || {};
  const map = (list) =>
    (list || [])
      .slice()
      .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
      .map((p) => ({ id: p.provider_id, name: p.provider_name, logo_path: p.logo_path }));
  const providers = {
    flatrate: map(us.flatrate),
    rent: map(us.rent),
    buy: map(us.buy),
    link: us.link || '',
  };
  return {
    providers_json: JSON.stringify(providers),
    has_rent_or_buy: providers.rent.length || providers.buy.length ? 1 : 0,
    has_streaming: providers.flatrate.length ? 1 : 0,
  };
}

// Earliest US date for each release type 1-6.
export function normalizeReleaseDates(releaseDates) {
  const out = Object.fromEntries(Object.values(RELEASE_TYPE_COLUMNS).map((c) => [c, null]));
  const us = (releaseDates?.results || []).find((r) => r.iso_3166_1 === 'US');
  for (const rd of us?.release_dates || []) {
    const col = RELEASE_TYPE_COLUMNS[rd.type];
    const date = toDate(rd.release_date);
    if (col && date && (!out[col] || date < out[col])) out[col] = date;
  }
  return out;
}

export function normalizeOmdb(data) {
  const rt = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
  const rating = na(data.imdbRating);
  const votes = na(data.imdbVotes);
  const meta = na(data.Metascore);
  return {
    imdb_rating: rating === null ? null : Number(rating),
    imdb_votes: votes === null ? null : Number(String(votes).replace(/,/g, '')),
    rt_score: rt ? na(rt.Value) : null,
    metascore: meta === null ? null : Number(meta),
    ratings_refreshed_at: nowIso(),
  };
}

// ---------- TMDB detail fetchers ----------

async function fetchMovie(env, tmdbId) {
  const d = await tmdb(env, `/movie/${tmdbId}`, {
    append_to_response: 'release_dates,watch/providers,external_ids,videos',
    language: 'en-US',
  });
  return {
    tmdb_id: d.id,
    media_type: 'movie',
    imdb_id: d.external_ids?.imdb_id || d.imdb_id || null,
    title: d.title || d.original_title,
    year: toYear(d.release_date),
    poster_path: d.poster_path || null,
    overview: d.overview || null,
    trailer_key: pickTrailer(d.videos),
    ...normalizeReleaseDates(d.release_dates),
    tv_status: null,
    networks: null,
    seasons_count: null,
    next_ep_date: null,
    next_ep_season: null,
    next_ep_number: null,
    full_season_drop: 0,
    ...normalizeProviders(d['watch/providers']),
  };
}

// A season is a "full season drop" when every episode shares one air date.
async function isFullSeasonDrop(env, tmdbId, seasonNumber) {
  const season = await tmdb(env, `/tv/${tmdbId}/season/${seasonNumber}`, { language: 'en-US' });
  const dates = (season.episodes || []).map((e) => e.air_date);
  return dates.length > 1 && dates.every((d) => d && d === dates[0]);
}

async function fetchTv(env, tmdbId) {
  const d = await tmdb(env, `/tv/${tmdbId}`, {
    append_to_response: 'watch/providers,external_ids,videos',
    language: 'en-US',
  });
  const next = d.next_episode_to_air;
  let fullSeasonDrop = 0;
  if (next && next.episode_number === 1) {
    try {
      fullSeasonDrop = (await isFullSeasonDrop(env, d.id, next.season_number)) ? 1 : 0;
    } catch {
      fullSeasonDrop = 0; // non-critical
    }
  }
  return {
    tmdb_id: d.id,
    media_type: 'tv',
    imdb_id: d.external_ids?.imdb_id || null,
    title: d.name || d.original_name,
    year: toYear(d.first_air_date),
    poster_path: d.poster_path || null,
    overview: d.overview || null,
    trailer_key: pickTrailer(d.videos),
    us_premiere: null,
    us_theatrical_limited: null,
    us_theatrical: null,
    us_digital: null,
    us_physical: null,
    us_tv: null,
    tv_status: d.status || null,
    networks: (d.networks || []).map((n) => n.name).join(', ') || null,
    seasons_count: d.number_of_seasons ?? null,
    next_ep_date: next ? toDate(next.air_date) : null,
    next_ep_season: next ? next.season_number : null,
    next_ep_number: next ? next.episode_number : null,
    full_season_drop: fullSeasonDrop,
    ...normalizeProviders(d['watch/providers']),
  };
}

/**
 * Fetch TMDB (+ optionally OMDb) and return a normalized object keyed by titles columns.
 * Ratings columns are only included when ratings were fetched successfully,
 * so a failed/skipped OMDb call never wipes stored ratings.
 *
 * @param {object} env  - needs TMDB_TOKEN, OMDB_KEY
 * @param {number} tmdbId
 * @param {'movie'|'tv'} mediaType
 * @param {{ratings?: boolean}} opts
 */
export async function fetchTitle(env, tmdbId, mediaType, { ratings = true } = {}) {
  if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error(`Invalid media_type: ${mediaType}`);
  const data = mediaType === 'movie' ? await fetchMovie(env, tmdbId) : await fetchTv(env, tmdbId);

  if (ratings && data.imdb_id) {
    try {
      Object.assign(data, normalizeOmdb(await omdb(env, data.imdb_id)));
    } catch (e) {
      data.ratings_error = e.message; // not stored; useful for logs
    }
  }
  data.last_refreshed_at = nowIso();
  return data;
}

// ---------- D1 helpers ----------

const pickColumns = (data) => DATA_COLUMNS.filter((c) => c in data);

/** Insert a new title. Returns the stored row. */
export async function insertTitle(db, data) {
  const cols = pickColumns(data);
  const sql = `INSERT INTO titles (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`;
  return db.prepare(sql).bind(...cols.map((c) => data[c] ?? null)).first();
}

/** Update an existing title with freshly fetched data. Returns the stored row. */
export async function updateTitle(db, id, data) {
  const cols = pickColumns(data).filter((c) => c !== 'tmdb_id' && c !== 'media_type');
  const sql = `UPDATE titles SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? RETURNING *`;
  return db.prepare(sql).bind(...cols.map((c) => data[c] ?? null), id).first();
}

export function getTitleByTmdb(db, tmdbId, mediaType) {
  return db
    .prepare('SELECT * FROM titles WHERE tmdb_id = ? AND media_type = ?')
    .bind(tmdbId, mediaType)
    .first();
}

/** Parse providers_json for API responses. */
export function rowToJson(row) {
  if (!row) return row;
  let providers = null;
  try {
    providers = row.providers_json ? JSON.parse(row.providers_json) : null;
  } catch {
    providers = null;
  }
  const { providers_json, ...rest } = row;
  return { ...rest, providers };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
