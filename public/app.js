// Watchlist front end. Plain JS, no build step.

const IMG = 'https://image.tmdb.org/t/p/';
const TABS = { movie: 'Movies', tv: 'Series' };

const state = {
  titles: [],
  loaded: false,
  tab: validTab(pref('tab', 'movie')),
  sort: pref('sort', 'added'),
  // Detail panel shows either a saved title (openId) or an unsaved search result (preview).
  openId: null,
  preview: null, // { key, media_type, tmdb_id, title, loading, error }
};

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function validTab(t) {
  return t in TABS ? t : 'movie';
}

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

// Session expired or logged out in another tab -> back to the login page.
function checkAuth(res) {
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Not logged in');
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  checkAuth(res);
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

// Card logos: streaming (flatrate) providers only, max 5. Rent/buy stay in the data
// (has_rent_or_buy drives the status line and refresh alerts) but aren't shown as logos.
function cardLogos(t) {
  const list = providers(t).flatrate.slice(0, 5);
  return list.length ? `<div class="logos">${logoImgs(list)}</div>` : '';
}

// ---------- list rendering ----------

function visibleTitles() {
  const list = state.titles.filter((t) => t.media_type === state.tab);
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
    const type = btn.dataset.type;
    btn.setAttribute('aria-selected', String(type === state.tab));
    const n = state.titles.filter((t) => t.media_type === type).length;
    $('.count', btn).textContent = n ? n : '';
  }
  $('#sort').value = state.sort;
}

function cardHtml(t) {
  const line = statusLine(t);
  return `
    <article class="card" data-id="${t.id}" tabindex="0" aria-label="${esc(t.title)}">
      <div class="card-media">
        ${posterImg(t)}
        <button class="card-remove" data-action="delete" aria-label="Remove ${esc(t.title)}" title="Remove">×</button>
      </div>
      <div class="card-body">
        <h2 class="card-title">${esc(t.title)} ${t.year ? `<span class="card-year">${t.year}</span>` : ''}</h2>
        ${ratingsHtml(t)}
        ${line ? `<div class="status-line">${esc(line)}</div>` : ''}
        ${t.media_type === 'tv' && t.networks ? `<div class="networks">${esc(t.networks)}</div>` : ''}
        ${cardLogos(t)}
      </div>
    </article>`;
}

function render() {
  renderControls();
  const list = visibleTitles();
  const msg = $('#list-message');
  if (!state.loaded) {
    msg.textContent = 'Loading…';
  } else if (!list.length) {
    msg.textContent = `No ${TABS[state.tab].toLowerCase()} yet. Search above to add some.`;
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

const findSaved = (mediaType, tmdbId) => state.titles.find((t) => t.media_type === mediaType && t.tmdb_id === tmdbId);

// Save a title (from search or from the preview panel). Returns the saved row.
async function saveTitle(mediaType, tmdbId) {
  const { title } = await api('/api/titles', { method: 'POST', body: { tmdb_id: tmdbId, media_type: mediaType } });
  upsertTitle(title);
  render();
  refreshSearchSavedState();
  const where = title.media_type === state.tab ? '' : ` to ${TABS[title.media_type]}`;
  toast(`Saved “${title.title}”${where}`);
  return title;
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
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    state.tab = validTab(btn.dataset.type);
    savePref('tab', state.tab);
    render();
  });
  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    savePref('sort', state.sort);
    render();
  });

  const grid = $('#grid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (e.target.closest('[data-action="delete"]')) return removeTitle(id);
    if (e.target.closest('a, button, select')) return;
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

const search = { timer: null, ctrl: null, results: [], q: '', loading: false };

function hideSearch() {
  $('#search-results').hidden = true;
  $('#search-input').setAttribute('aria-expanded', 'false');
}

function renderSearch() {
  const box = $('#search-results');
  if (!search.q) return hideSearch();
  box.innerHTML = search.results.length
    ? search.results
        .map((r, i) => {
          const poster = r.poster_path
            ? `<img class="sr-poster" src="${IMG}w92${esc(r.poster_path)}" alt="" loading="lazy">`
            : '<div class="sr-poster"></div>';
          const btn = r.saved
            ? '<button class="btn saved" disabled>Saved</button>'
            : `<button class="btn" data-save="${i}">Save</button>`;
          return `<div class="sr-item" role="option" tabindex="0" data-index="${i}" title="View details">
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
  $('#search-input').setAttribute('aria-expanded', 'true');
}

function refreshSearchSavedState() {
  for (const r of search.results) {
    const t = findSaved(r.media_type, r.id);
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
    checkAuth(res);
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

async function saveFromSearch(index, btn) {
  const r = search.results[index];
  if (!r) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await saveTitle(r.media_type, r.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Save';
    toast(`Couldn't save: ${e.message}`);
  }
}

function openSearchResult(index) {
  const r = search.results[index];
  if (!r) return;
  hideSearch();
  const saved = findSaved(r.media_type, r.id);
  if (saved) openPanel(saved.id);
  else openPreview(r);
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
      hideSearch();
      input.blur();
    }
  });
  box.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('button[data-save]');
    if (saveBtn) return saveFromSearch(Number(saveBtn.dataset.save), saveBtn);
    if (e.target.closest('button')) return; // disabled "Saved"
    const item = e.target.closest('.sr-item');
    if (item) openSearchResult(Number(item.dataset.index));
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('sr-item')) {
      e.preventDefault();
      openSearchResult(Number(e.target.dataset.index));
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search')) hideSearch();
  });
}

