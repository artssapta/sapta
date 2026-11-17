// The homepage editor: banner / About / team edits through the API, the
// click-to-edit page on the preview server, and protection of homepage
// pictures in the media library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../admin/core/app.mjs';
import { readConfig } from '../admin/core/config.mjs';
import { createFsStore } from '../admin/core/stores/fs.mjs';
import { createTokenCodec } from '../admin/core/session.mjs';
import { parseFrontmatter } from '../admin/core/content.mjs';

const ADMIN = 'https://admin.example.org';
const PREVIEW = 'https://preview.example.org';
const CLOUD = 'https://res.cloudinary.com/demo/image/upload/v1/sapta/folders/Homepage/banner.jpg';

const HOME = `---
title: Home
blocks:
  - type: hero
    title: SAPTA
    subtitle: Student Artists' Platform
    color: "#6091B0"
    showDonate: true
  - type: about
    title: About SAPTA
    text: We promote Carnatic music.
    image: "/assets/logo.png"
    imageSide: right
  - type: team-grid
    title: Meet the Team
---
`;

const SITE = '<html><head><title>SAPTA</title></head><body><nav>menu</nav><main data-astro-cid-m>'
  + '<section class="hero" style="background-image: url(/x.webp); background-color: #6091B0;" data-astro-cid-h><h1 data-astro-cid-h>OLD</h1></section>'
  + '<div class="about-section" data-astro-cid-a>old about</div>'
  + '<div class="team-container" data-astro-cid-t><div class="team-row reveal" data-astro-cid-r>old</div></div>'
  + '</main><footer>footer</footer></body></html>';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sapta-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['src/content/events', 'src/content/registrations', 'src/content/pages', 'src/content/team']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'src/content/pages/home.md'), HOME);
  const member = (name, role, order) => `---\nname: ${name}\nrole: ${role}\nphoto: /assets/team/${name.toLowerCase()}.png\norder: ${order}\n---\n\n${name} loves music.\n`;
  await fs.writeFile(path.join(root, 'src/content/team/ananya.md'), member('Ananya', 'Founder', 1));
  await fs.writeFile(path.join(root, 'src/content/team/shravya.md'), member('Shravya', 'Co-Founder', 2));
  await fs.writeFile(path.join(root, 'src/content/team/upasana.md'), member('Upasana', 'Co-Founder', 3));

  const deleted = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u === 'https://saptaarts.org/') return new Response(SITE);
    if (u.includes('/resources/') && init?.method === 'DELETE') {
      const ids = new URL(u).searchParams.getAll('public_ids[]');
      deleted.push(...ids);
      return new Response(JSON.stringify({ deleted: Object.fromEntries(ids.map(id => [id, 'deleted'])) }));
    }
    if (u.includes('/resources/')) return new Response(JSON.stringify({ resources: [] }));
    if (u.includes('/folders/')) return new Response('{"folders":[]}');
    throw new Error(`unexpected fetch ${u}`);
  };
  const secret = 'p'.repeat(40);
  const common = {
    SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x', CONTENT_STORE: 'fs', PREVIEW_SECRET: secret,
    CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret',
  };
  const store = createFsStore(root);
  const admin = createApp({ config: readConfig({ ...common, PUBLIC_URL: ADMIN, PREVIEW_ORIGIN: PREVIEW }), store, fetchImpl, assets: async () => null });
  const preview = createApp({ config: readConfig({ ...common, PUBLIC_URL: PREVIEW, ADMIN_ROLE: 'preview', ADMIN_ORIGIN: ADMIN }), store, fetchImpl, assets: async () => null });
  const cookie = `__Host-sapta_session=${createTokenCodec('s'.repeat(40)).sign('session', { sub: 'artssapta@gmail.com', csrf: 'c' }, 600)}`;
  const call = (p, { json, method = json ? 'POST' : 'GET' } = {}) => admin(new Request(`${ADMIN}${p}`, {
    method,
    headers: { Cookie: cookie, 'X-CSRF-Token': 'c', Origin: ADMIN, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  }));
  const read = async rel => fs.readFile(path.join(root, rel), 'utf-8');
  const pass = createTokenCodec(secret).sign('preview', { sub: 'artssapta@gmail.com' }, 600);
  return { root, call, read, preview, pass, deleted };
}

test('homepage: read the editable parts and the team in display order', async t => {
  const { call } = await setup(t);
  const res = await call('/api/homepage');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.page.hero, { title: 'SAPTA', subtitle: "Student Artists' Platform", image: '' });
  assert.equal(data.page.about.imageSide, 'right');
  assert.equal(data.page.team.title, 'Meet the Team');
  assert.deepEqual(data.team.map(m => m.id), ['ananya', 'shravya', 'upasana']);
  assert.equal(data.team[0].bio, 'Ananya loves music.');
  assert.equal(data.team[0].raw, undefined, 'file text is not sent');
  assert.equal(data.defaultBanner, '/assets/hero-banner.png');
});

