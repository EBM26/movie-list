// Watchlist front end. Plain JS, no build step.

const IMG = 'https://image.tmdb.org/t/p/';
const STATUS_LABELS = { want: 'Want', watching: 'Watching', watched: 'Watched' };

const state = {
  titles: [],
  loaded: false,
  status: pref('status', 'want'),
  type: pref('type', 'all'),
  sort: pref('sort', 'added'),
  openId: null,
};

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function pref(key, fallback) {
  try {
    return localStorage.getItem(`wl.${key}`) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(`wl.${key}`, value);
  } catch {
    /* storage unavailable */
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- formatting ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysFromToday(s) {
  return Math.round((parseDate(s) - parseDate(todayStr())) / 86400000);
}
function formatDate(s) {
  return parseDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
// "today", "tomorrow", "Thursday" for the next 6 days, "yesterday", otherwise "Mar 12, 2027".
function relDate(s) {
  const diff = daysFromToday(s);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return parseDate(s).toLocaleDateString('en-US', { weekday: 'long' });
  return formatDate(s);
}
function formatVotes(n) {
  if (n == null) return '';
  if (n >= 1e6) return `${trim1(n / 1e6)}M`;
  if (n >= 1e3) return `${n >= 1e5 ? Math.round(n / 1e3) : trim1(n / 1e3)}K`;
  return String(n);
}
const trim1 = (x) => x.toFixed(1).replace(/\.0$/, '');
const isFuture = (s) => !!s && s > todayStr();
const isTodayOrFuture = (s) => !!s && s >= todayStr();

function providers(t) {
  return t.providers || { flatrate: [], rent: [], buy: [], link: '' };
}
function listNames(names, max = 2) {
  if (names.length <= max) return names.join(' & ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

// ---------- status line rules (see spec) ----------

function movieStatusLine(t) {
  const p = providers(t);
  const wide = t.us_theatrical;
  const limited = t.us_theatrical_limited;

  // 1. Theatrical date in the future
  if (isFuture(wide)) return `In theaters ${relDate(wide)}`;
  if (!wide && isFuture(limited)) return `In theaters ${relDate(limited)} (limited)`;

  // 2. Currently in theaters (released within ~60 days) and no rent/buy yet
  const theatrical = wide || limited;
  if (theatrical && !t.has_rent_or_buy) {
    const ago = -daysFromToday(theatrical);
    if (ago >= 0 && ago <= 60) return 'In theaters now';
  }

  // 3. Streaming
  if (p.flatrate.length) return `Streaming on ${listNames(p.flatrate.map((x) => x.name))}`;

  // 4. Rent/buy
  if (p.rent.length || p.buy.length) return 'Available to rent/buy';

  // 5. Upcoming digital / physical
  const upcoming = [
    ['Digital', t.us_digital],
    ['Blu-ray/DVD', t.us_physical],
  ]
    .filter(([, d]) => isFuture(d))
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (upcoming.length) return `${upcoming[0][0]} ${relDate(upcoming[0][1])}`;

  return '';
}

function tvStatusLine(t) {
  const hasNext = t.next_ep_date && isTodayOrFuture(t.next_ep_date);
  if (hasNext && t.next_ep_number === 1) {
    return `Season ${t.next_ep_season} premieres ${relDate(t.next_ep_date)}${t.full_season_drop ? ' – full season' : ''}`;
  }
  if (hasNext) return `New episode ${relDate(t.next_ep_date)} (S${t.next_ep_season}E${t.next_ep_number})`;
  if (t.tv_status === 'Returning Series') return 'Renewed, no date yet';
  if (t.tv_status === 'Ended' || t.tv_status === 'Canceled') {
    const n = t.seasons_count;
    return `Complete${n ? ` · ${n} season${n === 1 ? '' : 's'}` : ''}`;
  }
  if (t.tv_status === 'In Production') return 'In production';
  if (t.tv_status === 'Planned') return 'Announced';
  return '';
}

const statusLine = (t) => (t.media_type === 'movie' ? movieStatusLine(t) : tvStatusLine(t));

// Next upcoming release date (for sorting).
function nextRelease(t) {
  const dates =
    t.media_type === 'movie'
      ? [t.us_theatrical, t.us_theatrical_limited, t.us_digital, t.us_physical]
      : [t.next_ep_date];
  return dates.filter(isTodayOrFuture).sort()[0] || null;
}

// ---------- shared snippets ----------

function posterImg(t, size = 'w342', cls = 'poster') {
  if (!t.poster_path) return `<div class="${cls} poster-fallback">${esc(t.title)}</div>`;
  return `<img class="${cls}" src="${IMG}${size}${esc(t.poster_path)}" alt="" loading="lazy">`;
}

function ratingsHtml(t) {
  const parts = [];
  if (t.imdb_rating != null) {
    const votes = t.imdb_votes ? ` · ${formatVotes(t.imdb_votes)} votes` : '';
    parts.push(`<span class="imdb"><span class="star">★</span> <strong>${t.imdb_rating.toFixed(1)}</strong>${votes}</span>`);
  }
  if (t.rt_score) parts.push(`<span class="chip" title="Rotten Tomatoes">RT ${esc(t.rt_score)}</span>`);
  if (t.metascore != null) parts.push(`<span class="chip" title="Metascore">MC ${t.metascore}</span>`);
  return parts.length ? `<div class="ratings">${parts.join('')}</div>` : '';
}

function logoImgs(list) {
  return list
    .map((p) => `<img src="${IMG}w92${esc(p.logo_path)}" alt="${esc(p.name)}" title="${esc(p.name)}" loading="lazy">`)
    .join('');
}

// Card logos: streaming first, then rent/buy, deduped, max 5.
function cardLogos(t) {
  const p = providers(t);
  const seen = new Set();
  const all = [...p.flatrate, ...p.rent, ...p.buy].filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 5);
  if (!all.length) return '';
  const inner = logoImgs(all);
  return p.link
    ? `<a class="logos" href="${esc(p.link)}" target="_blank" rel="noopener" title="Where to watch">${inner}</a>`
    : `<div class="logos">${inner}</div>`;
}

function statusSelect(t) {
  return `<select class="status-select" data-action="status" aria-label="List status">${Object.entries(STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}"${t.list_status === v ? ' selected' : ''}>${l}</option>`)
    .join('')}</select>`;
}

// ---------- list rendering ----------

function visibleTitles() {
  let list = state.titles.filter(
    (t) => t.list_status === state.status && (state.type === 'all' || t.media_type === state.type),
  );
  const byAdded = (a, b) => b.added_at.localeCompare(a.added_at) || b.id - a.id;
  if (state.sort === 'rating') {
    list.sort((a, b) => (b.imdb_rating ?? -1) - (a.imdb_rating ?? -1) || byAdded(a, b));
  } else if (state.sort === 'release') {
    list.sort((a, b) => {
      const da = nextRelease(a);
      const db = nextRelease(b);
      if (da && db) return da.localeCompare(db) || byAdded(a, b);
      if (da) return -1;
      if (db) return 1;
      return byAdded(a, b);
    });
  } else {
    list.sort(byAdded);
  }
  return list;
}

function renderControls() {
  for (const btn of document.querySelectorAll('#tabs button')) {
    const s = btn.dataset.status;
    btn.setAttribute('aria-selected', String(s === state.status));
    const n = state.titles.filter((t) => t.list_status === s && (state.type === 'all' || t.media_type === state.type)).length;
    $('.count', btn).textContent = n ? n : '';
  }
  for (const btn of document.querySelectorAll('#type-filter button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.type === state.type));
  }
  $('#sort').value = state.sort;
}

function cardHtml(t) {
  const line = statusLine(t);
  return `
    <article class="card" data-id="${t.id}" tabindex="0" aria-label="${esc(t.title)}">
      ${posterImg(t)}
      <div class="card-body">
        <h2 class="card-title">${esc(t.title)} ${t.year ? `<span class="card-year">${t.year}</span>` : ''}</h2>
        ${ratingsHtml(t)}
        ${line ? `<div class="status-line">${esc(line)}</div>` : ''}
        ${t.media_type === 'tv' && t.networks ? `<div class="networks">${esc(t.networks)}</div>` : ''}
        ${cardLogos(t)}
        <div class="card-actions">
          ${statusSelect(t)}
          <button class="icon-btn" data-action="delete" aria-label="Remove ${esc(t.title)}" title="Remove">×</button>
        </div>
      </div>
    </article>`;
}

function render() {
  renderControls();
  const list = visibleTitles();
  const msg = $('#list-message');
  if (!state.loaded) {
    msg.textContent = 'Loading…';
  } else if (!state.titles.length) {
    msg.textContent = 'Your list is empty. Search above to add movies and series.';
  } else if (!list.length) {
    const kind = state.type === 'movie' ? 'movies' : state.type === 'tv' ? 'series' : 'titles';
    msg.textContent = `No ${kind} in ${STATUS_LABELS[state.status]}.`;
  }
  msg.hidden = state.loaded && list.length > 0;
  $('#grid').innerHTML = list.map(cardHtml).join('');
}

async function loadTitles() {
  try {
    const { titles } = await api('/api/titles');
    state.titles = titles;
  } catch (e) {
    toast(`Couldn't load your list: ${e.message}`);
  }
  state.loaded = true;
  render();
}

function upsertTitle(title) {
  const i = state.titles.findIndex((t) => t.id === title.id);
  if (i >= 0) state.titles[i] = title;
  else state.titles.unshift(title);
}

async function changeStatus(id, status) {
  const t = state.titles.find((x) => x.id === id);
  if (!t || t.list_status === status) return;
  const prev = t.list_status;
  t.list_status = status;
  render();
  if (state.openId === id) renderPanel();
  try {
    const { title } = await api(`/api/titles/${id}`, { method: 'PATCH', body: { list_status: status } });
    upsertTitle(title);
    toast(`Moved “${title.title}” to ${STATUS_LABELS[status]}`);
  } catch (e) {
    t.list_status = prev;
    toast(`Couldn't update: ${e.message}`);
  }
  render();
  if (state.openId === id) renderPanel();
}

async function removeTitle(id) {
  const t = state.titles.find((x) => x.id === id);
  if (!t || !confirm(`Remove “${t.title}” from your list?`)) return;
  try {
    await api(`/api/titles/${id}`, { method: 'DELETE' });
    state.titles = state.titles.filter((x) => x.id !== id);
    if (state.openId === id) closePanel();
    render();
    refreshSearchSavedState();
    toast(`Removed “${t.title}”`);
  } catch (e) {
    toast(`Couldn't remove: ${e.message}`);
  }
}

// ---------- list events ----------

function setupList() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-status]');
    if (!btn) return;
    state.status = btn.dataset.status;
    savePref('status', state.status);
    render();
  });
  $('#type-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    state.type = btn.dataset.type;
    savePref('type', state.type);
    render();
  });
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    savePref('sort', state.sort);
    render();
  });

  const grid = $('#grid');
  grid.addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'status') return;
    changeStatus(Number(e.target.closest('.card').dataset.id), e.target.value);
  });
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (e.target.closest('[data-action="delete"]')) return removeTitle(id);
    if (e.target.closest('a, button, select')) return; // let controls/links work
    openPanel(id);
  });
  grid.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) {
      e.preventDefault();
      openPanel(Number(e.target.dataset.id));
    }
  });
}

