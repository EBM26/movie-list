import { tmdb, json } from '../../shared/titles.js';

// GET /api/search?q=  -> trimmed TMDB multi-search (movies + series only)
export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q) return json({ results: [] });

  let data;
  try {
    data = await tmdb(env, '/search/multi', {
      query: q,
      include_adult: 'false',
      language: 'en-US',
      page: '1',
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  const results = (data.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((r) => {
      const date = r.media_type === 'movie' ? r.release_date : r.first_air_date;
      return {
        id: r.id,
        media_type: r.media_type,
        title: r.media_type === 'movie' ? r.title : r.name,
        year: date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
        poster_path: r.poster_path || null,
        saved: false,
        saved_id: null,
      };
    });

  if (results.length) {
    const ids = [...new Set(results.map((r) => r.id))];
    const { results: rows } = await env.DB
      .prepare(`SELECT id, tmdb_id, media_type FROM titles WHERE tmdb_id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all();
    const saved = new Map(rows.map((row) => [`${row.media_type}:${row.tmdb_id}`, row.id]));
    for (const r of results) {
      const id = saved.get(`${r.media_type}:${r.id}`);
      if (id) {
        r.saved = true;
        r.saved_id = id;
      }
    }
  }

  return json({ results });
}