test('homepage: banner and About edits keep everything else in the file', async t => {
  const { call, read } = await setup(t);
  const { page } = await (await call('/api/homepage')).json();
  const saved = await call('/api/homepage', { json: { section: 'hero', version: page.version, fields: { title: 'SAPTA Arts', subtitle: '', image: CLOUD } } });
  assert.equal(saved.status, 200);
  const { data } = parseFrontmatter(await read('src/content/pages/home.md'));
  assert.deepEqual(data.blocks[0], { type: 'hero', title: 'SAPTA Arts', color: '#6091B0', showDonate: true, image: CLOUD });
  assert.equal(data.blocks[1].text, 'We promote Carnatic music.');

  // An outdated version is a conflict, not a silent overwrite.
  const stale = await call('/api/homepage', { json: { section: 'team', version: page.version, fields: { title: 'Team' } } });
  assert.equal(stale.status, 409);

  const { version } = await saved.json();
  const about = await call('/api/homepage', { json: { section: 'about', version, fields: { title: 'Who we are', text: 'Line one.\nLine two.', image: '/assets/logo.png', imageSide: 'left' } } });
  assert.equal(about.status, 200);
  const after = parseFrontmatter(await read('src/content/pages/home.md')).data.blocks[1];
  assert.deepEqual(after, { type: 'about', title: 'Who we are', text: 'Line one.\nLine two.', image: '/assets/logo.png', imageSide: 'left' });

  // Back to the original banner: the image field is removed.
  const v2 = (await about.json()).version;
  await call('/api/homepage', { json: { section: 'hero', version: v2, fields: { title: 'SAPTA Arts', image: '' } } });
  assert.equal(parseFrontmatter(await read('src/content/pages/home.md')).data.blocks[0].image, undefined);
});

