import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubStore } from '../admin/core/stores/github.mjs';

/** A tiny in-memory imitation of the GitHub contents API. */
function fakeGitHub({ failWith } = {}) {
  const files = new Map([['src/content/events/svasthya.md', { text: '---\ntitle: Svāsthya\n---\n', sha: 'sha-1' }]]);
  const calls = [];
  let n = 1;
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method, pathname, ref: searchParams.get('ref'), auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    if (failWith) return reply(failWith, { message: 'Bad credentials' });
    const path = decodeURIComponent(pathname.replace('/repos/artssapta/sapta/contents/', ''));
    if (init.method === 'GET') {
      if (path === 'src/content/events') return reply(200, [...files.keys()].map(p => ({ type: 'file', name: p.split('/').pop(), path: p })));
      const f = files.get(path);
      return f ? reply(200, { sha: f.sha, content: Buffer.from(f.text).toString('base64') }) : reply(404, {});
    }
    const body = JSON.parse(init.body);
    const existing = files.get(path);
    if (init.method === 'PUT') {
      if (existing && !body.sha) return reply(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      if (existing && body.sha !== existing.sha) return reply(409, { message: 'does not match' });
      const sha = `sha-${++n}`;
      files.set(path, { text: Buffer.from(body.content, 'base64').toString('utf-8'), sha });
      return reply(existing ? 200 : 201, { content: { sha } });
    }
    if (init.method === 'DELETE') {
      if (!existing) return reply(404, {});
      if (body.sha !== existing.sha) return reply(409, {});
      files.delete(path);
      return reply(200, {});
    }
  };
  return { files, calls, fetchImpl };
}

const cfg = { token: 'tok', repo: 'artssapta/sapta', branch: 'main' };

test('reads files from the publishing branch with the token, decoding UTF-8', async () => {
  const gh = fakeGitHub();
  const store = createGitHubStore(cfg, { fetchImpl: gh.fetchImpl });
  const [file] = await store.list('src/content/events');
  assert.equal(file.text, '---\ntitle: Svāsthya\n---\n');
  assert.equal(file.version, 'sha-1');
  assert.ok(gh.calls.every(c => c.ref === 'main' && c.auth === 'Bearer tok'));
});

test('create commits a new file and refuses to overwrite an existing one', async () => {
  const gh = fakeGitHub();
  const store = createGitHubStore(cfg, { fetchImpl: gh.fetchImpl });
  const version = await store.create('src/content/events/new.md', 'hello ā', 'Admin: add event');
  assert.ok(version);
  assert.equal(gh.files.get('src/content/events/new.md').text, 'hello ā');
  const put = gh.calls.find(c => c.method === 'PUT');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, 'Admin: add event');
  await assert.rejects(store.create('src/content/events/svasthya.md', 'x', 'm'), err => err.status === 409);
});

test('update with a stale version is a conflict, so concurrent edits are never lost', async () => {
  const gh = fakeGitHub();
  const store = createGitHubStore(cfg, { fetchImpl: gh.fetchImpl });
  const v2 = await store.update('src/content/events/svasthya.md', 'first', 'sha-1', 'm');
  await assert.rejects(store.update('src/content/events/svasthya.md', 'second', 'sha-1', 'm'), err => err.status === 409);
  assert.equal(gh.files.get('src/content/events/svasthya.md').text, 'first');
  await store.update('src/content/events/svasthya.md', 'second', v2, 'm');
  await assert.rejects(store.remove('src/content/events/svasthya.md', 'sha-1', 'm'), err => err.status === 409);
});

test('an invalid or expired token gives an actionable error', async () => {
  const store = createGitHubStore(cfg, { fetchImpl: fakeGitHub({ failWith: 401 }).fetchImpl });
  await assert.rejects(store.list('src/content/events'), /token is invalid or has expired/);
  assert.equal((await store.check()).ok, false);
});

test('unchanged files are served from cache; changed files are re-read', async () => {
  const gh = fakeGitHub();
  // The fake's directory listing must carry each file's sha, as GitHub's does.
  const listing = gh.fetchImpl;
  gh.fetchImpl = async (url, init) => {
    const res = await listing(url, init);
    if (init.method === 'GET' && new URL(url).pathname.endsWith('/src/content/events')) {
      const items = await res.json();
      return new Response(JSON.stringify(items.map(i => ({ ...i, sha: gh.files.get(i.path).sha }))), { status: 200 });
    }
    return res;
  };
  const store = createGitHubStore(cfg, { fetchImpl: gh.fetchImpl });
  const fileReads = () => gh.calls.filter(c => c.method === 'GET' && c.pathname.endsWith('.md')).length;
  await store.list('src/content/events');
  await store.list('src/content/events');
  assert.equal(fileReads(), 1, 'second listing used the cache');
  gh.files.set('src/content/events/svasthya.md', { text: 'changed elsewhere', sha: 'sha-99' });
  const [file] = await store.list('src/content/events');
  assert.equal(file.text, 'changed elsewhere');
  assert.equal(fileReads(), 2);
});
