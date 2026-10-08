import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGitHubStore } from '../admin/core/stores/github.mjs';

/**
 * In-memory imitation of the parts of the GitHub API the store uses:
 * branches (refs), contents, three-way merges and compare.
 * Each branch is a Map(path → text); `base` tracks the merge base of drafts.
 */
function fakeRepo(initial) {
  const branches = { main: new Map(Object.entries(initial)) };
  let draftsBase = null; // merge base between main and drafts
  const blob = text => crypto.createHash('sha1').update(text).digest('hex');
  const head = name => crypto.createHash('sha1').update(JSON.stringify([...branches[name]].sort())).digest('hex');
  const reply = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const changedSince = (base, branch) => {
    const paths = new Set([...base.keys(), ...branch.keys()]);
    return [...paths].filter(p => base.get(p) !== branch.get(p));
  };
  const calls = [];

  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/repos/artssapta/sapta', ''));
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push(`${init.method} ${path}`);

    let m;
    if ((m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      return branches[m[1]] ? reply(200, { object: { sha: head(m[1]) } }) : reply(404);
    }
    if (path === '/git/refs' && init.method === 'POST') {
      const name = body.ref.replace('refs/heads/', '');
      branches[name] = new Map(branches.main);
      draftsBase = new Map(branches.main);
      return reply(201, {});
    }
    if ((m = path.match(/^\/git\/refs\/heads\/(.+)$/)) && init.method === 'PATCH') {
      // Only "reset to main" / "fast-forward to the publish commit" are used.
      branches[m[1]] = new Map(branches.main);
      draftsBase = new Map(branches.main);
      return reply(200, {});
    }
    if (path === '/merges') {
      const into = branches[body.base];
      const from = body.head === 'main' || body.head === 'drafts' ? branches[body.head] : branches.drafts;
      const fromName = body.base === 'main' ? 'drafts' : 'main';
      const theirs = changedSince(draftsBase, from);
      if (!theirs.length) return reply(204);
      const ours = changedSince(draftsBase, into);
      if (theirs.some(p => ours.includes(p) && into.get(p) !== from.get(p))) return reply(409, { message: 'Merge conflict' });
      for (const p of theirs) (from.has(p) ? into.set(p, from.get(p)) : into.delete(p));
      if (fromName === 'main') draftsBase = new Map(branches.main);
      return reply(201, { sha: head(body.base) });
    }
    if (path === '/compare/main...drafts') {
      const files = changedSince(draftsBase, branches.drafts).map(p => ({
        filename: p, status: !draftsBase.has(p) ? 'added' : !branches.drafts.has(p) ? 'removed' : 'modified',
      }));
      return reply(200, { files, commits: [{ sha: head('drafts') }] });
    }
    if ((m = path.match(/^\/contents\/(.+)$/))) {
      const name = init.method === 'GET' ? u.searchParams.get('ref') : body.branch;
      const files = branches[name];
      const p = m[1];
      if (init.method === 'GET') {
        if (files.has(p)) return reply(200, { sha: blob(files.get(p)), content: Buffer.from(files.get(p)).toString('base64') });
        const children = [...files.keys()].filter(k => k.startsWith(`${p}/`));
        return children.length ? reply(200, children.map(k => ({ type: 'file', name: k.split('/').pop(), path: k, sha: blob(files.get(k)) }))) : reply(404);
      }
      const current = files.get(p);
      if (init.method === 'PUT') {
        if (current !== undefined && body.sha !== blob(current)) return reply(current !== undefined && !body.sha ? 422 : 409, { message: 'sha' });
        const text = Buffer.from(body.content, 'base64').toString('utf-8');
        files.set(p, text);
        return reply(current === undefined ? 201 : 200, { content: { sha: blob(text) } });
      }
      if (init.method === 'DELETE') {
        if (current === undefined) return reply(404);
        if (body.sha !== blob(current)) return reply(409);
        files.delete(p);
        return reply(200, {});
      }
    }
    throw new Error(`fake GitHub: unhandled ${init.method} ${path}`);
  };
  return { branches, fetchImpl, calls };
}

const EKA = 'src/content/events/eka.md';
const NEW = 'src/content/events/navaratri.md';
const store = repo => createGitHubStore({ token: 't', repo: 'artssapta/sapta', branch: 'main', draftBranch: 'drafts' }, { fetchImpl: repo.fetchImpl });

test('saving goes to the drafts branch; the live branch is untouched until publish', async () => {
  const repo = fakeRepo({ [EKA]: 'eka v1' });
  const s = store(repo);
  assert.equal(s.publishes, false);
  const [eka] = await s.list('src/content/events');
  await s.update(EKA, 'eka v2 (draft)', eka.version, 'm');
  await s.create(NEW, 'navaratri', 'm');

  assert.equal(repo.branches.main.get(EKA), 'eka v1', 'live site unchanged');
  assert.equal(repo.branches.main.has(NEW), false);
  const { changes, head } = await s.pending();
  assert.deepEqual(changes.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: EKA, change: 'modified' }, { path: NEW, change: 'added' },
  ]);

  const result = await s.publish({ message: 'Publish', expectedHead: head });
  assert.equal(result.published, true);
  assert.equal(repo.branches.main.get(EKA), 'eka v2 (draft)');
  assert.equal(repo.branches.main.get(NEW), 'navaratri');
  assert.deepEqual((await s.pending()).changes, [], 'nothing left to publish');
});

