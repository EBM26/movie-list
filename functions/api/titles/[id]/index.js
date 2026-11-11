import { rowToJson, json } from '../../../../shared/titles.js';
import { parseId } from '../../../../shared/api.js';

const STATUSES = ['want', 'watching', 'watched'];

// PATCH /api/titles/:id {list_status}
export async function onRequestPatch({ request, params, env }) {
  const id = parseId(params);
  if (!id) return json({ error: 'Invalid id' }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!STATUSES.includes(body?.list_status)) {
    return json({ error: `list_status must be one of ${STATUSES.join(', ')}` }, 400);
  }
  const row = await env.DB
    .prepare('UPDATE titles SET list_status = ? WHERE id = ? RETURNING *')
    .bind(body.list_status, id)
    .first();
  if (!row) return json({ error: 'Not found' }, 404);
  return json({ title: rowToJson(row) });
}

// DELETE /api/titles/:id
export async function onRequestDelete({ params, env }) {
  const id = parseId(params);
  if (!id) return json({ error: 'Invalid id' }, 400);
  const [, res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM events WHERE title_id = ?').bind(id),
    env.DB.prepare('DELETE FROM titles WHERE id = ?').bind(id),
  ]);
  if (!res.meta.changes) return json({ error: 'Not found' }, 404);
  return json({ deleted: id });
}