// ---------- detail panel ----------

let lastFocus = null;

function showPanel() {
  if (!$('#panel').hidden) return;
  lastFocus = document.activeElement;
  $('#panel').hidden = false;
  $('#panel-backdrop').hidden = false;
  document.body.classList.add('no-scroll');
  $('#panel').scrollTop = 0;
  $('#panel-close').focus();
}

function openPanel(id) {
  state.openId = id;
  state.preview = null;
  renderPanel();
  showPanel();
  $('#panel').scrollTop = 0;
}

// Unsaved search result: show basic info right away, then load full details.
async function openPreview(r) {
  const key = `${r.media_type}:${r.id}`;
  state.openId = null;
  state.preview = {
    key,
    media_type: r.media_type,
    tmdb_id: r.id,
    loading: true,
    error: null,
    title: { media_type: r.media_type, tmdb_id: r.id, title: r.title, year: r.year, poster_path: r.poster_path },
  };
  renderPanel();
  showPanel();
  $('#panel').scrollTop = 0;
  try {
    const data = await api(`/api/preview/${r.media_type}/${r.id}`);
    if (state.preview?.key !== key) return; // panel moved on
    const saved = data.saved_id && state.titles.find((t) => t.id === data.saved_id);
    if (saved) return openPanel(saved.id);
    state.preview.title = data.title;
    state.preview.loading = false;
  } catch (e) {
    if (state.preview?.key !== key) return;
    state.preview.loading = false;
    state.preview.error = e.message;
  }
  renderPanel();
}

