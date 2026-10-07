import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../admin/core/app.mjs';
import { readConfig } from '../admin/core/config.mjs';
import { createFsStore } from '../admin/core/stores/fs.mjs';
import { parseFrontmatter } from '../admin/core/content.mjs';

const ORIGIN = 'https://admin.example.org';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';

async function setup(t, envOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sapta-app-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src/content/events'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/content/registrations'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/assets/eka_flyer.png'), 'png');
  await fs.writeFile(path.join(root, 'src/content/events/eka.md'), '---\ntitle: Eka\norder: 2\nstatus: past\ndate: March 14, 2026\nflyerImage: /assets/eka_flyer.png\n---\n');
  await fs.writeFile(path.join(root, 'src/content/registrations/group.md'), '---\ntitle: Group Registration\nstatus: coming-soon\nmessage: Soon\nurl: ""\n---\n');

  const google = { claims: null };
  const deleted = [];
  const moved = [];
  const cloudFolders = new Set();
  const fullFolders = new Set();
  const fetchImpl = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const idToken = ['h', Buffer.from(JSON.stringify(google.claims)).toString('base64url'), 's'].join('.');
      return new Response(JSON.stringify({ id_token: idToken }));
    }
    const u = String(url);
    if (u.startsWith('https://saptaarts.org/build-info.json')) return new Response('{"commit":"0000000"}');
    if (u === 'https://saptaarts.org/events/') {
      return new Response('<html><head><title>Events</title></head><body><nav>menu</nav><section class="events-section" data-astro-cid-abc>'
        + '<div class="events-hero" style="background-image: url(/assets/hero_music_banner.png); background-color: #2A7396;" data-astro-cid-abc>'
        + '<h1 data-astro-cid-abc>SAPTA Events</h1></div></section><script>/* tabs */</script></body></html>');
    }
    // Fake Cloudinary folders + moves.
    if (u.includes('/folders/')) {
      const pathname = new URL(u).pathname;
      const path = decodeURIComponent(pathname.slice(pathname.indexOf('/folders/') + '/folders/'.length));
      if (init?.method === 'POST') { cloudFolders.add(path); return new Response('{"success":true}'); }
      if (init?.method === 'PUT') {
        const to = new URLSearchParams(init.body).get('to_folder');
        cloudFolders.delete(path); cloudFolders.add(to);
        return new Response('{}');
      }
      if (init?.method === 'DELETE') {
        if (fullFolders.has(path)) return new Response('{"error":{"message":"Folder is not empty"}}', { status: 400 });
        cloudFolders.delete(path); return new Response('{"deleted":[]}');
      }
      const prefix = `${path}/`;
      const names = [...cloudFolders].filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes('/')).map(f => f.slice(prefix.length));
      return new Response(JSON.stringify({ folders: names.map(name => ({ name, path: prefix + name })) }));
    }
    if (u.includes('/resources/') && init?.method === 'POST') {
      moved.push({ id: decodeURIComponent(new URL(u).pathname.split('/upload/')[1]), to: new URLSearchParams(init.body).get('asset_folder') });
      return new Response('{}');
    }
    if (String(url).includes('/resources/') && init?.method === 'DELETE') {
      const ids = new URL(url).searchParams.getAll('public_ids[]');
      deleted.push(...ids);
      return new Response(JSON.stringify({ deleted: Object.fromEntries(ids.map(id => [id, 'deleted'])) }));
    }
    if (String(url).includes('/resources/')) return new Response(JSON.stringify({ resources: [] }));
    if (String(url).endsWith('/ping')) return new Response('{"status":"ok"}');
    throw new Error(`unexpected fetch ${url}`);
  };
  const config = readConfig({
    PUBLIC_URL: ORIGIN, SESSION_SECRET: 'k'.repeat(40), GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'sec',
    CONTENT_STORE: 'fs', CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret',
    ...envOverrides,
  });
  const assets = async p => (p === '/index.html' ? new Response('<!doctype html><title>x</title>', { headers: { 'Content-Type': 'text/html' } }) : null);
  const handle = createApp({ config, store: createFsStore(root), assets, fetchImpl });
  const call = (p, init = {}) => handle(new Request(new URL(p, ORIGIN), init));

  /** Runs the full Google login and returns an authenticated request helper. */
  async function login(email = 'artssapta@gmail.com', claimOverrides = {}) {
    const start = await call('/auth/google/start');
    const googleUrl = new URL(start.headers.get('location'));
    const oauthCookie = start.headers.getSetCookie()[0].split(';')[0];
    google.claims = {
      iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600,
      nonce: googleUrl.searchParams.get('nonce'), email, email_verified: true, ...claimOverrides,
    };
    const cb = await call(`/auth/google/callback?code=c&state=${googleUrl.searchParams.get('state')}`, { headers: { Cookie: oauthCookie } });
    const session = cb.headers.getSetCookie().find(c => c.startsWith('__Host-sapta_session=') && !c.includes('Max-Age=0'));
    if (!session) return { location: cb.headers.get('location') };
    const cookie = session.split(';')[0];
    const me = await (await call('/api/me', { headers: { Cookie: cookie } })).json();
    const authed = (p, init = {}) => call(p, { ...init, headers: { Cookie: cookie, 'X-CSRF-Token': me.csrfToken, Origin: ORIGIN, ...(init.headers || {}) } });
    return { session, cookie, me, authed, googleUrl };
  }
  return { root, call, login, deleted, moved, cloudFolders, fullFolders };
}

