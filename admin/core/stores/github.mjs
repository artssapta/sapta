// Content store backed by the GitHub repository.
//
// With a draft branch (default "drafts"), every save is a commit on that
// branch: the live site is untouched and a preview site can be built from it.
// publish() merges the drafts into the publishing branch ("main") in one
// commit, which triggers the existing GitHub Pages deployment. Without a draft
// branch, saves are committed straight to the publishing branch.
//
// Versions are git blob SHAs: an update must name the SHA the editor started
// from, and GitHub rejects it if the file has changed since (no lost edits).
import { StoreError, conflict } from './errors.mjs';

const API = 'https://api.github.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const FILE_LIST_TTL_MS = 10 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 1000;
const MAX_CACHED_BLOBS = 300;
const CONTENT_PREFIX = 'src/content/';

export function createGitHubStore({ token, repo, branch, draftBranch = '' }, { fetchImpl = fetch, onDraftsChanged = () => {} } = {}) {
  const drafts = Boolean(draftBranch) && draftBranch !== branch;
  const workBranch = drafts ? draftBranch : branch;

  // A git blob SHA identifies exact file contents, so cached text for a SHA can
  // never be stale. Directory listings are always fetched fresh (they carry the
  // SHAs), so edits made elsewhere are seen immediately.
  const blobCache = new Map();
  const fileListCache = new Map(); // dir → { at, files } for rarely-changing website files
  let draftBranchReady = false;
  let lastSync = 0;
  let syncProblem = null;

  const remember = (sha, text) => {
    if (blobCache.size >= MAX_CACHED_BLOBS) blobCache.delete(blobCache.keys().next().value);
    blobCache.set(sha, text);
  };
  const repoUrl = `${API}/repos/${repo}`;
  const contentsUrl = path => `${repoUrl}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const ref = name => `${repoUrl}/git/ref/heads/${encodeURIComponent(name)}`;

  async function call(method, url, body) {
    const attempts = method === 'GET' ? 3 : 1; // writes are not retried blindly
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'sapta-admin',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        if (attempt < attempts) { await sleep(500 * attempt); continue; }
        throw new StoreError(method === 'GET'
          ? 'Could not reach GitHub. Please try again.'
          : 'GitHub did not respond. Reload the page to check whether your change was saved before trying again.');
      }
      if (response.status >= 500 && attempt < attempts) { await sleep(500 * attempt); continue; }
      const json = response.status === 204 ? {} : await response.json().catch(() => ({}));
      return { status: response.status, json };
    }
  }

  function fail(status, json, what) {
    console.warn(`[github] ${what}: HTTP ${status} ${json.message || ''}`);
    if (status === 401) return new StoreError('The GitHub access token is invalid or has expired. See README → "GitHub access token".', 502);
    if (status === 403 && /rate limit/i.test(json.message || '')) return new StoreError('GitHub rate limit reached. Please wait a few minutes.', 503);
    if (status === 403 || status === 404) return new StoreError(`The GitHub token cannot ${what} in ${repo}. Check its repository access and "Contents: Read and write" permission.`, 502);
    return new StoreError(`GitHub could not ${what} (HTTP ${status}).`, 502);
  }

  const decode = b64 => Buffer.from(b64, 'base64').toString('utf-8');
  const encode = text => Buffer.from(text, 'utf-8').toString('base64');

  async function headSha(name) {
    const { status, json } = await call('GET', ref(name));
    if (status !== 200) throw fail(status, json, `read branch "${name}"`);
    return json.object.sha;
  }

  /** Creates the draft branch from the publishing branch the first time. */
  async function ensureDraftBranch() {
    if (!drafts || draftBranchReady) return;
    const { status, json } = await call('GET', ref(draftBranch));
    if (status === 404) {
      const created = await call('POST', `${repoUrl}/git/refs`, { ref: `refs/heads/${draftBranch}`, sha: await headSha(branch) });
      if (created.status !== 201 && created.status !== 422) throw fail(created.status, created.json, `create branch "${draftBranch}"`);
    } else if (status !== 200) {
      throw fail(status, json, `read branch "${draftBranch}"`);
    }
    draftBranchReady = true;
  }

  /**
   * Brings anything published directly to the live branch (e.g. via Pages CMS)
   * into the drafts, so previews and publishing never undo it.
   */
  async function syncDrafts({ force = false } = {}) {
    if (!drafts) return;
    await ensureDraftBranch();
    if (!force && Date.now() - lastSync < SYNC_INTERVAL_MS) return;
    const { status, json } = await call('POST', `${repoUrl}/merges`, {
      base: draftBranch, head: branch, commit_message: `Admin: bring drafts up to date with ${branch}`,
    });
    lastSync = Date.now();
    if (status === 201 || status === 204) {
      syncProblem = null;
      if (status === 201) changed(); // the drafts now include newly published changes
      return;
    }
    if (status === 409) {
      syncProblem = 'A draft conflicts with a change that was published another way (for example in Pages CMS). Discard the draft for that item and make the change again.';
      throw new StoreError(syncProblem, 409);
    }
    throw fail(status, json, `update branch "${draftBranch}"`);
  }

  // Called after anything changes the drafts branch, e.g. to rebuild the preview.
  const changed = () => { if (drafts) { try { onDraftsChanged(); } catch (err) { console.warn(`[github] ${err.message}`); } } };

  // A merge conflict should not stop people from reading their drafts (it is
  // reported in pending()); any other failure, e.g. no permission, must surface
  // rather than show an empty list.
  const syncQuietly = () => syncDrafts().catch(err => {
    if (err.status === 409) console.warn(`[github] ${err.message}`);
    else throw err;
  });

  return {
    publishes: !drafts,
    drafts,

    async list(dir) {
      await syncQuietly();
      const { status, json } = await call('GET', `${contentsUrl(dir)}?ref=${encodeURIComponent(workBranch)}`);
      if (status === 404) return [];
      if (status !== 200 || !Array.isArray(json)) throw fail(status, json, `read ${dir}`);
      const files = json.filter(item => item.type === 'file' && item.name.endsWith('.md'));
      return Promise.all(files.map(async item => {
        if (blobCache.has(item.sha)) return { name: item.name, version: item.sha, text: blobCache.get(item.sha) };
        const file = await call('GET', `${contentsUrl(item.path)}?ref=${encodeURIComponent(workBranch)}`);
        if (file.status !== 200) throw fail(file.status, file.json, `read ${item.path}`);
        const text = decode(file.json.content);
        remember(file.json.sha, text);
        return { name: item.name, version: file.json.sha, text };
      }));
    },

    async create(path, text, message) {
      await syncDrafts();
      const { status, json } = await call('PUT', contentsUrl(path), { message, content: encode(text), branch: workBranch });
      if (status === 201 || status === 200) { remember(json.content.sha, text); changed(); return json.content.sha; }
      // Without a sha GitHub refuses to overwrite an existing file.
      if (status === 422 && /sha/i.test(json.message || '')) throw new StoreError('An event with this identifier already exists. Choose a different identifier.', 409);
      throw fail(status, json, `create ${path}`);
    },

    async update(path, text, version, message) {
      if (!version) throw conflict();
      await syncDrafts();
      const { status, json } = await call('PUT', contentsUrl(path), { message, content: encode(text), branch: workBranch, sha: version });
      if (status === 200 || status === 201) { remember(json.content.sha, text); changed(); return json.content.sha; }
      if (status === 409) throw conflict();
      if (status === 404 || status === 422) throw new StoreError('This item no longer exists. Reload the page.', 404);
      throw fail(status, json, `update ${path}`);
    },

    async remove(path, version, message) {
      if (!version) throw conflict();
      await syncDrafts();
      const { status, json } = await call('DELETE', contentsUrl(path), { message, sha: version, branch: workBranch });
      if (status === 200) { changed(); return; }
      if (status === 409) throw conflict();
      if (status === 404 || status === 422) throw new StoreError('This item no longer exists. Reload the page.', 404);
      throw fail(status, json, `delete ${path}`);
    },

    async listFiles(dir, depth = 3) {
      const cached = fileListCache.get(dir);
      if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.files;
      const walk = async (path, level) => {
        const { status, json } = await call('GET', `${contentsUrl(path)}?ref=${encodeURIComponent(branch)}`);
        if (status === 404) return [];
        if (status !== 200 || !Array.isArray(json)) throw fail(status, json, `read ${path}`);
        const files = json.filter(i => i.type === 'file').map(i => i.path);
        if (level >= depth) return files;
        const nested = await Promise.all(json.filter(i => i.type === 'dir').map(sub => walk(sub.path, level + 1)));
        return files.concat(...nested);
      };
      const files = await walk(dir, 1);
      fileListCache.set(dir, { at: Date.now(), files });
      return files;
    },

    // ---------- drafts ----------

    /** Content files that differ between the drafts and the live site. */
    async pending() {
      if (!drafts) return { changes: [], head: null, problem: null };
      await syncQuietly();
      const { status, json } = await call('GET', `${repoUrl}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(draftBranch)}`);
      if (status !== 200) throw fail(status, json, 'compare drafts with the live site');
      const changes = (json.files || [])
        .filter(f => f.filename.startsWith(CONTENT_PREFIX))
        .map(f => ({ path: f.filename, change: f.status === 'added' ? 'added' : f.status === 'removed' ? 'removed' : 'modified' }));
      const head = json.commits?.length ? json.commits[json.commits.length - 1].sha : await headSha(draftBranch);
      return { changes, head, problem: syncProblem };
    },

    /**
     * Publishes all drafts in one merge commit. `expectedHead` guards against
     * publishing drafts that changed after the person reviewed them.
     */
    async publish({ message, expectedHead }) {
      if (!drafts) throw new StoreError('Drafts are not enabled.', 400);
      await syncDrafts({ force: true });
      const head = await headSha(draftBranch);
      if (expectedHead && expectedHead !== head) {
        throw new StoreError('The drafts changed after you opened this page. Review the latest changes and publish again.', 409);
      }
      const { status, json } = await call('POST', `${repoUrl}/merges`, { base: branch, head, commit_message: message });
      if (status === 204) return { published: false };
      if (status === 409) throw new StoreError('Publishing hit a conflict with the live site. Discard the conflicting draft and try again.', 409);
      if (status !== 201) throw fail(status, json, 'publish the drafts');
      // Fast-forward the drafts to the published commit. Not forced: if a new
      // draft arrived meanwhile this fails harmlessly and the next sync merges.
      await call('PATCH', `${repoUrl}/git/refs/heads/${encodeURIComponent(draftBranch)}`, { sha: json.sha, force: false });
      lastSync = 0;
      changed();
      return { published: true, commit: json.sha };
    },

    /** Restores one file (or, with no path, everything) to its live version. */
    async discard(path, message) {
      if (!drafts) throw new StoreError('Drafts are not enabled.', 400);
      await ensureDraftBranch();
      if (!path) {
        const { status, json } = await call('PATCH', `${repoUrl}/git/refs/heads/${encodeURIComponent(draftBranch)}`, { sha: await headSha(branch), force: true });
        if (status !== 200) throw fail(status, json, 'discard the drafts');
        syncProblem = null;
        lastSync = Date.now();
        changed();
        return;
      }
      const [live, draft] = await Promise.all([
        call('GET', `${contentsUrl(path)}?ref=${encodeURIComponent(branch)}`),
        call('GET', `${contentsUrl(path)}?ref=${encodeURIComponent(draftBranch)}`),
      ]);
      if (live.status === 200) {
        const { status, json } = await call('PUT', contentsUrl(path), {
          message, content: live.json.content.replace(/\n/g, ''), branch: draftBranch, ...(draft.status === 200 ? { sha: draft.json.sha } : {}),
        });
        if (status !== 200 && status !== 201) throw fail(status, json, `discard the draft of ${path}`);
        changed();
      } else if (live.status === 404 && draft.status === 200) {
        const { status, json } = await call('DELETE', contentsUrl(path), { message, sha: draft.json.sha, branch: draftBranch });
        if (status !== 200) throw fail(status, json, `discard the draft of ${path}`);
        changed();
      }
    },

    /** True when `commit` is part of `head`'s history (head is commit, or later). */
    async contains(commit, head) {
      if (!commit || !head) return false;
      if (head.startsWith(commit)) return true;
      const { status, json } = await call('GET', `${repoUrl}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(head)}`);
      return status === 200 && (json.status === 'ahead' || json.status === 'identical');
    },

    async check() {
      const { status, json } = await call('GET', repoUrl);
      if (status !== 200) return { ok: false, detail: fail(status, json, 'access the repository').message };
      // `permissions` describes the account, not the token. To test the token
      // itself, ask to create a branch at a commit that cannot exist: a token
      // with write access gets "invalid" (422), a read-only one gets 403.
      // Nothing is ever created.
      const probe = await call('POST', `${repoUrl}/git/refs`, { ref: 'refs/heads/sapta-admin-permission-check', sha: '0'.repeat(40) });
      if (probe.status === 403 || probe.status === 404) {
        return { ok: false, detail: 'The GitHub token can read the website but not save to it. On GitHub (as artssapta): Settings → Developer settings → Fine-grained tokens → this token → Repository permissions → Contents: "Read and write".' };
      }
      return {
        ok: true,
        detail: drafts
          ? `Saving drafts to ${repo} (branch "${draftBranch}"). Publishing merges them into "${branch}", which updates the website.`
          : `Saving to ${repo} on branch "${branch}". Each save publishes the website automatically.`,
      };
    },
  };
}