function closePanel() {
  state.openId = null;
  state.preview = null;
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
  const fmt = (v) =>
    t.media_type === 'movie' ? `${formatDate(v)}${isFuture(v) ? ` <span class="muted small">(${esc(relDate(v))})</span>` : ''}` : esc(v);
  return `<dl class="dates">${rows.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${fmt(v)}</dd>`).join('')}</dl>`;
}

// Streaming (flatrate) providers only, with names.
function providersHtml(t) {
  const list = providers(t).flatrate;
  if (!list.length) return '<p class="muted small">Not streaming in the US right now.</p>';
  return `<div class="prov-group">
    <div class="logos">${logoImgs(list)}</div>
    <div class="muted small" style="margin-top:6px">${esc(list.map((p) => p.name).join(', '))}</div>
  </div>`;
}

const SILHOUETTE = `<svg viewBox="0 0 40 60" aria-hidden="true"><rect width="40" height="60" fill="#ececec"/><circle cx="20" cy="22" r="9" fill="#c9c9c9"/><path d="M4 60c0-12 7.2-19 16-19s16 7 16 19z" fill="#c9c9c9"/></svg>`;

function namesRow(label, plural, names) {
  if (!names?.length) return '';
  return `<dt>${names.length > 1 ? plural : label}</dt><dd>${esc(names.join(', '))}</dd>`;
}

function creditsHtml(t) {
  const c = t.credits;
  if (!c) return '';
  const crew =
    t.media_type === 'movie'
      ? namesRow('Director', 'Directors', c.directors)
      : namesRow('Created by', 'Created by', c.created_by);
  const cast = (c.cast || [])
    .map((p) => {
      const photo = p.profile_path
        ? `<img src="${IMG}w185${esc(p.profile_path)}" alt="" loading="lazy">`
        : SILHOUETTE;
      return `<li class="cast-member">
          <div class="cast-photo">${photo}</div>
          <div class="cast-name">${esc(p.name)}</div>
          ${p.character ? `<div class="cast-character">${esc(p.character)}</div>` : ''}
        </li>`;
    })
    .join('');
  if (!crew && !cast) return '';
  return `<h3>Cast &amp; crew</h3>
    ${crew ? `<dl class="dates crew">${crew}</dl>` : ''}
    ${cast ? `<ul class="cast-row" aria-label="Top cast">${cast}</ul>` : ''}`;
}

function trailerHtml(t) {
  if (!t.trailer_key) return '';
  return `<h3>Trailer</h3>
    <div class="trailer">
      <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.trailer_key)}"
        title="${esc(t.title)} trailer" loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen></iframe>
    </div>`;
}

function renderPanel() {
  const saved = state.openId != null ? state.titles.find((x) => x.id === state.openId) : null;
  const preview = state.preview;
  if (!saved && !preview) return closePanel();
  const t = saved || preview.title;
  const loading = !saved && preview.loading;
  const error = !saved && preview.error;

  const head = `
    <div class="panel-head">
      ${posterImg(t, 'w342')}
      <div>
        <h2 id="panel-title">${esc(t.title)}</h2>
        <div class="sub">${[t.year, t.media_type === 'movie' ? 'Movie' : 'Series', t.media_type === 'tv' ? t.networks : null].filter(Boolean).map(esc).join(' · ')}</div>
        ${loading ? '' : ratingsHtml(t)}
        ${!loading && statusLine(t) ? `<div class="status-line" style="margin-top:8px">${esc(statusLine(t))}</div>` : ''}
      </div>
    </div>`;

  const actions = saved
    ? `<button class="btn saved" disabled>Saved</button>
       <button class="btn ghost" data-action="refresh">Refresh data</button>
       <button class="btn ghost" data-action="delete">Remove</button>
       <span class="muted small">${t.last_refreshed_at ? `Updated ${esc(formatDate(t.last_refreshed_at.slice(0, 10)))}` : ''}</span>`
    : `<button class="btn" data-action="save">Save to list</button>`;

  if (loading || error) {
    $('#panel-body').innerHTML = `${head}
      <p class="muted">${loading ? 'Loading details…' : `Couldn't load details: ${esc(error)}`}</p>
      <div class="panel-actions">${actions}</div>`;
    return;
  }

  $('#panel-body').innerHTML = `
    ${head}
    <div class="panel-actions panel-actions-top">${actions}</div>
    ${t.overview ? `<p class="overview">${esc(t.overview)}</p>` : ''}

    <h3>${t.media_type === 'movie' ? 'US release dates' : 'Series info'}</h3>
    ${datesHtml(t)}

    ${trailerHtml(t)}

    ${creditsHtml(t)}

    <h3>Streaming (US)</h3>
    ${providersHtml(t)}
    ${t.imdb_id ? `<div class="links"><a href="https://www.imdb.com/title/${esc(t.imdb_id)}/" target="_blank" rel="noopener">IMDb ↗</a></div>` : ''}`;
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

async function saveFromPanel(btn) {
  const p = state.preview;
  if (!p) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const title = await saveTitle(p.media_type, p.tmdb_id);
    if (state.preview?.key === p.key) {
      state.preview = null;
      state.openId = title.id;
      renderPanel();
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Save to list';
    toast(`Couldn't save: ${e.message}`);
  }
}

function setupPanel() {
  $('#panel-close').addEventListener('click', closePanel);
  $('#panel-backdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#panel').hidden) closePanel();
  });
  $('#panel-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'refresh') refreshTitle(state.openId, btn);
    if (btn.dataset.action === 'delete') removeTitle(state.openId);
    if (btn.dataset.action === 'save') saveFromPanel(btn);
  });
}

// ---------- init ----------

setupList();
setupSearch();
setupPanel();
render();
loadTitles();