test('publishing refuses drafts that changed after they were reviewed', async () => {
  const repo = fakeRepo({ [EKA]: 'eka v1' });
  const s = store(repo);
  await s.create(NEW, 'first', 'm');
  const { head } = await s.pending();
  const nav = (await s.list('src/content/events')).find(f => f.name === 'navaratri.md');
  await s.update(NEW, 'second', nav.version, 'm');
  await assert.rejects(s.publish({ message: 'p', expectedHead: head }), err => err.status === 409);
  assert.equal(repo.branches.main.has(NEW), false);
});

test('changes published another way (Pages CMS) flow into the drafts', async () => {
  const repo = fakeRepo({ [EKA]: 'eka v1' });
  const s = store(repo);
  await s.create(NEW, 'navaratri draft', 'm');
  repo.branches.main.set('src/content/registrations/group.md', 'opened via Pages CMS');
  await s.publish({ message: 'p' });
  assert.equal(repo.branches.main.get('src/content/registrations/group.md'), 'opened via Pages CMS', 'not undone by publishing');
  assert.equal(repo.branches.main.get(NEW), 'navaratri draft');
});

test('a draft that conflicts with a live change is reported, not silently overwritten', async () => {
  const repo = fakeRepo({ [EKA]: 'eka v1' });
  const s = store(repo);
  const [eka] = await s.list('src/content/events');
  await s.update(EKA, 'eka draft', eka.version, 'm');
  repo.branches.main.set(EKA, 'eka changed live');
  await assert.rejects(s.publish({ message: 'p' }), err => err.status === 409);
  assert.equal(repo.branches.main.get(EKA), 'eka changed live');
  assert.match((await s.pending()).problem, /conflicts/);
});

test('discard restores one item, or everything, to the live version', async () => {
  const repo = fakeRepo({ [EKA]: 'eka v1' });
  const s = store(repo);
  const [eka] = await s.list('src/content/events');
  await s.update(EKA, 'eka draft', eka.version, 'm');
  await s.create(NEW, 'navaratri', 'm');

  await s.discard(EKA, 'discard');
  assert.equal(repo.branches.drafts.get(EKA), 'eka v1');
  assert.deepEqual((await s.pending()).changes.map(c => c.path), [NEW]);

  await s.discard(NEW, 'discard');
  assert.equal(repo.branches.drafts.has(NEW), false, 'a new, unpublished event is removed');

  const [eka2] = await s.list('src/content/events');
  await s.update(EKA, 'another draft', eka2.version, 'm');
  await s.discard(null);
  assert.deepEqual((await s.pending()).changes, []);
  assert.equal(repo.branches.main.get(EKA), 'eka v1');
});

import { createPreviewTrigger } from '../admin/core/preview.mjs';

test('every change to the drafts asks for a preview rebuild; one call per request', async () => {
  const repo = fakeRepo({ [EKA]: 'eka v1' });
  let changes = 0;
  const s = createGitHubStore({ token: 't', repo: 'artssapta/sapta', branch: 'main', draftBranch: 'drafts' },
    { fetchImpl: repo.fetchImpl, onDraftsChanged: () => { changes++; } });
  await s.list('src/content/events');
  assert.equal(changes, 0, 'reading does not trigger builds');
  await s.create(NEW, 'navaratri', 'm');
  assert.equal(changes, 1);
  repo.branches.main.set('src/content/registrations/group.md', 'published elsewhere');
  await s.pending(); // throttled: no sync yet
  await s.discard(NEW, 'm');
  await s.publish({ message: 'p' });
  assert.ok(changes >= 3, 'discard and publish also rebuild the preview');

  const hookCalls = [];
  const trigger = createPreviewTrigger('https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/abc', {
    fetchImpl: async (url, init) => { hookCalls.push([url, init.method]); return new Response('{}'); },
  });
  await trigger.flush();
  assert.equal(hookCalls.length, 0, 'nothing changed → no build');
  trigger.markChanged(); trigger.markChanged(); trigger.markChanged();
  await trigger.flush();
  assert.deepEqual(hookCalls, [['https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/abc', 'POST']]);
  await trigger.flush();
  assert.equal(hookCalls.length, 1, 'flushed once');
});

test('live check: a later deploy that includes the published commit counts as live', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const status = url.includes('aaaaaaa...bbbbbbb') ? 'ahead' : 'diverged';
    return new Response(JSON.stringify({ status }), { status: 200 });
  };
  const s = createGitHubStore({ token: 't', repo: 'artssapta/sapta', branch: 'main' }, { fetchImpl });
  assert.equal(await s.contains('aaaaaaa', 'aaaaaaa1234'), true, 'same commit, no API call');
  assert.equal(calls.length, 0);
  assert.equal(await s.contains('aaaaaaa', 'bbbbbbb'), true, 'live is newer and includes it');
  assert.equal(await s.contains('ccccccc', 'bbbbbbb'), false);
});
