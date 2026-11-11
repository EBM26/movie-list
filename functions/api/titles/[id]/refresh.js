import { fetchTitle, updateTitle, rowToJson, json } from '../../../../shared/titles.js';
import { parseId } from '../../../../shared/api.js';

// POST /api/titles/:id/refresh -> re-fetch TMDB + OMDb for one title
export async function onRequestPost({ params, env }) {
  const id = parseId(params);
  if (!id) return json({ error: 'Invalid id' }, 400);
  const existing = await env.DB.prepare('SELECT tmdb_id, media_type FROM titles WHERE id = ?').bind(id).first();
  if (!existing) return json({ error: 'Not found' }, 404);

  let data;
  try {
    data = await fetchTitle(env, existing.tmdb_id, existing.media_type);
  } catch (e) {
    return json({ error: e.message }, 502);
  }
  const row = await updateTitle(env.DB, id, data);
  return json({ title: rowToJson(row), ratings_error: data.ratings_error });
}
