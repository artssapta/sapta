// The SAPTA admin application: Request → Response. Runtime-independent; the
// Cloudflare Worker (admin/worker.mjs) and the local Node server
// (admin-server.mjs) are thin adapters around createApp().
import {
  createTokenCodec, randomToken, safeEqual, readCookie, cookieNames, serializeCookie, SESSION_TTL_SECONDS,
} from './session.mjs';
import { createGoogleAuth, GoogleAuthError, OAUTH_TTL_SECONDS } from './google.mjs';
import {
  signUpload, listTaggedResources, checkCloudinary, deleteResources, createFolder,
  listSubfolders, renameFolder, deleteFolder, moveAsset,
} from './cloudinary.mjs';
import { cloudinaryAsset } from '../public/shared/cloudinary-url.mjs';
import {
  validateEvent, validateRegistration, eventFromFile, registrationFromFile, stringifyFrontmatter, normalizeSlug,
  eventPath, registrationPath, ValidationError, SLUG_RE, REGISTRATION_IDS, EVENTS_DIR, REGISTRATIONS_DIR,
} from './content.mjs';
import { StoreError } from './stores/errors.mjs';

const MB = 1024 * 1024;
const STATIC = { '/': '/index.html', '/admin.js': '/admin.js', '/shared/cloudinary-url.mjs': '/shared/cloudinary-url.mjs' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param config  from readConfig()
 * @param store   content store (stores/github.mjs or stores/fs.mjs)
 * @param assets  async (path) => Response for files in admin/public
 */
export function createApp({ config, store, assets, fetchImpl = fetch }) {
  const codec = createTokenCodec(config.sessionSecret);
  const names = cookieNames(config.secure);
  const google = createGoogleAuth(config.google, { codec, fetchImpl });
  const canonicalHost = new URL(config.origin).host;
  const allowedHosts = new Set([canonicalHost]);
  if (!config.secure) {
    const port = new URL(config.origin).port;
    for (const h of ['localhost', '127.0.0.1', '[::1]']) allowedHosts.add(port ? `${h}:${port}` : h);
  }
  let mediaCache = { at: 0, items: [] };

  const imageSources = ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com', config.siteUrl].filter(Boolean).join(' ');
  const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src ${imageSources}`,
    `media-src ${imageSources}`,
    // Uploads go straight from the browser to Cloudinary.
    "connect-src 'self' https://api.cloudinary.com",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  // ---------- responses ----------

  function secureHeaders(headers = new Headers()) {
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
    return headers;
  }

  function json(status, data, cookies = []) {
    const headers = secureHeaders(new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
    for (const c of cookies) headers.append('Set-Cookie', c);
    return new Response(JSON.stringify(data), { status, headers });
  }

  function redirect(location, cookies = []) {
    const headers = secureHeaders(new Headers({ Location: location, 'Cache-Control': 'no-store' }));
    for (const c of cookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers });
  }

  async function staticFile(path) {
    const upstream = await assets(path);
    if (!upstream || !upstream.ok) throw new HttpError(404, 'Not found.');
    const headers = secureHeaders(new Headers({
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
    }));
    return new Response(upstream.body, { status: 200, headers });
  }

  // ---------- sessions ----------

  const sessionCookie = (token, maxAge = SESSION_TTL_SECONDS) => serializeCookie(names.session, token, { maxAge, secure: config.secure });
  const oauthCookie = (value, maxAge = OAUTH_TTL_SECONDS) => serializeCookie(names.oauth, value, { maxAge, secure: config.secure, sameSite: 'Lax' });

  function currentUser(request) {
    const payload = codec.verify('session', readCookie(request, names.session));
    // Re-checked on every request, so removing an address from
    // ADMIN_GOOGLE_EMAILS takes effect immediately.
    if (!payload || !config.google.allowedEmails.has(payload.sub)) return null;
    return { email: payload.sub, csrf: payload.csrf };
  }

  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw new HttpError(401, 'Your session has ended. Please log in again.');
    if (!['GET', 'HEAD'].includes(request.method)) {
      // Same-origin check plus a per-session token in a custom header; a
      // cross-site page can send neither.
      const origin = request.headers.get('origin');
      if (origin && origin !== config.origin && !(!config.secure && allowedHosts.has(safeHost(origin)))) {
        throw new HttpError(403, 'Cross-site request blocked.');
      }
      const site = request.headers.get('sec-fetch-site');
      if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'Cross-site request blocked.');
      if (!safeEqual(request.headers.get('x-csrf-token'), user.csrf)) throw new HttpError(403, 'Security token missing or outdated. Reload the page.');
    }
    return user;
  }

  function safeHost(origin) {
    try { return new URL(origin).host; } catch { return ''; }
  }

  async function readJson(request) {
    if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Expected JSON.');
    const text = await request.text();
    if (text.length > MB) throw new HttpError(413, 'Request is too large.');
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Request is not valid JSON.'); }
  }

  const commitMessage = (summary, user) => `Admin${store.drafts ? ' (draft)' : ''}: ${summary}\n\nEdited by ${user.email} via the SAPTA admin.`;
  const eventFolder = slug => `${config.cloudinary.folder}/events/${slug}`;
  // Free-standing folders (not tied to an event) live here.
  const customRoot = () => `${config.cloudinary.folder}/folders`;

  /** Folder names people type: letters (any language), numbers, spaces, - and _. */
  function folderName(value) {
    const name = String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60 || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _-]*$/u.test(name)) {
      throw new HttpError(400, 'Folder names may use letters, numbers, spaces, "-" and "_" (up to 60 characters).');
    }
    return name;
  }

  /** Resolves a folder key from the UI to a Cloudinary folder path. */
  function folderPath(key) {
    const value = String(key ?? '');
    if (value === 'none') return eventFolder('unsorted');
    if (value.startsWith('event:')) {
      const slug = normalizeSlug(value.slice(6));
      if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Invalid event identifier.');
      return eventFolder(slug);
    }
    if (value.startsWith('custom:')) return `${customRoot()}/${folderName(value.slice(7))}`;
    throw new HttpError(400, 'Choose a folder.');
  }

  function requireCloudinary() {
    if (!config.cloudinary.ready) throw new HttpError(503, `Cloudinary is not set up: ${config.cloudinary.problems.join(' ')}`);
  }

  /** Maps a content path to what it is, for the "unpublished changes" list. */
  function describePath(path) {
    const ev = path.match(/^src\/content\/events\/([a-z0-9-]+)\.md$/);
    if (ev) return { kind: 'event', id: ev[1] };
    const reg = path.match(/^src\/content\/registrations\/([a-z0-9-]+)\.md$/);
    if (reg) return { kind: 'registration', id: reg[1] };
    return { kind: 'other', id: path };
  }

  async function previewState(head) {
    if (!config.previewUrl) return { url: null, state: 'not-configured' };
    try {
      const response = await fetchImpl(`${config.previewUrl}/build-info.json?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { url: config.previewUrl, state: 'building' };
      const info = await response.json();
      return { url: config.previewUrl, state: head && info.commit === head ? 'ready' : 'building', builtAt: info.builtAt };
    } catch {
      return { url: config.previewUrl, state: 'unknown' };
    }
  }

  // ---------- content ----------

  async function listEvents() {
    const files = await store.list(EVENTS_DIR);
    return files
      .filter(f => SLUG_RE.test(f.name.slice(0, -3)))
      .map(f => {
        const slug = f.name.slice(0, -3);
        try {
          return { ...eventFromFile(slug, f.text), version: f.version };
        } catch (err) {
          return { slug, title: slug, order: 9999, status: 'past', gallery: [], videos: [], version: f.version, error: `This file could not be read: ${err.message}` };
        }
      })
      .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  }

  /** Cloudinary public IDs referenced by any saved event, mapped to the event title. */
  function usedAssets(events) {
    const used = new Map();
    const note = (url, title) => {
      const asset = cloudinaryAsset(url, config.cloudinary.cloudName);
      if (asset) used.set(`${asset.resourceType}:${asset.publicId}`, title);
    };
    for (const ev of events) {
      note(ev.flyerImage, ev.title);
      for (const g of ev.gallery) note(g.src, ev.title);
      for (const v of ev.videos) if (v.source === 'upload') note(v.file, ev.title);
    }
    return used;
  }

  async function taggedUploads() {
    if (!config.cloudinary.ready) return [];
    if (Date.now() - mediaCache.at > 60_000) {
      try {
        mediaCache = { at: Date.now(), items: await listTaggedResources(config.cloudinary, { fetchImpl }) };
      } catch (err) {
        console.warn(`[media] ${err.message}`);
      }
    }
    return mediaCache.items;
  }

  async function collectMedia() {
    // The three sources are independent, so fetch them in parallel.
    const [events, uploads, assetFiles, customFolders] = await Promise.all([
      listEvents(),
      taggedUploads(),
      Promise.all(['public/assets', 'public/uploads'].map(dir => store.listFiles(dir))).then(lists => lists.flat()),
      config.cloudinary.ready ? listSubfolders(config.cloudinary, customRoot(), { fetchImpl }).catch(err => { console.warn(`[media] ${err.message}`); return []; }) : [],
    ]);
    const used = usedAssets(events);
    const media = new Map();
    // A file used by an event and stored in a folder is one item that shows up
    // in both: the event's folder and the folder it is stored in.
    const add = item => {
      if (!item.url) return;
      const existing = media.get(item.url);
      if (!existing) return media.set(item.url, item);
      if (item.customFolder) existing.customFolder = item.customFolder;
      if (item.deletable !== undefined) existing.deletable = item.deletable;
      if (item.movable) existing.movable = true;
      if (!existing.event && item.event) existing.event = item.event;
    };
    const sourceOf = url => (url.startsWith('https://res.cloudinary.com/') ? 'cloudinary' : url.startsWith('/uploads/') ? 'upload' : 'asset');

    // Each item carries the event folder it belongs to (`event`: slug or null).
    for (const ev of events) {
      const base = { usedIn: ev.title, event: ev.slug };
      if (ev.flyerImage) add({ ...base, url: ev.flyerImage, type: 'photo', source: sourceOf(ev.flyerImage), title: `${ev.title} flyer` });
      for (const g of ev.gallery) add({ ...base, url: g.src, type: 'photo', source: sourceOf(g.src), title: g.alt || `${ev.title} photo` });
      for (const v of ev.videos) if (v.source === 'upload' && v.file) add({ ...base, url: v.file, type: 'video', source: sourceOf(v.file), title: v.title || `${ev.title} video` });
    }
    const folderPrefix = `${config.cloudinary.folder}/events/`;
    const customPrefix = `${customRoot()}/`;
    for (const r of uploads) {
      const asset = cloudinaryAsset(r.url, config.cloudinary.cloudName);
      const usedBy = asset && used.get(`${asset.resourceType}:${asset.publicId}`);
      const folderSlug = r.folder?.startsWith(folderPrefix) ? r.folder.slice(folderPrefix.length).split('/')[0] : null;
      const custom = r.folder?.startsWith(customPrefix) ? r.folder.slice(customPrefix.length).split('/')[0] : null;
      add({
        url: r.url, type: r.type, source: 'cloudinary', title: r.title,
        event: folderSlug && folderSlug !== 'unsorted' ? folderSlug : null,
        customFolder: custom,
        usedIn: usedBy || 'Not used in any event',
        deletable: Boolean(asset && !usedBy && isAdminUpload(asset)),
        movable: Boolean(asset),
      });
    }
    for (const file of assetFiles) {
      const url = file.replace(/^public/, '');
      if (/\.(jpe?g|png|webp|avif|gif)$/i.test(url)) add({ url, type: 'photo', source: sourceOf(url), title: url.split('/').pop(), usedIn: 'Website files', event: null });
      else if (/\.(mp4|webm)$/i.test(url)) add({ url, type: 'video', source: sourceOf(url), title: url.split('/').pop(), usedIn: 'Website files', event: null });
    }
    return { media: [...media.values()], folders: customFolders.sort((a, b) => a.localeCompare(b)) };
  }

  // Only files this admin uploaded (under CLOUDINARY_FOLDER) can be deleted from it.
  const isAdminUpload = asset => asset.publicId.startsWith(`${config.cloudinary.folder}/`);

  /**
   * Deletes uploads that no saved event uses. Each URL is checked against the
   * current events on GitHub, so a photo in use can never be removed.
   */
  async function deleteUploads(urls, user) {
    if (!config.cloudinary.ready) throw new HttpError(503, 'Cloudinary is not set up.');
    if (!Array.isArray(urls) || !urls.length || urls.length > 50) throw new HttpError(400, 'Send between 1 and 50 files to delete.');
    const used = usedAssets(await listEvents());
    const byType = { image: [], video: [] };
    for (const url of urls) {
      const asset = cloudinaryAsset(String(url), config.cloudinary.cloudName);
      if (!asset) throw new HttpError(400, 'Only this site\'s Cloudinary files can be deleted.');
      if (!isAdminUpload(asset)) throw new HttpError(403, 'Only files uploaded through this admin can be deleted here.');
      const usedBy = used.get(`${asset.resourceType}:${asset.publicId}`);
      if (usedBy) throw new HttpError(409, `This file is used in "${usedBy}". Remove it from that event and save, then delete it.`);
      byType[asset.resourceType].push(asset.publicId);
    }
    const results = {};
    for (const [type, ids] of Object.entries(byType)) {
      if (ids.length) Object.assign(results, await deleteResources(config.cloudinary, type, ids, { fetchImpl }));
    }
    mediaCache.at = 0;
    console.log(`[media] ${user.email} deleted ${Object.keys(results).join(', ')}`);
    return results;
  }

  // ---------- routes ----------

  async function route(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    // A request under any other host name (e.g. DNS rebinding) is refused.
    if (!allowedHosts.has(url.host)) throw new HttpError(421, 'Unrecognised host.');

    if (STATIC[pathname]) {
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
      return staticFile(STATIC[pathname]);
    }

    if (pathname === '/auth/google/start' && request.method === 'GET') {
      // The redirect URI registered with Google uses the canonical host.
      if (url.host !== canonicalHost) return redirect(`${config.origin}/auth/google/start`);
      const { url: googleUrl, cookie } = google.start();
      return redirect(googleUrl, [oauthCookie(cookie)]);
    }

    if (pathname === '/auth/google/callback' && request.method === 'GET') {
      const clear = oauthCookie('', 0);
      try {
        const email = await google.finish({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          cookie: readCookie(request, names.oauth),
        });
        console.log(`[auth] signed in: ${email}`);
        const token = codec.sign('session', { sub: email, csrf: randomToken() }, SESSION_TTL_SECONDS);
        return redirect('/', [clear, sessionCookie(token)]);
      } catch (err) {
        if (!(err instanceof GoogleAuthError)) throw err;
        return redirect(`/?login_error=${encodeURIComponent(err.message)}`, [clear]);
      }
    }

    if (pathname === '/auth/logout' && request.method === 'POST') {
      requireUser(request);
      return json(200, { ok: true }, [sessionCookie('', 0)]);
    }

    if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');

    if (pathname === '/api/me' && request.method === 'GET') {
      const user = currentUser(request);
      if (!user) return json(401, { authenticated: false });
      return json(200, {
        authenticated: true,
        user: user.email,
        csrfToken: user.csrf,
        siteUrl: config.siteUrl,
        publishes: store.publishes,
        drafts: Boolean(store.drafts),
        previewUrl: config.previewUrl || null,
        cloudinary: { ready: config.cloudinary.ready, cloudName: config.cloudinary.cloudName },
        limits: config.limits,
      });
    }

    const user = requireUser(request);

    if (pathname === '/api/status' && request.method === 'GET') {
      const [storage, cloudinary] = await Promise.all([store.check(), checkCloudinary(config.cloudinary, { fetchImpl })]);
      return json(200, {
        storage, cloudinary,
        folder: `${config.cloudinary.folder}/events/<event>`,
        limitsMb: { photo: config.limits.photo / MB, video: config.limits.video / MB },
        allowedEmails: [...config.google.allowedEmails],
      });
    }

    if (pathname === '/api/events' && request.method === 'GET') {
      return json(200, { events: await listEvents() });
    }

    if (pathname === '/api/events' && request.method === 'POST') {
      const body = await readJson(request);
      const { slug, data } = validateEvent(body, { cloudName: config.cloudinary.cloudName || '-' });
      const text = stringifyFrontmatter(data);
      const version = body.isNew === true
        ? await store.create(eventPath(slug), text, commitMessage(`add event "${data.title}"`, user))
        : await store.update(eventPath(slug), text, String(body.version || ''), commitMessage(`update event "${data.title}"`, user));
      mediaCache.at = 0;
      if (body.isNew === true && config.cloudinary.ready) {
        createFolder(config.cloudinary, eventFolder(slug), { fetchImpl }).catch(err => console.warn(`[media] ${err.message}`));
      }
      return json(200, { ok: true, slug, version, publishes: store.publishes, drafts: Boolean(store.drafts) });
    }

    const eventMatch = pathname.match(/^\/api\/events\/([^/]+)$/);
    if (eventMatch && request.method === 'DELETE') {
      const slug = normalizeSlug(decodeURIComponent(eventMatch[1]));
      await store.remove(eventPath(slug), url.searchParams.get('version') || '', commitMessage(`delete event "${slug}"`, user));
      return json(200, { ok: true, publishes: store.publishes, drafts: Boolean(store.drafts) });
    }

    // ---------- drafts ----------

    if (pathname === '/api/drafts' && request.method === 'GET') {
      if (!store.drafts) return json(200, { enabled: false });
      const { changes, head, problem } = await store.pending();
      return json(200, {
        enabled: true,
        head,
        problem,
        changes: changes.map(c => ({ ...c, ...describePath(c.path) })),
        preview: await previewState(head),
      });
    }

    if (pathname === '/api/drafts/publish' && request.method === 'POST') {
      if (!store.drafts) throw new HttpError(400, 'Drafts are not enabled.');
      const body = await readJson(request);
      const { changes } = await store.pending();
      const summary = changes.map(c => describePath(c.path)).map(d => `${d.kind} ${d.id}`).join(', ') || 'no content changes';
      const result = await store.publish({
        expectedHead: String(body.head || ''),
        message: `Publish: ${summary}\n\nPublished by ${user.email} via the SAPTA admin.`,
      });
      console.log(`[drafts] ${user.email} published: ${summary}`);
      return json(200, { ok: true, ...result });
    }

    if (pathname === '/api/drafts/discard' && request.method === 'POST') {
      if (!store.drafts) throw new HttpError(400, 'Drafts are not enabled.');
      const body = await readJson(request);
      if (body.all === true) {
        await store.discard(null, '');
      } else {
        const path = body.kind === 'event' ? eventPath(normalizeSlug(body.id)) : body.kind === 'registration' ? registrationPath(String(body.id)) : null;
        if (!path) throw new HttpError(400, 'Say which draft to discard.');
        await store.discard(path, commitMessage(`discard draft of ${body.kind} "${body.id}"`, user));
      }
      return json(200, { ok: true });
    }

    if (pathname === '/api/registrations' && request.method === 'GET') {
      const files = await store.list(REGISTRATIONS_DIR);
      const registrations = [];
      for (const id of REGISTRATION_IDS) {
        const file = files.find(f => f.name === `${id}.md`);
        if (file) registrations.push({ ...registrationFromFile(id, file.text), version: file.version });
      }
      return json(200, { registrations });
    }

    const regMatch = pathname.match(/^\/api\/registrations\/([^/]+)$/);
    if (regMatch && request.method === 'POST') {
      const id = regMatch[1];
      const path = registrationPath(id);
      const body = await readJson(request);
      const fields = validateRegistration(id, body);
      const current = (await store.list(REGISTRATIONS_DIR)).find(f => f.name === `${id}.md`);
      const title = current ? registrationFromFile(id, current.text).title : (id === 'group' ? 'Group Registration' : 'SAPTA Spotlight Registration');
      const version = await store.update(path, stringifyFrontmatter({ title, ...fields }), String(body.version || ''), commitMessage(`${fields.status === 'open' ? 'open' : 'update'} ${title}`, user));
      return json(200, { ok: true, version, publishes: store.publishes, drafts: Boolean(store.drafts) });
    }

    if (pathname === '/api/media' && request.method === 'GET') {
      return json(200, await collectMedia());
    }

    if (pathname === '/api/media/delete' && request.method === 'POST') {
      const body = await readJson(request);
      return json(200, { ok: true, deleted: await deleteUploads(body.urls, user) });
    }

    if (pathname === '/api/uploads/sign' && request.method === 'POST') {
      if (!config.cloudinary.ready) throw new HttpError(503, `Uploads are not set up yet: ${config.cloudinary.problems.join(' ')}`);
      const body = await readJson(request);
      const kind = body.kind === 'video' ? 'video' : body.kind === 'photo' ? 'photo' : null;
      if (!kind) throw new HttpError(400, 'Upload kind must be "photo" or "video".');
      const eventSlug = normalizeSlug(body.event);
      if (eventSlug && !SLUG_RE.test(eventSlug)) throw new HttpError(400, 'Invalid event identifier.');
      const customFolder = body.folder ? folderName(body.folder) : '';
      const size = Number(body.size);
      if (Number.isFinite(size) && size > config.limits[kind]) {
        throw new HttpError(413, `This ${kind} is ${(size / MB).toFixed(1)} MB; the limit is ${config.limits[kind] / MB} MB.${kind === 'video' ? ' Put long videos on YouTube and add the link instead.' : ''}`);
      }
      return json(200, { ...signUpload(config.cloudinary, { kind, eventSlug, customFolder, filename: body.filename, actor: user.email }), maxBytes: config.limits[kind] });
    }

    // ---------- folders ----------

    if (pathname === '/api/folders' && request.method === 'POST') {
      requireCloudinary();
      const name = folderName((await readJson(request)).name);
      if ((await listSubfolders(config.cloudinary, customRoot(), { fetchImpl })).some(f => f.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, `A folder called "${name}" already exists.`);
      }
      await createFolder(config.cloudinary, `${customRoot()}/${name}`, { fetchImpl });
      console.log(`[media] ${user.email} created folder "${name}"`);
      return json(200, { ok: true, name });
    }

    if (pathname === '/api/folders/rename' && request.method === 'POST') {
      requireCloudinary();
      const body = await readJson(request);
      const from = folderName(body.from);
      const to = folderName(body.to);
      if (from === to) return json(200, { ok: true, name: to });
      const existing = await listSubfolders(config.cloudinary, customRoot(), { fetchImpl });
      if (!existing.includes(from)) throw new HttpError(404, `There is no folder called "${from}".`);
      if (existing.some(f => f !== from && f.toLowerCase() === to.toLowerCase())) throw new HttpError(409, `A folder called "${to}" already exists.`);
      await renameFolder(config.cloudinary, `${customRoot()}/${from}`, `${customRoot()}/${to}`, { fetchImpl });
      mediaCache.at = 0;
      console.log(`[media] ${user.email} renamed folder "${from}" → "${to}"`);
      return json(200, { ok: true, name: to });
    }

    if (pathname === '/api/folders/delete' && request.method === 'POST') {
      requireCloudinary();
      const name = folderName((await readJson(request)).name);
      try {
        await deleteFolder(config.cloudinary, `${customRoot()}/${name}`, { fetchImpl });
      } catch (err) {
        if (err.status === 400 || err.status === 409) throw new HttpError(409, 'Only empty folders can be deleted. Move or delete the files in it first.');
        if (err.status === 404) throw new HttpError(404, `There is no folder called "${name}".`);
        throw err;
      }
      console.log(`[media] ${user.email} deleted folder "${name}"`);
      return json(200, { ok: true });
    }

    if (pathname === '/api/media/move' && request.method === 'POST') {
      requireCloudinary();
      const body = await readJson(request);
      const asset = cloudinaryAsset(String(body.url || ''), config.cloudinary.cloudName);
      if (!asset) throw new HttpError(400, 'Only this site\'s Cloudinary files can be moved.');
      const target = folderPath(body.to);
      await createFolder(config.cloudinary, target, { fetchImpl });
      await moveAsset(config.cloudinary, asset, target, { fetchImpl });
      mediaCache.at = 0;
      return json(200, { ok: true, folder: target });
    }

    throw new HttpError(404, 'Not found.');
  }

  return async function handle(request) {
    try {
      return await route(request);
    } catch (err) {
      const known = err instanceof HttpError || err instanceof ValidationError || err instanceof StoreError;
      if (!known) console.error('[admin] unexpected error:', err?.stack || err);
      const status = known ? err.status : 500;
      return json(status, { error: known ? err.message : 'Something went wrong on the server. Please try again.' });
    }
  };
}