// ---------- search ----------

const search = { timer: null, ctrl: null, results: [], q: '' };

function renderSearch() {
  const box = $('#search-results');
  const input = $('#search-input');
  if (!search.q) {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  box.innerHTML = search.results.length
    ? search.results
        .map((r, i) => {
          const poster = r.poster_path
            ? `<img class="sr-poster" src="${IMG}w92${esc(r.poster_path)}" alt="" loading="lazy">`
            : '<div class="sr-poster"></div>';
          const btn = r.saved
            ? '<button class="btn saved" disabled>Saved</button>'
            : `<button class="btn" data-index="${i}">Save</button>`;
          return `<div class="sr-item" role="option">
            ${poster}
            <div class="sr-main">
              <div class="sr-title">${esc(r.title)}</div>
              <div class="sr-meta">${r.year ? `<span>${r.year}</span>` : ''}<span class="tag">${r.media_type === 'movie' ? 'Movie' : 'Series'}</span></div>
            </div>
            ${btn}
          </div>`;
        })
        .join('')
    : `<div class="sr-empty">${search.loading ? 'Searching…' : 'No results'}</div>`;
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function refreshSearchSavedState() {
  for (const r of search.results) {
    const t = state.titles.find((x) => x.tmdb_id === r.id && x.media_type === r.media_type);
    r.saved = !!t;
    r.saved_id = t?.id ?? null;
  }
  if (!$('#search-results').hidden) renderSearch();
}

async function runSearch(q) {
  search.ctrl?.abort();
  search.ctrl = new AbortController();
  search.loading = true;
  if (!search.results.length) renderSearch();
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: search.ctrl.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');
    if (q !== search.q) return;
    search.results = data.results;
  } catch (e) {
    if (e.name === 'AbortError') return;
    search.results = [];
    toast(e.message);
  }
  search.loading = false;
  renderSearch();
}

async function saveResult(index, btn) {
  const r = search.results[index];
  if (!r) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { title } = await api('/api/titles', { method: 'POST', body: { tmdb_id: r.id, media_type: r.media_type } });
    upsertTitle(title);
    r.saved = true;
    r.saved_id = title.id;
    renderSearch();
    render();
    toast(`Saved “${title.title}” to ${STATUS_LABELS[title.list_status]}`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Save';
    toast(`Couldn't save: ${e.message}`);
  }
}

function setupSearch() {
  const input = $('#search-input');
  const box = $('#search-results');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(search.timer);
    if (!q) {
      search.ctrl?.abort();
      search.q = '';
      search.results = [];
      renderSearch();
      return;
    }
    search.timer = setTimeout(() => {
      search.q = q;
      runSearch(q);
    }, 300);
  });
  input.addEventListener('focus', () => search.q && renderSearch());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.blur();
    }
  });
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) saveResult(Number(btn.dataset.index), btn);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search')) {
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });
}