const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('Gmail login: only artssapta@gmail.com gets a session', async t => {
  const { login } = await setup(t);
  const ok = await login();
  assert.equal(ok.me.user, 'artssapta@gmail.com');
  assert.match(ok.session, /__Host-sapta_session=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  assert.equal(ok.googleUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(ok.googleUrl.searchParams.get('redirect_uri'), `${ORIGIN}/auth/google/callback`);

  for (const [email, claims] of [['someone@gmail.com', {}], ['artssapta@gmail.com', { email_verified: false }], ['artssapta@gmail.com', { aud: 'other' }], ['artssapta@gmail.com', { nonce: 'replayed' }]]) {
    const refused = await login(email, claims);
    assert.match(refused.location, /^\/\?login_error=/, `${email} ${JSON.stringify(claims)}`);
  }
});

test('login callback without this browser\'s state cookie is refused', async t => {
  const { call } = await setup(t);
  const start = await call('/auth/google/start');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const res = await call(`/auth/google/callback?code=c&state=${state}`);
  assert.match(res.headers.get('location'), /login_error/);
});

test('removing an address from the allowlist ends its sessions', async t => {
  const a = await setup(t);
  const { cookie } = await a.login();
  // Same secret, different allowlist → the old cookie is no longer accepted.
  const b = await setup(t, { ADMIN_GOOGLE_EMAILS: 'someone.else@gmail.com' });
  assert.equal((await b.call('/api/events', { headers: { Cookie: cookie } })).status, 401);
});

test('API requires a session; changes also require CSRF token and same origin', async t => {
  const { call, login } = await setup(t);
  assert.equal((await call('/api/events')).status, 401);
  const { cookie, authed } = await login();
  const body = { ...json({ status: 'coming-soon', message: 'x' }) };
  assert.equal((await call('/api/registrations/group', { ...body, headers: { ...body.headers, Cookie: cookie } })).status, 403, 'no CSRF token');
  assert.equal((await authed('/api/registrations/group', { ...body, headers: { ...body.headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await authed('/api/registrations/group', { ...body, headers: { ...body.headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('foreign Host names are refused', async t => {
  const { call } = await setup(t);
  const res = await call('https://attacker.example/api/me');
  assert.equal(res.status, 421);
});

test('pages are served with a strict CSP', async t => {
  const { call } = await setup(t);
  const res = await call('/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.cloudinary\.com/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('strict-transport-security'), /max-age/);
});

test('create → edit → conflicting edit → delete, with versions', async t => {
  const { authed, root } = await (async () => { const s = await setup(t); return { ...s, ...(await s.login()) }; })();
  const photos = [1, 2, 3].map(n => `https://res.cloudinary.com/demo/image/upload/v1/sapta/events/navaratri/IMG_000${n}.jpg`);
  const event = {
    isNew: true, slug: 'navaratri', title: 'Navarātri', order: 1, status: 'upcoming', date: 'October 20, 2026',
    flyerImage: photos[0], gallery: photos.map((src, i) => ({ src, alt: `Photo ${i + 1}` })),
  };
  const created = await (await authed('/api/events', json(event))).json();
  assert.equal(created.ok, true);
  const file = parseFrontmatter(await fs.readFile(path.join(root, 'src/content/events/navaratri.md'), 'utf-8')).data;
  assert.deepEqual(file.gallery.map(g => g.src), photos, 'gallery saved in order');

  assert.equal((await authed('/api/events', json(event))).status, 409, 'cannot create over an existing event');

  const update = { ...event, isNew: false, version: created.version, title: 'Navarātri 2026' };
  const updated = await (await authed('/api/events', json(update))).json();
  assert.equal(updated.ok, true);
  const stale = await authed('/api/events', json({ ...update, title: 'Someone else' }));
  assert.equal(stale.status, 409, 'saving an outdated copy is refused');
  assert.match((await stale.json()).error, /changed by someone else/);

  const list = await (await authed('/api/events')).json();
  assert.deepEqual(list.events.map(e => e.slug), ['navaratri', 'eka'], 'sorted by display order');
  assert.equal((await authed(`/api/events/navaratri?version=${created.version}`, { method: 'DELETE' })).status, 409);
  assert.equal((await authed(`/api/events/navaratri?version=${updated.version}`, { method: 'DELETE' })).status, 200);
});

test('path tricks in identifiers never touch other files', async t => {
  const s = await setup(t);
  const { authed } = await s.login();
  for (const slug of ['..%2F..%2Fpackage', '..', 'a%00b', '%2e%2e%2fsecret']) {
    assert.ok([400, 404].includes((await authed(`/api/events/${slug}?version=x`, { method: 'DELETE' })).status), slug);
  }
  const bad = await authed('/api/events', json({ isNew: true, slug: '../../x', title: 'X', order: 1, status: 'past', date: 'd', flyerImage: '/assets/a.png' }));
  assert.equal(bad.status, 400);
});

test('upload signing: signed fields per event, limits enforced, credentials never exposed', async t => {
  const s = await setup(t);
  const { authed } = await s.login();
  const res = await authed('/api/uploads/sign', json({ kind: 'photo', event: 'navaratri', filename: 'IMG_1.HEIC', size: 3_000_000 }));
  const signed = await res.json();
  assert.equal(res.status, 200);
  assert.equal(signed.fields.folder, 'sapta/events/navaratri');
  assert.ok(signed.fields.signature);
  assert.equal(JSON.stringify(signed).includes('secret'), false, 'API secret is never sent to the browser');
  assert.equal((await authed('/api/uploads/sign', json({ kind: 'photo', event: 'x', size: 50 * 1024 * 1024 }))).status, 413);
  assert.equal((await authed('/api/uploads/sign', json({ kind: 'html', event: 'x' }))).status, 400);
  assert.equal((await authed('/api/uploads/sign', json({ kind: 'photo', event: '../x' }))).status, 400);

  const off = await setup(t, { CLOUDINARY_API_SECRET: '' });
  const { authed: authed2 } = await off.login();
  assert.equal((await authed2('/api/uploads/sign', json({ kind: 'photo', event: 'x' }))).status, 503);
});

test('registration save keeps the title and validates the link', async t => {
  const s = await setup(t);
  const { authed } = await s.login();
  const { registrations: [group] } = await (await authed('/api/registrations')).json();
  assert.equal((await authed('/api/registrations/group', json({ version: group.version, status: 'open', message: 'Open now', url: 'javascript:alert(1)' }))).status, 400);
  const ok = await authed('/api/registrations/group', json({ version: group.version, status: 'open', message: 'Open now', url: 'https://forms.gle/abc' }));
  assert.equal(ok.status, 200);
  const data = parseFrontmatter(await fs.readFile(path.join(s.root, 'src/content/registrations/group.md'), 'utf-8')).data;
  assert.deepEqual(data, { title: 'Group Registration', status: 'open', url: 'https://forms.gle/abc', message: 'Open now' });
});

test('status and logout', async t => {
  const s = await setup(t);
  const { authed, cookie } = await s.login();
  const status = await (await authed('/api/status')).json();
  assert.equal(status.cloudinary.ok, true);
  assert.equal(status.storage.ok, true);
  const out = await authed('/auth/logout', { method: 'POST' });
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
  assert.ok(cookie);
});

test('deleting uploads: only unused files uploaded by the admin', async t => {
  const s = await setup(t);
  const { authed } = await s.login();
  const used = 'https://res.cloudinary.com/demo/image/upload/v1/sapta/events/navaratri/used.jpg';
  const unused = 'https://res.cloudinary.com/demo/image/upload/v1/sapta/events/navaratri/unused.jpg';
  const video = 'https://res.cloudinary.com/demo/video/upload/v1/sapta/events/navaratri/clip.mp4';
  await authed('/api/events', json({ isNew: true, slug: 'navaratri', title: 'Navarātri', order: 1, status: 'upcoming', date: 'd', flyerImage: used }));

  const inUse = await authed('/api/media/delete', json({ urls: [used] }));
  assert.equal(inUse.status, 409);
  assert.match((await inUse.json()).error, /used in "Navarātri"/);
  assert.equal((await authed('/api/media/delete', json({ urls: ['https://res.cloudinary.com/demo/image/upload/v1782263309/IMG_8769_zuqazu.jpg'] }))).status, 403, 'not uploaded by the admin');
  assert.equal((await authed('/api/media/delete', json({ urls: ['https://res.cloudinary.com/other/image/upload/v1/sapta/x.jpg'] }))).status, 400);
  assert.deepEqual(s.deleted, [], 'nothing deleted by refused requests');

  const ok = await authed('/api/media/delete', json({ urls: [unused, video] }));
  assert.equal(ok.status, 200);
  assert.deepEqual(s.deleted.sort(), ['sapta/events/navaratri/clip', 'sapta/events/navaratri/unused']);
  assert.equal((await s.call('/api/media/delete', json({ urls: [unused] }))).status, 401, 'requires login');
});

test('folders: create, rename, delete (empty only), move files, upload into them', async t => {
  const s = await setup(t);
  const { authed } = await s.login();
  const post = (p, body) => authed(p, json(body));

  assert.equal((await post('/api/folders', { name: '  Rehearsals   2026 ' })).status, 200);
  assert.ok(s.cloudFolders.has('sapta/folders/Rehearsals 2026'), 'spaces are tidied');
  assert.equal((await post('/api/folders', { name: 'Navarātri' })).status, 200, 'non-English letters are fine');
  assert.equal((await post('/api/folders', { name: 'rehearsals 2026' })).status, 409, 'no duplicates (case-insensitive)');
  for (const bad of ['', '../events', 'a/b', '<script>', 'x'.repeat(61)]) {
    assert.equal((await post('/api/folders', { name: bad })).status, 400, JSON.stringify(bad));
  }

  const media = await (await authed('/api/media')).json();
  assert.deepEqual(media.folders, ['Navarātri', 'Rehearsals 2026']);

  assert.equal((await post('/api/folders/rename', { from: 'Rehearsals 2026', to: 'Navarātri' })).status, 409, 'cannot rename onto an existing folder');
  assert.equal((await post('/api/folders/rename', { from: 'Missing', to: 'X' })).status, 404);
  assert.equal((await post('/api/folders/rename', { from: 'Rehearsals 2026', to: 'Rehearsals' })).status, 200);
  assert.ok(s.cloudFolders.has('sapta/folders/Rehearsals') && !s.cloudFolders.has('sapta/folders/Rehearsals 2026'));

  s.fullFolders.add('sapta/folders/Rehearsals');
  const notEmpty = await post('/api/folders/delete', { name: 'Rehearsals' });
  assert.equal(notEmpty.status, 409);
  assert.match((await notEmpty.json()).error, /Only empty folders/);
  assert.equal((await post('/api/folders/delete', { name: 'Navarātri' })).status, 200);

  const photo = 'https://res.cloudinary.com/demo/image/upload/v1/sapta/events/unsorted/IMG_1.jpg';
  assert.equal((await post('/api/media/move', { url: photo, to: 'custom:Rehearsals' })).status, 200);
  assert.equal((await post('/api/media/move', { url: photo, to: 'event:eka' })).status, 200);
  assert.deepEqual(s.moved, [
    { id: 'sapta/events/unsorted/IMG_1', to: 'sapta/folders/Rehearsals' },
    { id: 'sapta/events/unsorted/IMG_1', to: 'sapta/events/eka' },
  ]);
  assert.equal((await post('/api/media/move', { url: 'https://evil.example/a.jpg', to: 'none' })).status, 400);
  assert.equal((await post('/api/media/move', { url: photo, to: 'custom:../../x' })).status, 400);

  const signed = await (await post('/api/uploads/sign', { kind: 'photo', folder: 'Rehearsals', filename: 'a.jpg', size: 10 })).json();
  assert.equal(signed.fields.folder, 'sapta/folders/Rehearsals');
  assert.equal((await post('/api/uploads/sign', { kind: 'photo', folder: '../events/x' })).status, 400);
});

test('instant preview: real page around the drafts, unsaved edits included, sandboxed', async t => {
  const s = await setup(t);
  assert.equal((await s.call('/preview/events')).status, 401, 'requires login');
  const { authed, cookie, me } = await s.login();

  const saved = await authed('/preview/events');
  const html = await saved.text();
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.match(html, /<base href="https:\/\/saptaarts\.org\/">/);
  assert.match(html, /<nav>menu<\/nav>/, 'site header kept');
  assert.match(html, /data-event-id="eka" data-astro-cid-abc/, 'saved event rendered with the site styles');
  assert.match(html, /PREVIEW — unpublished changes/);

  const form = (event, csrf = me.csrfToken) => ({
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://admin.example.org', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, event: JSON.stringify(event) }).toString(),
  });
  const unsaved = { slug: 'navaratri', title: 'Navarātri <b>', order: 1, status: 'upcoming', date: 'Oct 20', flyerImage: '/assets/f.png' };
  const withEdit = await (await s.call('/preview/events', form(unsaved))).text();
  assert.match(withEdit, /Navarātri &lt;b&gt;/, 'unsaved event shown, escaped');
  assert.match(withEdit, /data-event-id="navaratri"[^>]*>.*data-event-id="eka"/s, 'ordered like the site');
  assert.equal((await s.call('/preview/events', form(unsaved, 'wrong'))).status, 403, 'needs the CSRF token');
  // What browsers really send for a form post from the admin (Referrer-Policy: no-referrer).
  const real = form(unsaved);
  real.headers = { ...real.headers, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await s.call('/preview/events', real)).status, 200, 'same-site form post with Origin: null is allowed');
  const cross = form(unsaved);
  cross.headers = { ...cross.headers, Origin: 'null', 'Sec-Fetch-Site': 'cross-site' };
  assert.equal((await s.call('/preview/events', cross)).status, 403, 'cross-site form post refused');
  const invalid = await s.call('/preview/events', form({ ...unsaved, flyerImage: 'https://evil.example/x.jpg' }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /could not be shown/);
});

test('live status: reports when the published commit is on the live site', async t => {
  const s = await setup(t);
  const { authed } = await s.login();
  // The fake site has no build-info.json → not live yet; invalid input refused.
  assert.equal((await (await authed('/api/live-status?commit=abc1234')).json()).live, false);
  assert.equal((await authed('/api/live-status?commit=../../x')).status, 400);
});
