import { fetchTitle, getTitleByTmdb, rowToJson, json } from '../../../../shared/titles.js';

// GET /api/preview/:media_type/:tmdb_id -> full normalized details without saving.
export async function onRequestGet({ params, env }) {
  const mediaType = params.media_type;
  const tmdbId = Number(params.tmdb_id);
  if (mediaType !== 'movie' && mediaType !== 'tv') return json({ error: "media_type must be 'movie' or 'tv'" }, 400);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return json({ error: 'tmdb_id must be a positive integer' }, 400);

  const saved = await getTitleByTmdb(env.DB, tmdbId, mediaType);

  let data;
  try {
    data = await fetchTitle(env, tmdbId, mediaType);
  } catch (e) {
    return json({ error: e.message }, e.status === 404 ? 404 : 502);
  }
  const { ratings_error, long_overview_error, ...fields } = data;
  return json({
    title: { ...rowToJson(fields), id: null },
    saved_id: saved ? saved.id : null,
    ratings_error,
    long_overview_error,
  });
}