// ---------- detail panel ----------

let lastFocus = null;

function openPanel(id) {
  state.openId = id;
  lastFocus = document.activeElement;
  renderPanel();
  $('#panel').hidden = false;
  $('#panel-backdrop').hidden = false;
  document.body.classList.add('no-scroll');
  $('#panel').scrollTop = 0;
  $('#panel-close').focus();
}

function closePanel() {
  state.openId = null;
  $('#panel').hidden = true;
  $('#panel-backdrop').hidden = true;
  $('#panel-body').innerHTML = ''; // stops the trailer
  document.body.classList.remove('no-scroll');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function datesHtml(t) {
  const rows =
    t.media_type === 'movie'
      ? [
          ['Premiere', t.us_premiere],
          ['Theatrical (limited)', t.us_theatrical_limited],
          ['Theatrical', t.us_theatrical],
          ['Digital', t.us_digital],
          ['Physical', t.us_physical],
          ['TV', t.us_tv],
        ].filter(([, d]) => d)
      : [
          ['Status', t.tv_status],
          ['Network', t.networks],
          ['Seasons', t.seasons_count],
          [
            'Next episode',
            t.next_ep_date
              ? `${formatDate(t.next_ep_date)} (S${t.next_ep_season}E${t.next_ep_number})${t.full_season_drop ? ' – full season' : ''}`
              : null,
          ],
        ].filter(([, v]) => v != null && v !== '');
  if (!rows.length) return '<p class="muted small">No US release dates yet.</p>';
  const fmt = (label, v) =>
    t.media_type === 'movie' ? `${formatDate(v)}${isFuture(v) ? ` <span class="muted small">(${esc(relDate(v))})</span>` : ''}` : esc(v);
  return `<dl class="dates">${rows.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${fmt(l, v)}</dd>`).join('')}</dl>`;
}

function providersHtml(t) {
  const p = providers(t);
  const groups = [
    ['Stream', p.flatrate],
    ['Rent', p.rent],
    ['Buy', p.buy],
  ].filter(([, list]) => list.length);
  const body = groups.length
    ? groups
        .map(
          ([label, list]) => `<div class="prov-group">
            <div class="label">${label}</div>
            ${p.link ? `<a class="logos" href="${esc(p.link)}" target="_blank" rel="noopener">${logoImgs(list)}</a>` : `<div class="logos">${logoImgs(list)}</div>`}
          </div>`,
        )
        .join('')
    : '<p class="muted small">Not available to stream, rent or buy in the US yet.</p>';
  return body;
}

function renderPanel() {
  const t = state.titles.find((x) => x.id === state.openId);
  if (!t) return closePanel();
  const p = providers(t);
  const line = statusLine(t);
  const links = [
    p.link && `<a href="${esc(p.link)}" target="_blank" rel="noopener">All options on JustWatch ↗</a>`,
    t.imdb_id && `<a href="https://www.imdb.com/title/${esc(t.imdb_id)}/" target="_blank" rel="noopener">IMDb ↗</a>`,
  ].filter(Boolean);
  const refreshed = t.last_refreshed_at ? `Updated ${formatDate(t.last_refreshed_at.slice(0, 10))}` : '';

  $('#panel-body').innerHTML = `
    <div class="panel-head">
      ${posterImg(t, 'w342')}
      <div>
        <h2 id="panel-title">${esc(t.title)}</h2>
        <div class="sub">${[t.year, t.media_type === 'movie' ? 'Movie' : 'Series', t.media_type === 'tv' ? t.networks : null].filter(Boolean).map(esc).join(' · ')}</div>
        ${ratingsHtml(t)}
        ${line ? `<div class="status-line" style="margin-top:8px">${esc(line)}</div>` : ''}
      </div>
    </div>

    ${t.overview ? `<p class="overview">${esc(t.overview)}</p>` : ''}

    <h3>${t.media_type === 'movie' ? 'US release dates' : 'Series info'}</h3>
    ${datesHtml(t)}

    ${
      t.trailer_key
        ? `<h3>Trailer</h3><div class="trailer"><iframe src="https://www.youtube-nocookie.com/embed/${esc(t.trailer_key)}" title="Trailer" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
        : ''
    }

    <h3>Where to watch (US)</h3>
    ${providersHtml(t)}
    ${links.length ? `<div class="links">${links.join('')}</div>` : ''}

    <div class="panel-actions">
      ${statusSelect(t)}
      <button class="btn ghost" data-action="refresh">Refresh data</button>
      <button class="btn ghost" data-action="delete">Remove</button>
      <span class="muted small" id="panel-refreshed">${esc(refreshed)}</span>
    </div>`;
}

async function refreshTitle(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const { title } = await api(`/api/titles/${id}/refresh`, { method: 'POST' });
    upsertTitle(title);
    render();
    if (state.openId === id) renderPanel();
    toast('Updated');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Refresh data';
    toast(`Couldn't refresh: ${e.message}`);
  }
}

function setupPanel() {
  $('#panel-close').addEventListener('click', closePanel);
  $('#panel-backdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openId != null) closePanel();
  });
  const body = $('#panel-body');
  body.addEventListener('change', (e) => {
    if (e.target.dataset.action === 'status') changeStatus(state.openId, e.target.value);
  });
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'refresh') refreshTitle(state.openId, btn);
    if (btn.dataset.action === 'delete') removeTitle(state.openId);
  });
}

// ---------- init ----------

setupList();
setupSearch();
setupPanel();
render();
loadTitles();
