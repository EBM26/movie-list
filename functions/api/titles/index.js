import { fetchTitle, insertTitle, getTitleByTmdb, rowToJson, json } from '../../../shared/titles.js';

// GET /api/titles?status=&type=  -> saved titles (newest first)
export async function onRequestGet({ request, env }) {
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  const type = params.get('type');
  const where = [];
  const binds = [];
  if (status) {
    if (!['want', 'watching', 'watched'].includes(status)) return json({ error: 'Invalid status' }, 400);
    where.push('list_status = ?');
    binds.push(status);
  }
  if (type) {
    if (type !== 'movie' && type !== 'tv') return json({ error: 'Invalid type' }, 400);
    where.push('media_type = ?');
    binds.push(type);
  }
  const sql = `SELECT * FROM titles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY added_at DESC, id DESC`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ titles: results.map(rowToJson) });
}

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
    return json({ title: rowToJson(row), created: true, ratings_error: data.ratings_error, long_overview_error: data.long_overview_error }, 201);
  } catch (e) {
    // Race: saved by another request in the meantime.
    if (/UNIQUE/i.test(e.message)) {
      return json({ title: rowToJson(await getTitleByTmdb(env.DB, tmdbId, mediaType)), created: false });
    }
    return json({ error: e.message }, 500);
  }
}