test('homepage: pictures must be this site\'s, text is limited, required text is required', async t => {
  const { call } = await setup(t);
  const { page } = await (await call('/api/homepage')).json();
  const bad = [
    { section: 'hero', fields: { title: 'x', image: 'https://evil.example.com/a.jpg' } },
    { section: 'hero', fields: { title: 'x', image: 'javascript:alert(1)' } },
    { section: 'hero', fields: { title: '' } },
    { section: 'about', fields: { title: 'x', text: 'y', image: '/assets/../../etc/passwd', imageSide: 'left' } },
    { section: 'about', fields: { title: 'x', text: 'y', image: '/assets/logo.png', imageSide: 'top' } },
    { section: 'hero', fields: { title: 'x'.repeat(101) } },
    { section: 'footer', fields: {} },
  ];
  for (const body of bad) {
    const res = await call('/api/homepage', { json: { ...body, version: page.version } });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('team: add, edit, reorder and remove members', async t => {
  const { call, read, root } = await setup(t);
  const added = await call('/api/team', { json: { name: 'Priya Rāman', role: 'Member', bio: 'Sings.', photo: CLOUD } });
  assert.equal(added.status, 200);
  const { id } = await added.json();
  assert.equal(id, 'priya-raman');
  const file = parseFrontmatter(await read('src/content/team/priya-raman.md'));
  assert.deepEqual(file.data, { name: 'Priya Rāman', role: 'Member', photo: CLOUD, order: 4 });
  assert.equal(file.body, 'Sings.');
  // Same name again gets its own file.
  assert.equal((await (await call('/api/team', { json: { name: 'Priya Raman', photo: CLOUD } })).json()).id, 'priya-raman-2');
  assert.equal((await call('/api/team', { json: { name: 'No Photo' } })).status, 400);

  let { team } = await (await call('/api/homepage')).json();
  const ananya = team.find(m => m.id === 'ananya');
  const edited = await call('/api/team/ananya', { json: { name: 'Ananya Aiyer', role: 'Member', bio: 'New bio.', photo: ananya.photo, version: ananya.version } });
  assert.equal(edited.status, 200);
  const ananyaFile = parseFrontmatter(await read('src/content/team/ananya.md'));
  assert.equal(ananyaFile.data.role, 'Member');
  assert.equal(ananyaFile.data.order, 1, 'order is kept');
  assert.equal(ananyaFile.body, 'New bio.');

  // Reorder: move Upasana to the top.
  ({ team } = await (await call('/api/homepage')).json());
  const order = ['upasana', 'ananya', 'shravya', 'priya-raman', 'priya-raman-2'];
  const moved = await call('/api/team/order', { json: { members: order.map(i => ({ id: i, version: team.find(m => m.id === i).version })) } });
  assert.equal(moved.status, 200);
  ({ team } = await (await call('/api/homepage')).json());
  assert.deepEqual(team.map(m => m.id), order);
  // Bios survive the reorder.
  assert.equal(parseFrontmatter(await read('src/content/team/upasana.md')).body, 'Upasana loves music.');
  // A stale or incomplete list is refused.
  assert.equal((await call('/api/team/order', { json: { members: order.map(i => ({ id: i, version: 'old' })) } })).status, 409);
  assert.equal((await call('/api/team/order', { json: { members: [{ id: 'ananya', version: 'x' }] } })).status, 409);

  const priya = team.find(m => m.id === 'priya-raman-2');
  assert.equal((await call(`/api/team/priya-raman-2?version=${priya.version}`, { method: 'DELETE' })).status, 200);
  await assert.rejects(fs.access(path.join(root, 'src/content/team/priya-raman-2.md')));
  // Identifiers can't reach other files.
  assert.equal((await call('/api/team/..%2Fpages%2Fhome', { json: { name: 'x', photo: CLOUD } })).status, 404);
});

test('homepage changes need a login and the security token', async t => {
  const { preview, root } = await setup(t);
  const app = createApp({
    config: readConfig({ SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x', CONTENT_STORE: 'fs', PUBLIC_URL: ADMIN, CLOUDINARY_CLOUD_NAME: 'demo' }),
    store: createFsStore(root), fetchImpl: async () => new Response('{}'), assets: async () => null,
  });
  assert.equal((await app(new Request(`${ADMIN}/api/homepage`))).status, 401);
  const cookie = `__Host-sapta_session=${createTokenCodec('s'.repeat(40)).sign('session', { sub: 'artssapta@gmail.com', csrf: 'c' }, 600)}`;
  const noToken = await app(new Request(`${ADMIN}/api/team`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"x"}' }));
  assert.equal(noToken.status, 403);
  // The preview server never accepts content changes.
  assert.equal((await preview(new Request(`${PREVIEW}/api/homepage`, { method: 'POST' }))).status, 404);
});

test('click-to-edit page: drafts rendered into the real homepage, framed only by the admin', async t => {
  const { call, preview, pass } = await setup(t);
  const { page } = await (await call('/api/homepage')).json();
  await call('/api/homepage', { json: { section: 'hero', version: page.version, fields: { title: 'Draft <Title>', image: CLOUD } } });

  const res = await preview(new Request(`${PREVIEW}/preview/home?edit=1&y=250&token=${encodeURIComponent(pass)}`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(res.headers.get('content-security-policy'), `frame-ancestors ${ADMIN}`);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.match(html, /<nav>menu<\/nav><main data-astro-cid-m><section class="hero" style="background-image: url\(https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/f_auto,q_auto,c_limit,w_1600\/v1\/sapta\/folders\/Homepage\/banner\.jpg\);/);
  assert.match(html, /<h1 data-astro-cid-h>Draft &lt;Title&gt;<\/h1>/, 'escaped, with the hero\'s style scope');
  assert.match(html, /<div class="team-row reveal" data-astro-cid-r>/, 'team rows keep their own style scope');
  assert.doesNotMatch(html, /OLD|old about/);
  assert.match(html, /<footer>footer<\/footer>/);
  assert.match(html, /"members":\["ananya","shravya","upasana"\]/);
  assert.match(html, /"adminOrigin":"https:\/\/admin\.example\.org"/);
  assert.match(html, /"scrollY":250/);
  assert.match(html, /Click any picture or text to change it/);

  // Without edit mode: a normal preview that nobody may frame.
  const plain = await preview(new Request(`${PREVIEW}/preview/home?token=${encodeURIComponent(pass)}`));
  assert.equal(plain.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(plain.headers.get('x-frame-options'), 'DENY');
  assert.doesNotMatch(await plain.text(), /sapta-edit/);

  // No pass, no page.
  assert.equal((await preview(new Request(`${PREVIEW}/preview/home?edit=1`))).status, 401);
});

test('admin page may frame only the preview server', async t => {
  const { root } = await setup(t);
  const app = createApp({
    config: readConfig({ SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x', CONTENT_STORE: 'fs', PUBLIC_URL: ADMIN, PREVIEW_ORIGIN: PREVIEW, PREVIEW_SECRET: 'p'.repeat(40) }),
    store: createFsStore(root), fetchImpl: async () => new Response('{}'),
    assets: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }),
  });
  const csp = (await app(new Request(`${ADMIN}/`))).headers.get('content-security-policy');
  assert.match(csp, new RegExp(`frame-src ${PREVIEW}(;|$)`));
  assert.match(csp, /frame-ancestors 'none'/);
});

test('media library: pictures used on the homepage cannot be deleted', async t => {
  const { call, deleted } = await setup(t);
  const { page } = await (await call('/api/homepage')).json();
  await call('/api/homepage', { json: { section: 'hero', version: page.version, fields: { title: 'SAPTA', image: CLOUD } } });
  const refused = await call('/api/media/delete', { json: { urls: [CLOUD] } });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Homepage banner/);
  assert.deepEqual(deleted, []);
  const media = await (await call('/api/media')).json();
  assert.equal(media.media.find(m => m.url === CLOUD)?.usedIn, 'Homepage banner');
});
