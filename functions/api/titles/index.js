import { fetchTitle, insertTitle, getTitleByTmdb, rowToJson, json } from '../../../shared/titles.js';

// POST /api/titles {tmdb_id, media_type} -> fetch TMDB + OMDb, insert, return the row
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const tmdbId = Number(body?.tmdb_id);
  const mediaType = body?.media_type;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return json({ error: 'tmdb_id must be a positive integer' }, 400);
  if (mediaType !== 'movie' && mediaType !== 'tv') return json({ error: "media_type must be 'movie' or 'tv'" }, 400);

  const existing = await getTitleByTmdb(env.DB, tmdbId, mediaType);
  if (existing) return json({ title: rowToJson(existing), created: false });

  let data;
  try {
    data = await fetchTitle(env, tmdbId, mediaType);
  } catch (e) {
    return json({ error: e.message }, e.status === 404 ? 404 : 502);
  }

  try {
    const row = await insertTitle(env.DB, data);
    return json({ title: rowToJson(row), created: true, ratings_error: data.ratings_error }, 201);
  } catch (e) {
    // Race: saved by another request in the meantime.
    if (/UNIQUE/i.test(e.message)) {
      return json({ title: rowToJson(await getTitleByTmdb(env.DB, tmdbId, mediaType)), created: false });
    }
    return json({ error: e.message }, 500);
  }
}
