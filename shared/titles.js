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
  'credits_json',
  'long_overview', 'long_overview_source', 'long_overview_url', 'long_overview_fetched_at',
  'last_refreshed_at',
];

export const LONG_OVERVIEW_COLUMNS = ['long_overview', 'long_overview_source', 'long_overview_url', 'long_overview_fetched_at'];

// Wikimedia asks API clients to send a descriptive User-Agent.
const WIKI_UA = 'MovieListWatchlist/1.0 (personal, non-commercial watchlist app)';
const SHORT_SUMMARY = 500; // characters; below this, use the full intro section instead

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

// plot=full gives the long plot (used as the long-overview fallback); it costs the same single request.
async function omdb(env, imdbId) {
  if (!env.OMDB_KEY) throw new Error('OMDB_KEY is not configured');
  const url = new URL(OMDB_BASE);
  url.searchParams.set('apikey', env.OMDB_KEY);
  url.searchParams.set('i', imdbId);
  url.searchParams.set('plot', 'full');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OMDb failed: ${res.status}`);
  const data = await res.json();
  if (data.Response === 'False') throw new Error(`OMDb: ${data.Error || 'not found'}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET JSON from a Wikimedia endpoint; 404 -> null; retries once on a short 429.
async function wikiJson(url, accept = 'application/json') {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA, Accept: accept } });
    if (res.status === 404) return null;
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('Retry-After'));
      if (Number.isFinite(wait) && wait <= 3) {
        await sleep(Math.max(wait, 0.5) * 1000);
        continue;
      }
    }
    if (!res.ok) throw new Error(`Wikimedia ${new URL(url).hostname} failed: ${res.status}`);
    return res.json();
  }
}

// IMDb ID -> English Wikipedia article title, via Wikidata (P345 = IMDb ID, enwiki sitelink).
// Primary: one SPARQL query. Fallback: search API + wbgetentities.
async function wikipediaTitleForImdb(imdbId) {
  if (!/^tt\d+$/.test(imdbId)) return null;
  try {
    const query = `SELECT ?article WHERE { ?item wdt:P345 "${imdbId}" . ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . } LIMIT 1`;
    const data = await wikiJson(
      `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`,
      'application/sparql-results+json',
    );
    const url = data?.results?.bindings?.[0]?.article?.value;
    if (url) return decodeURIComponent(url.split('/wiki/')[1]).replace(/_/g, ' ');
    if (data) return null; // query succeeded: no enwiki article
  } catch {
    // fall through to the search API
  }
  const search = await wikiJson(
    `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P345=${imdbId}`)}&srlimit=5&format=json&formatversion=2`,
  );
  const ids = (search?.query?.search || []).map((r) => r.title).filter((t) => /^Q\d+$/.test(t));
  if (!ids.length) return null;
  const entities = await wikiJson(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=sitelinks&sitefilter=enwiki&format=json&formatversion=2`,
  );
  for (const id of ids) {
    const title = entities?.entities?.[id]?.sitelinks?.enwiki?.title;
    if (title) return title;
  }
  return null;
}

/**
 * Article intro only (the lead section, before the first heading), so it never includes the Plot section.
 * Uses the REST summary, or the full intro section when the summary is short.
 * Returns {text, url} or null when there's no usable article.
 */
