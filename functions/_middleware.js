// Password protection for the whole app (pages, static assets and /api).
//
// - GET  /login   -> login form
// - POST /login   -> checks APP_PASSWORD, sets a 30-day session cookie
// - GET  /logout  -> clears the cookie
// Everything else requires a valid session: pages redirect to /login, /api returns 401 JSON.
//
// The cookie holds "<expiry>.<HMAC-SHA256(expiry)>" signed with APP_PASSWORD, never the password
// itself. Changing APP_PASSWORD invalidates every existing session.

const COOKIE = '__Host-wl_session';
// Served without login so the login page and "Add to Home Screen" can show the icon.
const PUBLIC_PATHS = new Set(['/favicon.svg', '/apple-touch-icon.png']);
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds
const enc = new TextEncoder();

// ---------- crypto helpers ----------

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return new Uint8Array(sig);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Constant-time string comparison (compares HMACs so lengths always match).
async function safeEqual(a, b) {
  const k = 'compare';
  return equalBytes(await hmac(k, a), await hmac(k, b));
}

async function makeToken(password) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return `${exp}.${b64url(await hmac(password, `session:${exp}`))}`;
}

async function isValidToken(token, password) {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || !sig || exp < Date.now() / 1000) return false;
  return safeEqual(sig, b64url(await hmac(password, `session:${exp}`)));
}

// ---------- HTTP helpers ----------

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const sessionCookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

// Only allow redirects to local paths (no "//evil.com" or "/\evil.com").
function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith('/login') || next.startsWith('/logout')) return '/';
  return next;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders } });
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loginPage({ next = '/', error = '', status = 200 } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Watchlist · Sign in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Watchlist">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; color: #111;
         font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; }
  form { width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  label { font-size: 13px; color: #6b6b6b; }
  input { height: 42px; padding: 0 12px; border: 1px solid #ddd; border-radius: 8px; font: inherit; }
  input:focus { outline: none; border-color: #999; }
  button { height: 42px; border: 0; border-radius: 8px; background: #111; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: #b42318; font-size: 14px; margin: 0; }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Watchlist</h1>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <input type="hidden" name="next" value="${esc(next)}">
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    },
  });
}

// ---------- middleware ----------

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const password = env.APP_PASSWORD;

  // Fail closed if the secret is missing.
  if (!password) {
    return new Response('APP_PASSWORD is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  if (PUBLIC_PATHS.has(path) && (request.method === 'GET' || request.method === 'HEAD')) {
    return next();
  }

  if (path === '/logout') {
    return redirect('/login', { 'Set-Cookie': sessionCookie('', 0) });
  }

  const loggedIn = await isValidToken(getCookie(request, COOKIE), password);

  if (path === '/login') {
    if (request.method === 'POST') {
      let form;
      try {
        form = await request.formData();
      } catch {
        return loginPage({ error: 'Invalid request.', status: 400 });
      }
      const target = safeNext(form.get('next'));
      if (await safeEqual(String(form.get('password') || ''), password)) {
        return redirect(target, { 'Set-Cookie': sessionCookie(await makeToken(password), MAX_AGE) });
      }
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      return loginPage({ next: target, error: 'Wrong password.', status: 401 });
    }
    if (loggedIn) return redirect(safeNext(url.searchParams.get('next')));
    return loginPage({ next: safeNext(url.searchParams.get('next')) });
  }

  if (!loggedIn) {
    if (path.startsWith('/api/') || path === '/api') {
      return new Response(JSON.stringify({ error: 'Not logged in' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return redirect(`/login?next=${encodeURIComponent(safeNext(path + url.search))}`);
  }

  const response = await next();
  // Keep authenticated pages out of shared caches.
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}