async function wikipediaIntro(imdbId) {
  const title = await wikipediaTitleForImdb(imdbId);
  if (!title) return null;
  const path = encodeURIComponent(title.replace(/ /g, '_'));
  const summary = await wikiJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${path}`);
  if (!summary || summary.type === 'disambiguation') return null;
  const url = summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${path}`;
  let text = (summary.extract || '').trim();

  if (text.length < SHORT_SUMMARY) {
    const intro = await wikiJson(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&formatversion=2&titles=${path}`,
    );
    const full = (intro?.query?.pages?.[0]?.extract || '').trim();
    if (full.length > text.length) text = full;
  }
  if (!text) return null;
  // Tidy paragraphs: plain-text extracts separate paragraphs with newlines.
  text = text.split(/\n+/).map((p) => p.trim()).filter(Boolean).join('\n\n');
  return { text, url };
}

// ---------- small normalizers ----------

const nowIso = () => new Date().toISOString().slice(0, 19).replace('T', ' '); // matches datetime('now')
const toDate = (s) => (s ? String(s).slice(0, 10) : null); // ISO YYYY-MM-DD
const toYear = (s) => (s && /^\d{4}/.test(s) ? Number(s.slice(0, 4)) : null);
const na = (v) => (v === undefined || v === null || v === '' || v === 'N/A' ? null : v);

// YouTube trailers only (no teasers/clips); official first, then newest.
export function pickTrailer(videos) {
  const trailers = (videos?.results || []).filter((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.key);
  trailers.sort(
    (a, b) =>
      (b.official ? 1 : 0) - (a.official ? 1 : 0) ||
      String(b.published_at || '').localeCompare(String(a.published_at || '')),
  );
  return trailers[0]?.key || null;
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

// ---------- credits ----------

const TOP_CAST = 8;
const MAX_NAMES = 12; // cap long crew lists (e.g. executive producers on long-running shows)
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// Movie: Director(s), Producer(s) (crew job exactly "Producer"), top 8 cast in billing order.
export function normalizeMovieCredits(credits) {
  const crew = credits?.crew || [];
  const byJob = (job) => uniq(crew.filter((c) => c.job === job).map((c) => c.name));
  const producers = byJob('Producer');
  const cast = (credits?.cast || [])
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, TOP_CAST)
    .map((c) => ({ name: c.name, character: c.character || null, profile_path: c.profile_path || null }));
  return {
    credits_json: JSON.stringify({
      directors: byJob('Director'),
      producers: producers.slice(0, MAX_NAMES),
      producers_total: producers.length,
      cast,
    }),
  };
}

// Series: Created by, Executive Producers, top 8 cast by episode count (aggregate_credits).
export function normalizeTvCredits(createdBy, aggregate) {
  const execs = (aggregate?.crew || [])
    .map((c) => ({
      name: c.name,
      episodes: (c.jobs || []).filter((j) => j.job === 'Executive Producer').reduce((n, j) => n + (j.episode_count || 0), 0),
      isExec: (c.jobs || []).some((j) => j.job === 'Executive Producer'),
    }))
    .filter((c) => c.isExec)
    .sort((a, b) => b.episodes - a.episodes);
  const execNames = uniq(execs.map((c) => c.name));
  const cast = (aggregate?.cast || [])
    .slice()
    .sort((a, b) => (b.total_episode_count || 0) - (a.total_episode_count || 0) || (a.order ?? 999) - (b.order ?? 999))
    .slice(0, TOP_CAST)
    .map((c) => {
      const roles = (c.roles || [])
        .slice()
        .sort((a, b) => (b.episode_count || 0) - (a.episode_count || 0))
        .map((r) => r.character)
        .filter(Boolean);
      return {
        name: c.name,
        character: uniq(roles).slice(0, 2).join(' / ') || null,
        profile_path: c.profile_path || null,
        episodes: c.total_episode_count || null,
      };
    });
  return {
    credits_json: JSON.stringify({
      created_by: uniq((createdBy || []).map((c) => c.name)),
      executive_producers: execNames.slice(0, MAX_NAMES),
      executive_producers_total: execNames.length,
      cast,
    }),
  };
}

// ---------- TMDB detail fetchers ----------

async function fetchMovie(env, tmdbId) {
  const d = await tmdb(env, `/movie/${tmdbId}`, {
    append_to_response: 'release_dates,watch/providers,external_ids,videos,credits',
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
    ...normalizeMovieCredits(d.credits),
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
    append_to_response: 'watch/providers,external_ids,videos,aggregate_credits',
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
    ...normalizeTvCredits(d.created_by, d.aggregate_credits),
  };
}

/**
 * Fetch TMDB (+ optionally OMDb ratings and the long overview) and return an object keyed by titles columns.
 * Ratings and long-overview columns are only included when they were actually fetched,
 * so a skipped or failed call never wipes stored values.
 *
 * Long overview: Wikipedia intro (via Wikidata P345 -> enwiki), else OMDb full plot.
 * The OMDb request is shared with ratings (one request, plot=full).
 *
 * @param {object} env  - needs TMDB_TOKEN, OMDB_KEY
 * @param {number} tmdbId
 * @param {'movie'|'tv'} mediaType
 * @param {{ratings?: boolean, longOverview?: boolean}} opts
 */
export async function fetchTitle(env, tmdbId, mediaType, { ratings = true, longOverview = true } = {}) {
  if (mediaType !== 'movie' && mediaType !== 'tv') throw new Error(`Invalid media_type: ${mediaType}`);
  const data = mediaType === 'movie' ? await fetchMovie(env, tmdbId) : await fetchTv(env, tmdbId);
  const imdbId = data.imdb_id;

  // Run OMDb (for ratings) and Wikipedia in parallel.
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
  const [omdbRes, wikiRes] = await Promise.all([
    ratings && imdbId ? settle(omdb(env, imdbId)) : null,
    longOverview && imdbId ? settle(wikipediaIntro(imdbId)) : null,
  ]);

  if (omdbRes?.value) Object.assign(data, normalizeOmdb(omdbRes.value));
  if (omdbRes?.error) data.ratings_error = omdbRes.error.message; // not stored; useful for logs

  if (longOverview) {
    if (!imdbId) {
      Object.assign(data, longOverviewFields(null));
    } else if (wikiRes.value) {
      Object.assign(data, longOverviewFields({ text: wikiRes.value.text, source: 'wikipedia', url: wikiRes.value.url }));
    } else {
      if (wikiRes.error) data.long_overview_error = wikiRes.error.message;
      // Fallback: OMDb full plot (reuse the ratings response when we have it).
      let omdbData = omdbRes?.value;
      let omdbFailed = !!omdbRes?.error;
      if (!omdbRes) {
        try {
          omdbData = await omdb(env, imdbId);
        } catch {
          omdbFailed = true;
        }
      }
      const plot = omdbData ? na(omdbData.Plot) : null;
      const usable = plot && plot.trim() !== (data.overview || '').trim() ? plot.trim() : null;
      // Cache a miss only when both lookups really succeeded. If Wikipedia errored, still show the
      // OMDb text but leave fetched_at empty so the next refresh tries Wikipedia again.
      if (usable || (!wikiRes.error && !omdbFailed)) {
        Object.assign(
          data,
          longOverviewFields(usable ? { text: usable, source: 'omdb', url: `https://www.imdb.com/title/${imdbId}/plotsummary/` } : null),
        );
        if (wikiRes.error) data.long_overview_fetched_at = null;
      }
    }
  }

  data.last_refreshed_at = nowIso();
  return data;
}

function longOverviewFields(found) {
  return {
    long_overview: found?.text || null,
    long_overview_source: found?.source || null,
    long_overview_url: found?.url || null,
    long_overview_fetched_at: nowIso(),
  };
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
  const parse = (s) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  const { providers_json, credits_json, ...rest } = row;
  return { ...rest, providers: parse(providers_json), credits: parse(credits_json) };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
