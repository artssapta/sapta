// SAPTA admin page (ES module). Served under a CSP that forbids inline
// script, so all handlers are wired through the data-action / data-change /
// data-submit dispatchers at the bottom of this file. Every value that comes
// from content files or the server is escaped (esc) or set via textContent.
import { deliveryUrl, cloudinaryThumb } from './shared/cloudinary-url.mjs';

const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="100%" height="100%" fill="#e2e8f0"/>' +
  '<text x="50%" y="50%" fill="#94a3b8" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="middle">No preview</text></svg>'
);
const UPLOAD_CONCURRENCY = 3;
const CHUNK_SIZE = 20 * 1024 * 1024; // Cloudinary chunked uploads above 20 MB
const MB = 1024 * 1024;
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

const state = {
  user: null,
  csrfToken: null,
  siteUrl: '',
  publishes: false,
  cloudinary: { ready: false },
  limits: { photo: 10 * MB, video: 100 * MB },
  events: [],
  registrations: [],
  allMedia: [],
  recentUploads: [],
  mediaFolder: 'all',
  customFolders: [],
  pickerFolder: 'all',
  drafts: false,
  previewUrl: null,
  previewOrigin: null,
  previewPass: null,
  draftChanges: [],
  draftHead: null,
  pickerTarget: null,
  pickerItems: [],
  mediaItems: [],
  isNewEvent: false,
  slugTouched: false,
  uploadsInFlight: 0,
  mediaLoaded: false,
  mediaStale: true,
  // Cloudinary URLs uploaded while the event editor is open and not yet saved,
  // so they can be cleaned up if removed or the edit is cancelled.
  freshUploads: new Set(),
};

// ---------- utilities ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only https, site-relative, data: and blob: URLs are used as image sources. */
function imgSrc(url) {
  const value = String(url ?? '').trim();
  if (/^\/(?!\/)/.test(value)) return state.siteUrl + value;
  if (/^https:\/\//i.test(value) || /^(data:image\/|blob:)/i.test(value)) return value;
  return PLACEHOLDER;
}

/**
 * A small, fast preview: Cloudinary images/videos are resized by Cloudinary
 * (a fraction of the original size); other images fall back to imgSrc.
 */
function thumb(url, size) {
  const value = String(url ?? '').trim();
  return value.startsWith('https://res.cloudinary.com/') ? cloudinaryThumb(value, size) : imgSrc(value);
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.style.cssText = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function showToast(msg) {
  const toast = el('div', { className: 'toast', textContent: msg });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

async function api(path, { method = 'GET', json } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken || '';
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: json === undefined ? undefined : JSON.stringify(json) });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') showLogin();
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${res.status}).`), { status: res.status });
  return data;
}

function isVideoFile(file) {
  return /^video\//.test(file.type) || /\.(mp4|m4v|mov|webm)$/i.test(file.name);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One POST to Cloudinary. Resolves { status, json }; rejects only on network failure. */
function postToCloudinary(signed, blob, filename, chunk, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(signed.fields)) form.append(key, value);
    form.append('file', blob, filename);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', signed.uploadUrl);
    if (chunk) {
      xhr.setRequestHeader('X-Unique-Upload-Id', chunk.id);
      xhr.setRequestHeader('Content-Range', chunk.range);
    }
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let json = {};
      try { json = JSON.parse(xhr.responseText); } catch {}
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => reject(new Error('Network error while uploading.'));
    xhr.ontimeout = () => reject(new Error('The upload timed out.'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(form);
  });
}

/** Retries network failures, 429 and 5xx up to 3 times with back-off. */
async function withRetry(send) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, json } = await send();
      if (status >= 200 && status < 300) return json;
      const message = json?.error?.message || `Cloudinary responded with HTTP ${status}.`;
      if (status !== 429 && status < 500) throw Object.assign(new Error(friendlyCloudinaryError(message)), { final: true });
      lastError = new Error(message);
    } catch (err) {
      if (err.final) throw err;
      lastError = err;
    }
    if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
  }
  throw lastError;
}

function friendlyCloudinaryError(message) {
  if (/file size too large/i.test(message)) return `${message} Your Cloudinary plan does not allow files this large.`;
  if (/format not allowed|invalid image file|unsupported video format/i.test(message)) return 'This file type is not supported. Photos: JPG, PNG, WebP, AVIF, HEIC. Videos: MP4, MOV, WebM.';
  if (/stale request|signature/i.test(message)) return 'The upload permission expired. Please try again.';
  return message;
}

/**
 * Uploads one file straight from the browser to Cloudinary. The admin server
 * signs the request (folder, tags and allowed formats are fixed by the
 * signature); files over 20 MB are sent in chunks, each retried on failure.
 */
async function uploadToCloudinary(file, { kind, eventSlug, customFolder, onProgress = () => {} }) {
  if (!state.cloudinary.ready) throw new Error('Uploads are not set up yet. See the Status tab.');
  const limit = state.limits[kind];
  if (file.size > limit) {
    throw new Error(`${file.name} is ${(file.size / MB).toFixed(1)} MB; the limit is ${limit / MB} MB.${kind === 'video' ? ' Put long videos on YouTube and add the link instead.' : ''}`);
  }
  state.uploadsInFlight++;
  try {
    const signed = await api('/api/uploads/sign', { method: 'POST', json: { kind, event: eventSlug, folder: customFolder, filename: file.name, size: file.size } });
    let result;
    if (file.size <= CHUNK_SIZE) {
      result = await withRetry(() => postToCloudinary(signed, file, file.name, null, onProgress));
    } else {
      const id = crypto.randomUUID().replace(/-/g, '');
      for (let start = 0; start < file.size; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, file.size) - 1;
        result = await withRetry(() => postToCloudinary(signed, file.slice(start, end + 1), file.name,
          { id, range: `bytes ${start}-${end}/${file.size}` },
          p => onProgress((start + p * (end - start + 1)) / file.size)));
      }
    }
    if (!result?.secure_url) throw new Error('Cloudinary did not return a link for this file.');
    onProgress(1);
    return { url: deliveryUrl(result), publicId: result.public_id, width: result.width, height: result.height };
  } finally {
    state.uploadsInFlight--;
  }
}

/** Runs `worker` over `items` with limited concurrency; order of results matches items. */
async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

// ---------- auth ----------

async function checkAuth() {
  try {
    const data = await api('/api/me');
    Object.assign(state, {
      user: data.user, csrfToken: data.csrfToken, siteUrl: data.siteUrl || '',
      publishes: data.publishes, cloudinary: data.cloudinary, limits: data.limits,
      drafts: data.drafts, previewUrl: data.previewUrl, previewOrigin: data.previewOrigin,
    });
    showDashboard();
  } catch {
    showLogin();
  }
}

function showLoginError(message) {
  const box = document.getElementById('login-error');
  box.textContent = message;
  box.style.display = message ? 'block' : 'none';
}

function showLogin() {
  document.getElementById('view-login').style.display = 'flex';
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('header-auth').style.display = 'none';
  closeEventModal(true);
  closeMediaPicker();
}

function showDashboard() {
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('view-dashboard').style.display = 'block';
  document.getElementById('header-auth').style.display = 'flex';
  document.getElementById('user-display').textContent = state.user || '';
  if (state.siteUrl) document.getElementById('view-site').href = state.siteUrl;
  if (state.drafts) {
    document.getElementById('banner-text').textContent = 'Saving creates a draft: nothing changes on the website until you click “Publish to website”. Use “Preview website” to check your changes first.';
    document.getElementById('publish-explainer').textContent = 'Saving an event or registration stores it as a draft. The preview website shows the drafts after about 1–2 minutes. When you are happy, click “Publish to website”; the live site updates about 2–3 minutes later. “Discard” throws a draft away.';
    loadDrafts();
  } else if (!state.publishes) {
    document.getElementById('banner-text').textContent = 'Local mode: saving changes the files on this computer. Commit and push them to publish.';
    document.getElementById('publish-explainer').textContent = 'Local mode: saving writes the files in this checkout. Run git add src/content, commit and push to publish.';
  }
  loadEvents().then(offerRestore);
  loadRegistrations();
  loadHomepage();
  refreshPreviewPass();
  // The media library and status checks are slower; load them when their tab is opened.
  state.mediaStale = true;
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  state.user = null;
  state.csrfToken = null;
  showLogin();
  showToast('Signed out.');
}

function switchTab(tabId, button) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn === button));
  for (const id of ['events', 'homepage', 'media', 'registrations', 'settings', 'pagescms']) {
    document.getElementById('tab-' + id).style.display = id === tabId ? 'block' : 'none';
  }
  if (tabId === 'media') ensureMedia();
  if (tabId === 'homepage') ensureHomepage();
  if (tabId === 'settings') loadStatus();
}

// ---------- events ----------

async function loadEvents() {
  try {
    state.events = (await api('/api/events')).events;
    renderEvents();
  } catch (err) {
    showToast(err.message);
  }
}

function draftBadge(slug) {
  const change = state.draftChanges.find(c => c.kind === 'event' && c.id === slug);
  return change ? `<span class="draft-badge">${change.change === 'added' ? 'New · unpublished' : 'Unpublished changes'}</span>` : '';
}

function renderEvents() {
  document.getElementById('events-grid').innerHTML = state.events.map(ev => {
    const blurb = ev.subtitle || ev.description || '';
    return `
      <div class="card">
        <img src="${esc(thumb(ev.flyerImage, { width: 640, height: 360 }))}" class="card-img" alt="${esc(ev.title)} flyer" loading="lazy" decoding="async" data-fallback>
        <div class="card-body">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
            <h3 class="card-title">${esc(ev.title)}${draftBadge(ev.slug)}</h3>
            <span class="status-badge ${ev.status === 'upcoming' ? 'status-upcoming' : 'status-past'}">${esc(ev.status)}</span>
          </div>
          ${ev.error ? `<p class="help-text" style="color:var(--danger);">${esc(ev.error)}</p>` : ''}
          <div class="card-meta">
            <span>📅 ${esc(ev.date)}</span>
            <span>🏷️ Order: ${esc(ev.order)}</span>
          </div>
          <p style="font-size:13px; color:#475569; margin-bottom:12px; line-height:1.4;">${esc(blurb.length > 85 ? blurb.slice(0, 85) + '…' : blurb)}</p>
          <div class="card-stats">
            <span>${ev.gallery.length} photos · ${ev.videos.length} videos</span>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-secondary btn-sm" data-action="editEvent" data-arg="${esc(ev.slug)}">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="deleteEvent" data-arg="${esc(ev.slug)}">Delete</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function fillEventForm(ev) {
  const set = (id, value) => { document.getElementById(id).value = value ?? ''; };
  set('ev-slug', ev.slug);
  set('ev-title', ev.title);
  set('ev-order', ev.order);
  set('ev-status', ev.status || 'upcoming');
  set('ev-date', ev.date);
  set('ev-time', ev.time);
  set('ev-location', ev.location);
  set('ev-subtitle', ev.subtitle);
  set('ev-desc', ev.description);
  set('ev-flyer', ev.flyerImage);
  updateFlyerPreview(ev.flyerImage);
  document.getElementById('gallery-list').replaceChildren();
  document.getElementById('videos-list').replaceChildren();
  (ev.gallery || []).forEach(item => addGalleryRow(item.src, item.alt));
  (ev.videos || []).forEach(v => addVideoRow(v));
}

function openNewEventModal() {
  state.isNewEvent = true;
  state.editingVersion = null;
  state.freshUploads.clear();
  state.slugTouched = false;
  document.getElementById('modal-event-title').textContent = 'Create New Event';
  document.getElementById('ev-slug').disabled = false;
  fillEventForm({
    order: Math.max(0, ...state.events.map(e => e.order).filter(o => o < 9999)) + 1,
    status: 'upcoming',
    location: 'Sri Karpaga Ganapathi Temple, San Ramon, CA',
  });
  document.getElementById('modal-event').style.display = 'flex';
}

function editEvent(slug) {
  const ev = state.events.find(e => e.slug === slug);
  if (!ev) return;
  state.isNewEvent = false;
  state.editingVersion = ev.version;
  state.freshUploads.clear();
  document.getElementById('modal-event-title').textContent = 'Edit Event: ' + ev.title;
  document.getElementById('ev-slug').disabled = true;
  fillEventForm(ev);
  document.getElementById('modal-event').style.display = 'flex';
}

function closeEventModal(force) {
  if (force !== true) {
    if (state.uploadsInFlight > 0 && !confirm('Uploads are still in progress. Close anyway? Unsaved photos will not be added to the event.')) return;
    if (state.freshUploads.size) {
      const count = state.freshUploads.size;
      if (confirm(`You uploaded ${count} file(s) that are not saved in this event. Delete them from Cloudinary?\n\nOK = delete them · Cancel = keep them in the Media Library`)) {
        discardFreshUploads();
        showToast(`${count} unsaved upload(s) deleted.`);
      } else {
        state.freshUploads.clear();
        state.mediaStale = true;
      }
    }
  }
  document.getElementById('modal-event').style.display = 'none';
}

/** The event's identifier, which also names its Cloudinary folder. */
function eventSlugForUpload() {
  const slugInput = document.getElementById('ev-slug');
  if (!slugInput.value.trim() && state.isNewEvent) slugInput.value = slugify(document.getElementById('ev-title').value);
  const slug = slugInput.value.trim();
  if (!slug) {
    alert('Enter the event title (or identifier) before uploading, so the files go into the right Cloudinary folder.');
    return null;
  }
  return slug;
}

function updateFlyerPreview(url) {
  const container = document.getElementById('flyer-preview');
  container.replaceChildren();
  if (url) container.append(el('img', { src: thumb(url, { width: 360, height: 180, crop: 'limit' }), alt: 'Flyer preview', decoding: 'async', style: 'height:90px; border-radius:4px; border:1px solid #ccc; object-fit:cover;', dataset: { fallback: '' } }));
}

async function uploadFlyerFile(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const slug = eventSlugForUpload();
  if (!slug) return;
  const status = document.getElementById('flyer-preview');
  status.replaceChildren(el('span', { className: 'upload-status', textContent: 'Uploading flyer…' }));
  try {
    const data = await uploadToCloudinary(file, {
      kind: 'photo', eventSlug: slug,
      onProgress: p => { status.firstChild.textContent = p < 1 ? `Uploading flyer… ${Math.round(p * 100)}%` : 'Saving to Cloudinary…'; },
    });
    document.getElementById('ev-flyer').value = data.url;
    state.freshUploads.add(data.url);
    updateFlyerPreview(data.url);
    showToast('Flyer uploaded.');
  } catch (err) {
    status.replaceChildren(el('span', { className: 'upload-status error', textContent: err.message }));
  }
}

function rowControls() {
  return [
    el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: '↑', title: 'Move up', dataset: { action: 'moveRowUp' } }),
    el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: '↓', title: 'Move down', dataset: { action: 'moveRowDown' } }),
    el('button', { type: 'button', className: 'btn btn-danger btn-sm', textContent: '✕', title: 'Remove', dataset: { action: 'removeRow' } }),
  ];
}

function addGalleryRow(src = '', alt = '', { before = null } = {}) {
  const preview = el('img', { className: 'gallery-thumb', src: src ? thumb(src, { width: 120 }) : PLACEHOLDER, alt: '', loading: 'lazy', decoding: 'async', dataset: { fallback: '' } });
  const srcInput = el('input', { type: 'text', className: 'gal-src', placeholder: 'Cloudinary photo URL', value: src });
  srcInput.addEventListener('input', () => { preview.src = srcInput.value ? thumb(srcInput.value, { width: 120 }) : PLACEHOLDER; });
  const altInput = el('input', { type: 'text', className: 'gal-alt', placeholder: 'Description (who / what is shown)', value: alt });
  const row = el('div', { className: 'gallery-editor-item' }, [preview, srcInput, altInput, ...rowControls()]);
  document.getElementById('gallery-list').insertBefore(row, before);
  return row;
}

function addEmptyGalleryRow() { addGalleryRow(); }

/** Turns a row into an upload slot showing progress; resolves when done. */
async function uploadIntoRow(row, file, { kind, eventSlug, onSuccess }) {
  row.classList.remove('is-failed');
  row.classList.add('is-uploading');
  row.uploadFile = file;
  let status = row.querySelector('.upload-status');
  if (!status) {
    status = el('div', { className: 'upload-status' }, [el('span'), el('div', { className: 'progress' }, el('span'))]);
    row.insertBefore(status, row.children[1]);
  }
  status.classList.remove('error');
  status.querySelector('button')?.remove();
  const label = status.firstChild;
  const bar = status.querySelector('.progress > span');
  label.textContent = `Uploading ${file.name}…`;
  try {
    const data = await uploadToCloudinary(file, {
      kind, eventSlug,
      onProgress: p => {
        bar.style.width = `${Math.round(p * 100)}%`;
        label.textContent = p < 1 ? `Uploading ${file.name}… ${Math.round(p * 100)}%` : `Saving ${file.name} to Cloudinary…`;
      },
    });
    onSuccess(data);
    state.freshUploads.add(data.url);
    row.dataset.fresh = data.url;
    status.remove();
    row.classList.remove('is-uploading');
    return true;
  } catch (err) {
    row.classList.remove('is-uploading');
    row.classList.add('is-failed');
    status.classList.add('error');
    label.textContent = `${file.name}: ${err.message}`;
    bar.style.width = '0';
    status.append(el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: 'Retry', style: 'margin-top:4px;', dataset: { action: 'retryUpload' } }));
    row.retry = () => uploadIntoRow(row, file, { kind, eventSlug, onSuccess });
    return false;
  }
}

async function uploadGalleryFiles(input) {
  const files = Array.from(input.files).sort((a, b) => naturalCompare(a.name, b.name));
  input.value = '';
  if (!files.length) return;
  const eventSlug = eventSlugForUpload();
  if (!eventSlug) return;

  // Rows are created up front, so the gallery order is the file-name order
  // regardless of which upload finishes first.
  const rows = files.map(file => {
    const row = addGalleryRow('', file.name.replace(/\.[^/.]+$/, ''));
    return { row, file };
  });
  let ok = 0;
  await runPool(rows, UPLOAD_CONCURRENCY, async ({ row, file }) => {
    const done = await uploadIntoRow(row, file, {
      kind: 'photo', eventSlug,
      onSuccess: data => {
        row.querySelector('.gal-src').value = data.url;
        row.querySelector('.gallery-thumb').src = thumb(data.url, { width: 120 });
      },
    });
    if (done) ok++;
  });
  showToast(ok === files.length ? `${ok} photo(s) uploaded. Click “Save Event” to publish them.` : `${ok} of ${files.length} uploaded. Retry or remove the failed rows.`);
}

function moveRowUp(_arg, btn) {
  const row = btn.closest('.gallery-editor-item');
  if (row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling);
}

function moveRowDown(_arg, btn) {
  const row = btn.closest('.gallery-editor-item');
  if (row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row);
}

function removeRow(_arg, btn) {
  const row = btn.closest('.gallery-editor-item');
  if (row.classList.contains('is-uploading')) return alert('Wait for this upload to finish before removing it.');
  row.remove();
  // A file uploaded in this session and never saved is deleted from Cloudinary
  // too. Files already saved in the event stay until it is saved without them.
  const url = row.dataset.fresh;
  if (url) {
    state.freshUploads.delete(url);
    deleteUploads([url]).then(() => showToast('Removed and deleted from Cloudinary.'), err => showToast(`Removed from the event. ${err.message}`));
  }
}

async function deleteUploads(urls) {
  if (!urls.length) return;
  await api('/api/media/delete', { method: 'POST', json: { urls } });
  state.mediaStale = true;
}

/** Deletes this session's uploads that are not part of what is being kept. */
function discardFreshUploads(keep = new Set()) {
  const orphans = [...state.freshUploads].filter(url => !keep.has(url));
  state.freshUploads.clear();
  if (orphans.length) deleteUploads(orphans).catch(err => console.warn('Cleanup failed:', err.message));
  return orphans.length;
}

function retryUpload(_arg, btn) {
  btn.closest('.gallery-editor-item')?.retry?.();
}

function addVideoRow(v = {}) {
  const source = v.source === 'upload' ? 'upload' : 'youtube';
  const select = el('select', { className: 'vid-source', style: 'width:130px;' }, [
    el('option', { value: 'youtube', textContent: 'YouTube Link', selected: source === 'youtube' }),
    el('option', { value: 'upload', textContent: 'Uploaded Clip', selected: source === 'upload' }),
  ]);
  const placeholderFor = s => (s === 'youtube' ? 'https://youtube.com/watch?v=...' : 'Cloudinary video URL (.mp4)');
  const valueInput = el('input', { type: 'text', className: 'vid-val', placeholder: placeholderFor(source), value: source === 'upload' ? (v.file || '') : (v.videoUrl || ''), style: 'flex:1;' });
  select.addEventListener('change', () => { valueInput.placeholder = placeholderFor(select.value); });
  const titleInput = el('input', { type: 'text', className: 'vid-title', placeholder: 'Video title', value: v.title || '', style: 'width:180px; flex:0 0 180px;' });
  const row = el('div', { className: 'gallery-editor-item' }, [select, valueInput, titleInput, ...rowControls()]);
  document.getElementById('videos-list').append(row);
  return row;
}

async function uploadVideoFiles(input) {
  const files = Array.from(input.files).sort((a, b) => naturalCompare(a.name, b.name));
  input.value = '';
  if (!files.length) return;
  const eventSlug = eventSlugForUpload();
  if (!eventSlug) return;
  const rows = files.map(file => ({ file, row: addVideoRow({ source: 'upload', title: file.name.replace(/\.[^/.]+$/, '') }) }));
  let ok = 0;
  // Videos are large: upload one at a time.
  await runPool(rows, 1, async ({ row, file }) => {
    if (await uploadIntoRow(row, file, { kind: 'video', eventSlug, onSuccess: data => { row.querySelector('.vid-val').value = data.url; } })) ok++;
  });
  showToast(ok === files.length ? `${ok} clip(s) uploaded. Click “Save Event” to publish them.` : `${ok} of ${files.length} uploaded. Retry or remove the failed rows.`);
}

/** The event exactly as it would be saved (also used for the instant preview). */
function collectEventForm() {
  const value = id => document.getElementById(id).value.trim();
  const gallery = [...document.querySelectorAll('#gallery-list .gallery-editor-item')]
    .map(row => ({ src: row.querySelector('.gal-src').value.trim(), alt: row.querySelector('.gal-alt').value.trim() }))
    .filter(item => item.src);
  const videos = [...document.querySelectorAll('#videos-list .gallery-editor-item')].map(row => {
    const source = row.querySelector('.vid-source').value;
    const val = row.querySelector('.vid-val').value.trim();
    return { title: row.querySelector('.vid-title').value.trim(), source, ...(source === 'upload' ? { file: val } : { videoUrl: val }) };
  }).filter(v => v.file || v.videoUrl);
  return {
    isNew: state.isNewEvent,
    version: state.editingVersion,
    slug: value('ev-slug') || slugify(value('ev-title')),
    title: value('ev-title'),
    order: parseInt(value('ev-order'), 10),
    status: value('ev-status'),
    date: value('ev-date'),
    time: value('ev-time'),
    location: value('ev-location'),
    subtitle: value('ev-subtitle'),
    description: value('ev-desc'),
    flyerImage: value('ev-flyer'),
    gallery,
    videos,
  };
}

/**
 * Opens the real website page with this content in a new tab, in about a
 * second: no saving and no build. Posted as a form so the preview opens as
 * its own isolated page.
 */
let passTimer = null;
/**
 * Keeps a fresh pass for the separate preview server, renewed every 10
 * minutes (passes last 15), so Preview opens immediately when clicked.
 */
async function refreshPreviewPass() {
  clearTimeout(passTimer);
  if (!state.previewOrigin) return;
  try {
    const data = await api('/api/preview-pass');
    state.previewPass = data.token;
  } catch {
    state.previewPass = null; // previews then open here, sandboxed
  }
  passTimer = setTimeout(refreshPreviewPass, 10 * 60 * 1000);
}

function openInstantPreview(path, field, payload) {
  // Preferred: the separate preview server (real videos and forms). Fallback:
  // the sandboxed preview on this address.
  const separate = state.previewOrigin && state.previewPass;
  const form = el('form', { method: 'POST', action: separate ? state.previewOrigin + path : path, target: '_blank', style: 'display:none' }, [
    separate
      ? el('input', { type: 'hidden', name: 'token', value: state.previewPass })
      : el('input', { type: 'hidden', name: 'csrf', value: state.csrfToken || '' }),
    el('input', { type: 'hidden', name: field, value: JSON.stringify(payload) }),
  ]);
  document.body.append(form);
  form.submit();
  form.remove();
}

function previewEvent() {
  if (state.uploadsInFlight > 0) showToast('Uploads still running are not in the preview yet.');
  openInstantPreview('/preview/events', 'event', collectEventForm());
}

function previewRegistration(_arg, button) {
  const fields = button.closest('form').elements;
  openInstantPreview(`/preview/registration/${encodeURIComponent(button.dataset.id)}`, 'registration', {
    status: fields.namedItem('status').value,
    message: fields.namedItem('message').value.trim(),
    openMessage: fields.namedItem('openMessage').value.trim(),
    url: fields.namedItem('url').value.trim(),
  });
}

async function saveEvent() {
  if (state.uploadsInFlight > 0) return alert('Please wait for the uploads to finish before saving.');
  if (document.querySelector('#modal-event .is-failed')) return alert('Some uploads failed. Retry them or remove those rows before saving.');

  const event = collectEventForm();
  const button = document.getElementById('save-event-btn');
  button.disabled = true;
  try {
    await api('/api/events', { method: 'POST', json: event });
    forgetUnsaved();
    showToast(savedMessage('Event'));
    discardFreshUploads(new Set([event.flyerImage, ...event.gallery.map(g => g.src), ...event.videos.map(v => v.file).filter(Boolean)]));
    state.mediaStale = true;
    closeEventModal(true);
    loadEvents();
    loadDrafts();
  } catch (err) {
    if (err.status === 401) {
      // Login expired while editing: keep the work so it can be restored.
      stashUnsaved({ event, isNew: state.isNewEvent, version: state.editingVersion });
      alert('Your login has expired. Your changes are kept: log in again and you will be offered to restore them.');
      return;
    }
    alert(err.message);
    if (err.status === 409) loadEvents();
  } finally {
    button.disabled = false;
  }
}

const UNSAVED_KEY = 'sapta-admin-unsaved-event';
function stashUnsaved(value) {
  try { localStorage.setItem(UNSAVED_KEY, JSON.stringify({ ...value, at: Date.now() })); } catch {}
}
function forgetUnsaved() {
  try { localStorage.removeItem(UNSAVED_KEY); } catch {}
}
function readUnsaved() {
  try {
    const stash = JSON.parse(localStorage.getItem(UNSAVED_KEY) || 'null');
    return stash?.event && Date.now() - stash.at < 7 * 24 * 3600 * 1000 ? stash : null;
  } catch {
    return null;
  }
}

/** After logging in, shows a notice offering to reopen an edit that could not be saved. */
function offerRestore() {
  const stash = readUnsaved();
  const notice = document.getElementById('restore-notice');
  if (!stash) { notice.style.display = 'none'; return; }
  notice.replaceChildren(
    el('span', { textContent: `You have unsaved changes to “${stash.event.title || 'an event'}” from before your login expired. ` }),
    el('button', { type: 'button', className: 'btn btn-primary btn-sm', textContent: 'Reopen them', dataset: { action: 'restoreUnsaved' } }),
    el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: 'Discard', dataset: { action: 'discardUnsaved' } }),
  );
  notice.style.display = 'flex';
}

function restoreUnsaved() {
  const stash = readUnsaved();
  document.getElementById('restore-notice').style.display = 'none';
  if (!stash) return;
  state.isNewEvent = Boolean(stash.isNew);
  state.editingVersion = stash.version || null;
  state.freshUploads.clear();
  document.getElementById('modal-event-title').textContent = stash.isNew ? 'Create New Event' : `Edit Event: ${stash.event.title}`;
  document.getElementById('ev-slug').disabled = !stash.isNew;
  fillEventForm(stash.event);
  document.getElementById('modal-event').style.display = 'flex';
  // Kept until the event is actually saved.
}

function discardUnsaved() {
  if (!confirm('Throw away these unsaved changes?')) return;
  forgetUnsaved();
  document.getElementById('restore-notice').style.display = 'none';
}

async function deleteEvent(slug) {
  const ev = state.events.find(e => e.slug === slug);
  if (!ev) return;
  if (!confirm(`Delete the event "${ev.title}"? It will be removed from the website. (It can be restored from the GitHub history; photos on Cloudinary are kept.)`)) return;
  try {
    const data = await api(`/api/events/${encodeURIComponent(slug)}?version=${encodeURIComponent(ev.version)}`, { method: 'DELETE' });
    showToast(state.drafts ? 'Event deleted in the drafts. It stays on the website until you publish.' : data.publishes ? 'Event deleted. The website will update in about 2–3 minutes.' : 'Event deleted.');
    state.mediaStale = true;
  } catch (err) {
    alert(err.message);
  }
  loadEvents();
  loadDrafts();
}

// ---------- media library ----------

/** Loads the media library once, and again only after something changed. */
async function ensureMedia() {
  if (state.mediaLoaded && !state.mediaStale) return;
  await loadMedia();
}

async function loadMedia() {
  state.mediaStale = false;
  if (!state.mediaLoaded) document.getElementById('media-grid').innerHTML = '<p class="help-text" style="grid-column:1/-1;">Loading media…</p>';
  try {
    const data = await api('/api/media');
    state.customFolders = data.folders || [];
    const known = new Set(data.media.map(m => m.url));
    state.allMedia = [...state.recentUploads.filter(m => !known.has(m.url)), ...data.media];
  } catch (err) {
    state.mediaStale = true;
    return showToast(err.message);
  }
  state.mediaLoaded = true;
  // A folder that was renamed or deleted elsewhere: fall back to "All media".
  if (state.mediaFolder.startsWith('custom:') && !state.customFolders.includes(state.mediaFolder.slice(7))) state.mediaFolder = 'all';
  renderMediaFolders();
  renderMediaGrid();
}

// Folders: "all", "event:<slug>" (one per event), "none" (uploads not in an
// event folder) and "website" (images that are part of the website code).
function folderFilter(folder) {
  if (folder === 'all') return () => true;
  if (folder === 'none') return m => m.source === 'cloudinary' && !m.event && !m.customFolder;
  if (folder === 'website') return m => m.usedIn === 'Website files';
  if (folder.startsWith('custom:')) {
    const name = folder.slice('custom:'.length);
    return m => m.customFolder === name;
  }
  const slug = folder.slice('event:'.length);
  return m => m.event === slug;
}

function folderButtons(selected, action, { photosOnly = false, allowCreate = false } = {}) {
  const items = photosOnly ? state.allMedia.filter(m => m.type !== 'video') : state.allMedia;
  const count = folder => items.filter(folderFilter(folder)).length;
  const folders = [
    ['all', 'All media'],
    ...state.events.map(ev => [`event:${ev.slug}`, `🎵 ${ev.title}`]),
    ...state.customFolders.map(name => [`custom:${name}`, `📁 ${name}`]),
    ['none', '📂 Not in a folder'],
    ['website', '🗂 Website files'],
  ];
  return folders.map(([key, label]) => {
    const n = count(key);
    if (key === 'none' && !n) return '';
    return `<button type="button" class="folder-btn ${key === selected ? 'active' : ''}" data-action="${action}" data-arg="${esc(key)}">${esc(label)} <span class="count">${n}</span></button>`;
  }).join('') + (allowCreate ? '<button type="button" class="folder-btn folder-new" data-action="createFolder">＋ New folder</button>' : '');
}

function renderMediaFolders() {
  document.getElementById('media-folders').innerHTML = folderButtons(state.mediaFolder, 'selectMediaFolder', { allowCreate: state.cloudinary.ready });
  const slug = state.mediaFolder.startsWith('event:') ? state.mediaFolder.slice(6) : null;
  const custom = state.mediaFolder.startsWith('custom:') ? state.mediaFolder.slice(7) : null;
  const ev = slug && state.events.find(e => e.slug === slug);
  document.getElementById('dropzone-label').textContent = ev
    ? `Click to upload photos or videos to the “${ev.title}” folder`
    : custom ? `Click to upload photos or videos to the “${custom}” folder`
    : 'Click to upload photos or videos (choose a folder above to file them there)';
  // Custom folders can be renamed and (when empty) deleted; event folders follow their event.
  const tools = document.getElementById('folder-tools');
  tools.replaceChildren(...(custom ? [
    el('span', { className: 'help-text', textContent: `Folder “${custom}”:` }),
    el('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: 'Rename', dataset: { action: 'renameFolder' } }),
    el('button', { type: 'button', className: 'btn btn-danger btn-sm', textContent: 'Delete folder', dataset: { action: 'deleteFolder' } }),
  ] : ev ? [el('span', { className: 'help-text', textContent: 'Event folders are named after their event and change with it.' })] : []));
}

async function createFolder() {
  const name = prompt('Name for the new folder (for example "Rehearsals 2026"):');
  if (!name || !name.trim()) return;
  try {
    const data = await api('/api/folders', { method: 'POST', json: { name } });
    state.mediaFolder = `custom:${data.name}`;
    showToast(`Folder “${data.name}” created.`);
  } catch (err) {
    return alert(err.message);
  }
  await loadMedia();
}

async function renameFolder() {
  const from = state.mediaFolder.slice(7);
  const to = prompt(`Rename the folder “${from}” to:`, from);
  if (!to || !to.trim() || to.trim() === from) return;
  try {
    const data = await api('/api/folders/rename', { method: 'POST', json: { from, to } });
    state.mediaFolder = `custom:${data.name}`;
    showToast(`Renamed to “${data.name}”. Links to its files are unchanged.`);
  } catch (err) {
    return alert(err.message);
  }
  await loadMedia();
}

async function deleteFolder() {
  const name = state.mediaFolder.slice(7);
  if (!confirm(`Delete the folder “${name}”? Only empty folders can be deleted.`)) return;
  try {
    await api('/api/folders/delete', { method: 'POST', json: { name } });
    state.mediaFolder = 'all';
    showToast(`Folder “${name}” deleted.`);
  } catch (err) {
    return alert(err.message);
  }
  await loadMedia();
}

/** "Move to…" menu on a media card. */
function moveOptions(m) {
  const here = m.customFolder ? `custom:${m.customFolder}` : m.event ? `event:${m.event}` : 'none';
  const options = [
    ...state.events.map(ev => [`event:${ev.slug}`, `🎵 ${ev.title}`]),
    ...state.customFolders.map(name => [`custom:${name}`, `📁 ${name}`]),
    ['none', '📂 Not in a folder'],
  ].filter(([key]) => key !== here);
  return `<option value="">Move to…</option>` + options.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
}

async function moveMedia(select) {
  const item = state.mediaItems[Number(select.dataset.arg)];
  const to = select.value;
  if (!item || !to) return;
  select.disabled = true;
  try {
    await api('/api/media/move', { method: 'POST', json: { url: item.url, to } });
    showToast('Moved. Its link is unchanged.');
  } catch (err) {
    alert(err.message);
  }
  await loadMedia();
}

function selectMediaFolder(folder) {
  state.mediaFolder = folder;
  renderMediaFolders();
  renderMediaGrid();
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid');
  state.mediaItems = state.allMedia.filter(folderFilter(state.mediaFolder));
  if (!state.mediaItems.length) {
    grid.innerHTML = '<p class="help-text" style="grid-column:1/-1;">This folder is empty. Upload photos or videos above.</p>';
    return;
  }
  grid.innerHTML = state.mediaItems.map((m, i) => {
    const badgeClass = m.source === 'cloudinary' ? 'badge-cloudinary' : (m.source === 'upload' ? 'badge-upload' : 'badge-asset');
    const badgeLabel = m.type === 'video' ? '🎬 Video' : m.source === 'cloudinary' ? '☁️ Cloudinary' : '📁 Website file';
    return `
      <div class="media-card">
        <div class="media-preview-wrap">
          ${m.type === 'video' && m.source !== 'cloudinary'
            ? '<div style="display:flex; align-items:center; justify-content:center; height:100%; font-size:32px;">🎬</div>'
            : `<img src="${esc(thumb(m.url, { width: 400, height: 280 }))}" alt="${esc(m.title)}" loading="lazy" decoding="async" data-fallback>`}
        </div>
        <div class="media-info">
          <div>
            <span class="${badgeClass}">${badgeLabel}</span>
            <div style="font-weight:600; font-size:12px; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(m.title)}">${esc(m.title)}</div>
            <div style="font-size:11px; color:#64748b; margin-top:2px;">${esc(m.usedIn)}</div>
          </div>
          <div style="display:flex; gap:6px; margin-top:10px;">
            <button class="btn btn-secondary btn-sm" style="flex:1; padding:4px 6px; font-size:11px;" data-action="copyUrl" data-arg="${i}">Copy URL</button>
            ${m.deletable ? `<button class="btn btn-danger btn-sm" style="padding:4px 8px; font-size:11px;" data-action="deleteMedia" data-arg="${i}">Delete</button>` : ''}
          </div>
          ${m.movable ? `<select class="move-select" data-change="moveMedia" data-arg="${i}" aria-label="Move ${esc(m.title)} to another folder">${moveOptions(m)}</select>` : ''}
        </div>
      </div>`;
  }).join('');
}

async function deleteMedia(index) {
  const item = state.mediaItems[Number(index)];
  if (!item || !item.deletable) return;
  if (!confirm(`Delete "${item.title}" from Cloudinary? This cannot be undone.`)) return;
  try {
    await deleteUploads([item.url]);
    state.recentUploads = state.recentUploads.filter(m => m.url !== item.url);
    showToast('Deleted from Cloudinary.');
  } catch (err) {
    alert(err.message);
  }
  loadMedia();
}

async function copyUrl(index) {
  const item = state.mediaItems[Number(index)];
  if (!item) return;
  try {
    await navigator.clipboard.writeText(item.url);
    showToast('Copied: ' + item.url);
  } catch {
    prompt('Copy this URL:', item.url);
  }
}

async function handleQuickUpload(input) {
  const files = Array.from(input.files).sort((a, b) => naturalCompare(a.name, b.name));
  input.value = '';
  const eventSlug = state.mediaFolder.startsWith('event:') ? state.mediaFolder.slice(6) : '';
  const customFolder = state.mediaFolder.startsWith('custom:') ? state.mediaFolder.slice(7) : '';
  const label = document.getElementById('dropzone-label');
  let ok = 0;
  for (const [i, file] of files.entries()) {
    const kind = isVideoFile(file) ? 'video' : 'photo';
    try {
      const data = await uploadToCloudinary(file, {
        kind, eventSlug, customFolder,
        onProgress: p => { label.textContent = `Uploading ${i + 1}/${files.length}: ${file.name} ${p < 1 ? Math.round(p * 100) + '%' : '(finishing…)'}`; },
      });
      state.recentUploads.unshift({ url: data.url, type: kind, source: 'cloudinary', title: file.name, usedIn: 'Not used in any event', event: eventSlug || null, customFolder: customFolder || null, deletable: true, movable: true });
      ok++;
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  if (ok) showToast(`${ok} file(s) uploaded.`);
  await loadMedia();
}

async function openMediaPicker(target) {
  state.pickerTarget = target;
  document.getElementById('picker-title').textContent = target === 'flyer' ? 'Select Event Flyer Image' : target === 'home' ? 'Choose a picture' : 'Select Photo for Gallery';
  document.getElementById('picker-grid').innerHTML = '<p class="help-text">Loading media…</p>';
  document.getElementById('modal-picker').style.display = 'flex';
  await ensureMedia();
  // Start in the folder of the event being edited, if it has anything.
  const slug = target === 'home' ? '' : document.getElementById('ev-slug').value.trim();
  const own = target === 'home' ? `custom:${HOME_FOLDER}` : `event:${slug}`;
  state.pickerFolder = (slug || target === 'home') && state.allMedia.some(m => m.type !== 'video' && folderFilter(own)(m)) ? own : 'all';
  renderPicker();
}

function closeMediaPicker() {
  document.getElementById('modal-picker').style.display = 'none';
  state.pickerTarget = null;
}

function selectPickerFolder(folder) {
  state.pickerFolder = folder;
  renderPicker();
}

function renderPicker() {
  document.getElementById('picker-folders').innerHTML = folderButtons(state.pickerFolder, 'selectPickerFolder', { photosOnly: true });
  state.pickerItems = state.allMedia.filter(m => m.type !== 'video').filter(folderFilter(state.pickerFolder));
  document.getElementById('picker-grid').innerHTML = state.pickerItems.length ? state.pickerItems.map((m, i) => `
    <div class="media-card" style="cursor:pointer;" data-action="selectPickerImage" data-arg="${i}">
      <div class="media-preview-wrap" style="height:110px;">
        <img src="${esc(thumb(m.url, { width: 300, height: 220 }))}" alt="${esc(m.title)}" loading="lazy" decoding="async" data-fallback>
      </div>
      <div style="padding:6px 8px; font-size:11px;">
        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500;">${esc(m.title)}</div>
      </div>
    </div>`).join('') : '<p class="help-text">No photos in this folder.</p>';
}

function selectPickerImage(index) {
  const item = state.pickerItems[Number(index)];
  if (!item) return;
  if (state.pickerTarget === 'flyer') {
    document.getElementById('ev-flyer').value = item.url;
    updateFlyerPreview(item.url);
    showToast('Flyer selected.');
  } else if (state.pickerTarget === 'home') {
    setHomePic(home.pickTarget, item.url);
    showToast('Picture chosen. Click Save to keep it.');
  } else if (state.pickerTarget === 'gallery') {
    addGalleryRow(item.url, item.title);
    showToast('Photo added to gallery.');
  }
  closeMediaPicker();
}

// ---------- homepage ----------
//
// The Homepage tab shows the real homepage (built from the drafts by the
// preview server) in a frame. Clicking a picture or text there opens it in
// the panel beside it; typing updates the page as you go, and "Save draft"
// stores it like any other draft.

const HOME_FOLDER = 'Homepage'; // Cloudinary folder for homepage uploads
const home = {
  data: null,          // { page, team, defaultBanner } from /api/homepage
  loaded: false,
  view: 'overview',    // 'overview' | 'hero' | 'about' | 'team' | 'member:<id>' | 'member:new'
  dirty: false,
  selected: null,
  scrollY: 0,
  frameOpened: false,
  pickTarget: null,    // which picture the media picker / upload fills
  folderReady: false,
};

const memberById = id => home.data?.team.find(m => m.id === id);

async function loadHomepage() {
  try {
    home.data = await api('/api/homepage');
    home.loaded = true;
  } catch (err) {
    document.getElementById('home-panel').replaceChildren(el('p', { className: 'help-text', textContent: err.message }));
    return;
  }
  if (home.view.startsWith('member:') && home.view !== 'member:new' && !memberById(home.view.slice(7))) home.view = 'overview';
  if (!home.dirty) renderHomePanel();
}

function ensureHomepage() {
  if (!home.loaded) loadHomepage();
  if (!home.frameOpened) reloadHomeFrame();
}

async function reloadHomeFrame() {
  const msg = document.getElementById('home-frame-msg');
  const frame = document.getElementById('home-frame');
  msg.hidden = false;
  if (!state.previewOrigin) {
    msg.textContent = 'The page view needs the preview server (PREVIEW_ORIGIN). You can still change everything with the panel.';
    return;
  }
  msg.textContent = home.frameOpened ? 'Updating the page…' : 'Loading the homepage…';
  if (!state.previewPass) await refreshPreviewPass();
  if (!state.previewPass) {
    msg.textContent = 'The page view could not be opened. Reload the admin page.';
    return;
  }
  home.frameOpened = true;
  frame.src = `${state.previewOrigin}/preview/home?edit=1&y=${Math.round(home.scrollY)}&token=${encodeURIComponent(state.previewPass)}`;
}

function toFrame(message) {
  const target = document.getElementById('home-frame').contentWindow;
  if (target && state.previewOrigin) target.postMessage(message, state.previewOrigin);
}

/** What the page frame shows for a picture while it is not saved yet. */
function frameImage(url) {
  return url.startsWith('https://res.cloudinary.com/') ? cloudinaryThumb(url, { width: 1600, crop: 'limit' }) : url;
}

function homeViewport(size, button) {
  document.getElementById('home-frame-wrap').classList.toggle('is-phone', size === 'phone');
  button.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === button));
}

function confirmLeave() {
  return !home.dirty || confirm('You have changes here that are not saved. Throw them away?');
}

function openHomeView(view) {
  if (view === home.view) return;
  if (!confirmLeave()) return;
  const wasDirty = home.dirty;
  home.view = view;
  home.dirty = false;
  renderHomePanel();
  if (wasDirty) reloadHomeFrame(); // undo unsaved live edits on the page
}

function homeBack() {
  home.selected = null;
  toFrame({ type: 'sapta-select', field: null });
  openHomeView('overview');
}

/** Called when something on the page is clicked (or a field chosen here). */
function openHomeField(field) {
  const member = field.match(/^member:([a-z0-9-]+):(\w+)$/);
  const [view, name] = member ? [`member:${member[1]}`, member[2]] : field.split('.');
  if (!member && !['hero', 'about', 'team'].includes(view)) return;
  if (member && !memberById(member[1])) return;
  if (view !== home.view) {
    if (!confirmLeave()) return;
    const wasDirty = home.dirty;
    home.view = view;
    home.dirty = false;
    renderHomePanel();
    if (wasDirty) reloadHomeFrame();
  }
  home.selected = field;
  const panel = document.getElementById('home-panel');
  const pic = panel.querySelector(`[data-pic="${name}"]`);
  const target = pic ? pic.querySelector('button') : panel.querySelector(`[name="${name}"]`);
  target?.focus();
  (pic || target)?.scrollIntoView({ block: 'nearest' });
}

function picField(name, live, label, value, { help = '', allowDefault = false } = {}) {
  const shown = value || (allowDefault ? home.data.defaultBanner : '');
  return `<div class="form-group pic-field" data-pic="${esc(name)}" data-live-field="${esc(live)}">
      <label>${esc(label)}</label>
      <img src="${esc(shown ? thumb(shown, { width: 640, height: 360, crop: 'limit' }) : PLACEHOLDER)}" alt="" data-fallback>
      <input type="hidden" name="${esc(name)}" value="${esc(value)}">
      <div class="row">
        <button type="button" class="btn btn-cloudinary btn-sm" data-action="pickHomeFile" data-arg="${esc(name)}">Upload new picture</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="pickHomeFromLibrary" data-arg="${esc(name)}">Choose from library</button>
        ${allowDefault && value ? `<button type="button" class="btn btn-secondary btn-sm" data-action="useDefaultBanner">Use the original banner</button>` : ''}
      </div>
      <div class="help-text" data-status>${esc(help)}</div>
    </div>`;
}

const textField = (name, label, value, { live = '', max = 200, required = false, rows = 0, help = '' } = {}) => `
    <div class="form-group">
      <label for="home-${esc(name)}">${esc(label)}</label>
      ${rows
        ? `<textarea id="home-${esc(name)}" name="${esc(name)}" rows="${rows}" maxlength="${max}" ${required ? 'required' : ''} ${live ? `data-live="${esc(live)}"` : ''}>${esc(value)}</textarea>`
        : `<input type="text" id="home-${esc(name)}" name="${esc(name)}" value="${esc(value)}" maxlength="${max}" ${required ? 'required' : ''} ${live ? `data-live="${esc(live)}"` : ''}>`}
      ${help ? `<p class="help-text">${esc(help)}</p>` : ''}
    </div>`;

const formActions = (extra = '') => `
    <div class="panel-actions">
      <button type="submit" class="btn btn-primary">${state.drafts ? 'Save draft' : 'Save'}</button>
      <button type="button" class="btn btn-secondary" data-action="homeBack">Cancel</button>
      ${extra}
    </div>`;

function renderHomePanel() {
  const panel = document.getElementById('home-panel');
  if (!home.data) return;
  const { page, team } = home.data;
  const back = '<button type="button" class="back" data-action="homeBack">← All sections</button>';
  const view = home.view;

  if (view === 'hero') {
    panel.innerHTML = `${back}<h3>Banner</h3><p class="help-text" style="margin-bottom:14px;">The big picture at the top of the homepage.</p>
      <form data-submit="saveHomeSection" data-arg="hero">
        ${textField('title', 'Title', page.hero.title, { live: 'hero.title', max: 100, required: true })}
        ${textField('subtitle', 'Subtitle', page.hero.subtitle, { live: 'hero.subtitle', max: 300, help: 'Optional.' })}
        ${picField('image', 'hero.image', 'Banner picture', page.hero.image, { allowDefault: true, help: 'A wide landscape photo works best (at least 1600 pixels wide). The text sits on top of it.' })}
        ${formActions()}
      </form>`;
  } else if (view === 'about') {
    panel.innerHTML = `${back}<h3>About</h3>
      <form data-submit="saveHomeSection" data-arg="about">
        ${textField('title', 'Heading', page.about.title, { live: 'about.title', required: true })}
        ${textField('text', 'Text', page.about.text, { live: 'about.text', max: 5000, required: true, rows: 8 })}
        ${picField('image', 'about.image', 'Picture', page.about.image)}
        <div class="form-group">
          <label>Picture position</label>
          <div class="side-choice">
            <label><input type="radio" name="imageSide" value="left" ${page.about.imageSide === 'left' ? 'checked' : ''}> Left of the text</label>
            <label><input type="radio" name="imageSide" value="right" ${page.about.imageSide !== 'left' ? 'checked' : ''}> Right of the text</label>
          </div>
          <p class="help-text">The page shows the new position after you save.</p>
        </div>
        ${formActions()}
      </form>`;
  } else if (view === 'team') {
    panel.innerHTML = `${back}<h3>Team heading</h3>
      <form data-submit="saveHomeSection" data-arg="team">
        ${textField('title', 'Heading', page.team.title, { live: 'team.title', help: 'Shown above the team. Leave empty for no heading.' })}
        ${formActions()}
      </form>`;
  } else if (view.startsWith('member:')) {
    const isNew = view === 'member:new';
    const m = isNew ? { id: 'new', name: '', role: 'Member', bio: '', photo: '' } : memberById(view.slice(7));
    const live = field => (isNew ? '' : `member:${m.id}:${field}`);
    panel.innerHTML = `${back}<h3>${isNew ? 'Add a team member' : esc(m.name)}</h3>
      ${isNew ? '<p class="help-text" style="margin-bottom:14px;">They are added at the end of the team list; use ↑ ↓ to move them.</p>' : ''}
      <form data-submit="saveHomeSection" data-arg="${esc(view)}">
        ${textField('name', 'Name', m.name, { live: live('name'), max: 100, required: true })}
        ${textField('role', 'Role', m.role, { live: live('role'), max: 100, help: 'For example “Member”. Leave empty to show no role.' })}
        ${textField('bio', 'About them', m.bio, { live: live('bio'), max: 3000, rows: 6 })}
        ${picField('photo', live('photo'), 'Photo', m.photo, { help: 'A square-ish photo works best.' })}
        ${formActions(isNew ? '' : `<button type="button" class="btn btn-danger" data-action="removeMember" data-arg="${esc(m.id)}">Remove from team</button>`)}
      </form>`;
  } else {
    const row = (title, detail, view) => `<li><span class="grow"><strong>${esc(title)}</strong><br><span class="muted">${esc(detail)}</span></span>
      <button type="button" class="btn btn-secondary btn-sm" data-action="openHomeView" data-arg="${esc(view)}">Edit</button></li>`;
    panel.innerHTML = `<h3>Change the homepage</h3>
      <p class="help-text">Click any picture or text on the page, or pick it here.</p>
      <ul class="home-list">
        ${page.hasHero ? row('Banner', `${page.hero.title} · picture`, 'hero') : ''}
        ${page.hasAbout ? row('About', page.about.title, 'about') : ''}
        ${page.hasTeam ? row('Team heading', page.team.title || '(no heading)', 'team') : ''}
      </ul>
      ${page.hasTeam ? `<h3 style="font-size:16px;">Team</h3>
      <p class="help-text">Use ↑ ↓ to change the order on the website.</p>
      <ul class="home-list">${team.map((m, i) => `<li>
        <img src="${esc(m.photo ? thumb(m.photo, { width: 80 }) : PLACEHOLDER)}" alt="" data-fallback>
        <span class="grow">${esc(m.name)}<br><span class="muted">${esc(m.role || '—')}</span></span>
        <button type="button" class="icon-btn" data-action="moveMember" data-arg="${esc(m.id)}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(m.name)} up">↑</button>
        <button type="button" class="icon-btn" data-action="moveMember" data-arg="${esc(m.id)}:1" ${i === team.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(m.name)} down">↓</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="openHomeView" data-arg="member:${esc(m.id)}">Edit</button>
      </li>`).join('')}</ul>
      <button type="button" class="btn btn-secondary btn-sm" data-action="openHomeView" data-arg="member:new">＋ Add team member</button>` : ''}`;
  }
}

function setHomePic(name, url) {
  const pic = document.querySelector(`#home-panel [data-pic="${name}"]`);
  if (!pic) return;
  pic.querySelector('input[type="hidden"]').value = url;
  const shown = url || home.data.defaultBanner;
  pic.querySelector('img').src = thumb(shown, { width: 640, height: 360, crop: 'limit' });
  home.dirty = true;
  if (pic.dataset.liveField) toFrame({ type: 'sapta-set', field: pic.dataset.liveField, value: frameImage(shown) });
}

function pickHomeFile(name) {
  home.pickTarget = name;
  document.getElementById('home-file').click();
}

async function uploadHomeImage(input) {
  const file = input.files[0];
  input.value = '';
  const name = home.pickTarget;
  const status = document.querySelector(`#home-panel [data-pic="${name}"] [data-status]`);
  if (!file || !status) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name)) return alert('Please choose a photo (JPG, PNG, WebP or HEIC).');
  const buttons = status.parentElement.querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  try {
    if (!home.folderReady) {
      // Homepage uploads get their own folder in the media library.
      await api('/api/folders', { method: 'POST', json: { name: HOME_FOLDER } }).catch(err => { if (err.status !== 409) throw err; });
      home.folderReady = true;
    }
    status.textContent = 'Uploading… 0%';
    const { url } = await uploadToCloudinary(file, {
      kind: 'photo', customFolder: HOME_FOLDER,
      onProgress: p => { status.textContent = `Uploading… ${Math.round(p * 100)}%`; },
    });
    setHomePic(name, url);
    status.textContent = 'Uploaded. Click Save to keep it.';
    state.mediaStale = true;
  } catch (err) {
    status.textContent = '';
    alert(`Upload failed: ${err.message}`);
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

function pickHomeFromLibrary(name) {
  home.pickTarget = name;
  openMediaPicker('home');
}

function useDefaultBanner() {
  setHomePic('image', '');
}

async function saveHomeSection(e, view) {
  if (state.uploadsInFlight > 0) return alert('Please wait for the upload to finish.');
  const form = e.target.closest('form');
  const fields = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  let label = 'Homepage';
  try {
    if (['hero', 'about', 'team'].includes(view)) {
      await api('/api/homepage', { method: 'POST', json: { section: view, fields, version: home.data.page.version } });
      label = { hero: 'Banner', about: 'About section', team: 'Team heading' }[view];
    } else if (view === 'member:new') {
      if (!fields.photo) throw new Error('Add a photo first (Upload new picture, or Choose from library).');
      await api('/api/team', { method: 'POST', json: fields });
      label = fields.name;
    } else {
      const m = memberById(view.slice(7));
      if (!fields.photo) throw new Error('A team member needs a photo.');
      await api(`/api/team/${encodeURIComponent(m.id)}`, { method: 'POST', json: { ...fields, version: m.version } });
      label = fields.name;
    }
  } catch (err) {
    button.disabled = false;
    alert(err.message);
    if (err.status === 409) { home.dirty = false; await loadHomepage(); }
    return;
  }
  showToast(savedMessage(label));
  home.dirty = false;
  home.view = 'overview';
  home.selected = null;
  await refreshHomepage();
}

async function refreshHomepage() {
  await loadHomepage();
  if (home.frameOpened) reloadHomeFrame();
  loadDrafts();
}

async function moveMember(arg) {
  const [id, step] = arg.split(':');
  const team = [...home.data.team];
  const from = team.findIndex(m => m.id === id);
  const to = from + Number(step);
  if (from < 0 || to < 0 || to >= team.length) return;
  [team[from], team[to]] = [team[to], team[from]];
  document.querySelectorAll('#home-panel .icon-btn').forEach(b => { b.disabled = true; });
  try {
    await api('/api/team/order', { method: 'POST', json: { members: team.map(m => ({ id: m.id, version: m.version })) } });
  } catch (err) {
    alert(err.message);
  }
  await refreshHomepage();
}

async function removeMember(id) {
  const m = memberById(id);
  if (!m) return;
  if (!confirm(`Remove ${m.name} from the team on the website?${state.drafts ? '\n\nThis is a draft: you can still undo it with “Discard” before publishing.' : ''}`)) return;
  try {
    await api(`/api/team/${encodeURIComponent(id)}?version=${encodeURIComponent(m.version)}`, { method: 'DELETE' });
    showToast(savedMessage(`Removing ${m.name}`));
  } catch (err) {
    alert(err.message);
  }
  home.dirty = false;
  home.view = 'overview';
  await refreshHomepage();
}

document.getElementById('home-panel').addEventListener('input', e => {
  home.dirty = true;
  const live = e.target.dataset.live;
  if (live) toFrame({ type: 'sapta-set', field: live, value: e.target.value });
});
document.getElementById('home-panel').addEventListener('change', e => {
  if (e.target.name === 'imageSide') home.dirty = true;
});
document.getElementById('home-frame').addEventListener('load', () => {
  document.getElementById('home-frame-msg').hidden = true;
});
window.addEventListener('message', e => {
  // Only messages from the homepage frame on the preview server.
  if (!state.previewOrigin || e.origin !== state.previewOrigin || e.source !== document.getElementById('home-frame').contentWindow) return;
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  if (data.type === 'sapta-edit' && typeof data.field === 'string') openHomeField(data.field);
  else if (data.type === 'sapta-scroll') home.scrollY = Number(data.y) || 0;
  else if (data.type === 'sapta-ready' && home.selected) toFrame({ type: 'sapta-select', field: home.selected });
});

// ---------- drafts ----------

const CHANGE_LABEL = { added: 'New', modified: 'Changed', removed: 'Deleted' };
let draftsTimer = null;

function draftName(change) {
  if (change.kind === 'event') {
    const ev = state.events.find(e => e.slug === change.id);
    return `Event: ${ev ? ev.title : change.id}`;
  }
  if (change.kind === 'page') return change.id === 'home' ? 'Homepage' : change.id;
  if (change.kind === 'team') {
    const m = memberById(change.id);
    return `Team: ${m ? m.name : change.id}`;
  }
  if (change.kind === 'registration') return `Registration: ${change.id === 'group' ? 'Group' : change.id === 'spotlight' ? 'SAPTA Spotlight' : change.id}`;
  return change.path;
}

/** Loads the unpublished-changes bar. Polls while the preview is rebuilding. */
async function loadDrafts() {
  if (!state.drafts) return;
  clearTimeout(draftsTimer);
  let data;
  try {
    data = await api('/api/drafts');
  } catch (err) {
    document.getElementById('drafts-preview-state').textContent = err.message;
    draftsTimer = setTimeout(loadDrafts, 60_000);
    return;
  }
  state.draftHead = data.head;
  state.draftChanges = data.changes;
  const bar = document.getElementById('drafts-bar');
  const count = data.changes.length;
  bar.style.display = 'grid';
  bar.classList.toggle('is-clean', count === 0);
  document.getElementById('drafts-title').textContent = count
    ? `${count} unpublished change${count === 1 ? '' : 's'} — not on the website yet`
    : 'Everything is published — the website is up to date';
  document.getElementById('drafts-list').innerHTML = data.changes.map(c => `
    <li><span><span class="change-tag">${esc(CHANGE_LABEL[c.change] || c.change)}</span>${esc(draftName(c))}</span>
    ${c.kind === 'other' ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-action="discardDraft" data-arg="${esc(`${c.kind}:${c.id}`)}">Discard</button>`}</li>`).join('');
  if (data.problem) document.getElementById('drafts-list').insertAdjacentHTML('afterbegin', `<li style="color:var(--danger);">${esc(data.problem)}</li>`);

  // "Preview events page" is instant; the full preview site is a complete
  // build of the drafts that takes about half a minute to update.
  document.getElementById('drafts-instant').style.display = count ? '' : 'none';
  const preview = document.getElementById('drafts-preview');
  const stateText = document.getElementById('drafts-preview-state');
  if (data.preview.url) {
    preview.href = `${data.preview.url}/events/`;
    preview.style.display = count ? '' : 'none';
    preview.textContent = data.preview.state === 'ready' ? 'Full preview site ✓ ↗' : 'Full preview site (updating…) ↗';
    stateText.textContent = '';
  } else {
    preview.style.display = 'none';
    stateText.textContent = '';
  }
  document.getElementById('drafts-publish').style.display = count ? '' : 'none';
  document.getElementById('drafts-discard').style.display = count ? '' : 'none';
  renderEvents();
  if (count && data.preview.state === 'building') draftsTimer = setTimeout(loadDrafts, 15_000);
}

async function publishDrafts() {
  const names = state.draftChanges.map(c => `• ${CHANGE_LABEL[c.change] || c.change}: ${draftName(c)}`).join('\n');
  if (!confirm(`Publish these changes to saptaarts.org?\n\n${names}\n\nThe website updates in about 2–3 minutes.`)) return;
  const button = document.getElementById('drafts-publish');
  button.disabled = true;
  try {
    const data = await api('/api/drafts/publish', { method: 'POST', json: { head: state.draftHead } });
    if (data.published && data.commit) watchLiveSite(data.commit);
    else showToast('Nothing to publish.');
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
  }
  await loadEvents();
  loadDrafts();
}

async function discardDraft(key) {
  const [kind, id] = key.split(':');
  const change = state.draftChanges.find(c => c.kind === kind && c.id === id);
  if (!confirm(`Discard your unpublished changes to "${change ? draftName(change) : id}"? It goes back to what is on the website now.`)) return;
  try {
    await api('/api/drafts/discard', { method: 'POST', json: { kind, id } });
    showToast('Draft discarded.');
  } catch (err) {
    alert(err.message);
  }
  await Promise.all([loadEvents(), loadRegistrations(), home.loaded && loadHomepage()]);
  if (home.frameOpened) reloadHomeFrame();
  loadDrafts();
}

async function discardAllDrafts() {
  if (!confirm('Discard ALL unpublished changes? Everything goes back to what is on the website now. This cannot be undone.')) return;
  try {
    await api('/api/drafts/discard', { method: 'POST', json: { all: true } });
    showToast('All drafts discarded.');
  } catch (err) {
    alert(err.message);
  }
  await Promise.all([loadEvents(), loadRegistrations(), home.loaded && loadHomepage()]);
  if (home.frameOpened) reloadHomeFrame();
  loadDrafts();
}

let liveTimer = null;

/** Shows "Publishing…" until the live site serves the published commit. */
function watchLiveSite(commit, startedAt = Date.now()) {
  clearTimeout(liveTimer);
  const status = document.getElementById('publish-status');
  status.style.display = '';
  status.className = 'publish-status is-pending';
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  status.textContent = `⏳ Publishing to saptaarts.org… ${elapsed()}s (usually 1–2 minutes)`;
  liveTimer = setTimeout(async () => {
    let data = {};
    try { data = await api(`/api/live-status?commit=${commit}`); } catch {}
    if (data.live) {
      status.className = 'publish-status is-live';
      status.replaceChildren('✓ Live on saptaarts.org after ', `${elapsed()}s. `,
        el('a', { href: `${state.siteUrl || 'https://saptaarts.org'}/events/`, target: '_blank', rel: 'noopener noreferrer', textContent: 'View the website ↗' }));
      return;
    }
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      status.className = 'publish-status is-slow';
      status.textContent = 'Publishing is taking longer than usual. Check the "Deploy to GitHub Pages" run on GitHub (Actions tab).';
      return;
    }
    watchLiveSite(commit, startedAt);
  }, 8000);
}

/** Message after saving, depending on whether saves publish directly. */
function savedMessage(what) {
  if (state.drafts) return `${what} saved as a draft — not on the website yet. Use Preview to check it, then Publish.`;
  return state.publishes ? `${what} saved. The website will update in about 2–3 minutes.` : `${what} saved to the local files.`;
}

// ---------- registrations ----------

async function loadRegistrations() {
  try {
    state.registrations = (await api('/api/registrations')).registrations;
  } catch (err) {
    return showToast(err.message);
  }
  document.getElementById('registrations-list').innerHTML = state.registrations.map(reg => `
    <div class="card" style="padding:22px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 class="card-title">${esc(reg.title)}</h3>
        <span class="status-badge ${reg.status === 'open' ? 'status-open' : 'status-coming-soon'}">${reg.status === 'open' ? 'Open' : 'Coming soon'}</span>
      </div>
      <form data-submit="saveRegistration" data-arg="${esc(reg.id)}" class="reg-form ${reg.status === 'open' ? 'is-open' : 'is-soon'}">
        <input type="hidden" name="version" value="${esc(reg.version)}">
        <div class="form-group">
          <label>Registration status</label>
          <select name="status" data-change="toggleRegistrationStatus">
            <option value="coming-soon" ${reg.status === 'coming-soon' ? 'selected' : ''}>Coming soon — no form on the page</option>
            <option value="open" ${reg.status === 'open' ? 'selected' : ''}>Open — show the form on the page</option>
          </select>
        </div>
        <div class="form-group">
          <label>Form link</label>
          <input type="url" name="url" value="${esc(reg.url)}" placeholder="https://forms.gle/…  or  https://docs.google.com/forms/…">
          <span class="help-text">Google Forms links are shown <strong>inside</strong> the page. Other links get an “Open registration form” button.</span>
        </div>
        <div class="form-group only-open">
          <label>Message when open</label>
          <textarea name="openMessage" rows="2" placeholder="Registration is open! Fill in the form below.">${esc(reg.openMessage)}</textarea>
          <span class="help-text">Optional. Leave empty to use the text shown in grey.</span>
        </div>
        <div class="form-group only-soon">
          <label>Message while coming soon</label>
          <textarea name="message" rows="2">${esc(reg.message)}</textarea>
          <span class="help-text">Hidden automatically while registration is open.</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-secondary btn-sm" data-action="previewRegistration" data-id="${esc(reg.id)}">Preview</button>
          <button type="submit" class="btn btn-primary btn-sm">Save Registration</button>
        </div>
      </form>
    </div>`).join('');
}

/** Shows the message field that applies to the chosen status. */
function toggleRegistrationStatus(select) {
  const form = select.closest('form');
  form.classList.toggle('is-open', select.value === 'open');
  form.classList.toggle('is-soon', select.value !== 'open');
}

async function saveRegistration(e, id) {
  const fields = e.target.elements;
  try {
    const data = await api('/api/registrations/' + encodeURIComponent(id), {
      method: 'POST',
      json: {
        version: fields.namedItem('version').value,
        status: fields.namedItem('status').value,
        message: fields.namedItem('message').value.trim(),
        openMessage: fields.namedItem('openMessage').value.trim(),
        url: fields.namedItem('url').value.trim(),
      },
    });
    const opened = fields.namedItem('status').value === 'open';
    showToast(savedMessage('Registration'));
    if (opened && data?.embedded && data.signIn) {
      alert('Saved. The form will be shown inside the page, but this form requires visitors to sign in to Google before filling it in (for example because it has a file-upload question or verified email collection). Google\'s sign-in cannot open inside another website, so the page also offers to open the form in a new tab.\n\nFor the smoothest experience, remove file-upload questions and set "Collect email addresses" to "Responder input" in the form\'s Settings.');
    }
    if (opened && data && data.embedded === false) {
      const why = {
        'needs-sign-in': 'Google does not allow this form to be shown inside other websites.\n\nRemoving file-upload questions and setting "Collect email addresses" to "Responder input" in the form\'s Settings usually fixes this. The website re-checks every few hours.',
        'not-supported': 'This link is not a Google Form, so it cannot be shown inside the page.',
        'unreachable': 'The form could not be checked right now (or the link is wrong). Please open the link to make sure it works.',
      }[data.embedReason] || '';
      alert(`Saved. Visitors will get an “Open registration form” button rather than the form inside the page.\n\n${why}`);
    }
  } catch (err) {
    alert(err.message);
  }
  loadRegistrations();
  loadDrafts();
}

// ---------- status ----------

async function loadStatus() {
  const list = document.getElementById('cloud-status-list');
  let data;
  try {
    data = await api('/api/status');
  } catch (err) {
    list.replaceChildren(el('li', { textContent: err.message }));
    return;
  }
  const line = (label, check) => el('li', {}, [
    el('strong', { textContent: `${check.ok ? '✓' : '✗'} ${label}: `, style: `color:${check.ok ? 'var(--success)' : 'var(--danger)'}` }),
    document.createTextNode(check.detail),
  ]);
  list.replaceChildren(
    line('Saving', data.storage),
    line('Cloudinary', data.cloudinary),
    el('li', { textContent: `Upload folder: ${data.folder}` }),
    el('li', { textContent: `Size limits: photos ${data.limitsMb.photo} MB, videos ${data.limitsMb.video} MB` }),
    el('li', { textContent: `Who can log in: ${data.allowedEmails.join(', ')}` }),
  );
}

// ---------- dispatch ----------

const clickActions = {
  logout, switchTab, openNewEventModal, selectMediaFolder, closeEventModal, openMediaPicker, addEmptyGalleryRow,
  addVideoRow: () => addVideoRow(), closeMediaPicker, selectPickerFolder, editEvent, deleteEvent, copyUrl,
  publishDrafts, discardDraft, discardAllDrafts, createFolder, renameFolder, deleteFolder, restoreUnsaved, discardUnsaved,
  previewEvent, previewRegistration,
  previewAllDrafts: () => window.open(state.previewOrigin && state.previewPass
    ? `${state.previewOrigin}/preview/events?token=${encodeURIComponent(state.previewPass)}`
    : '/preview/events', '_blank', 'noopener'),
  selectPickerImage, moveRowUp, moveRowDown, removeRow, retryUpload, deleteMedia,
  pickFile: id => document.getElementById(id)?.click(),
  homeViewport, openHomeView, homeBack, pickHomeFile, pickHomeFromLibrary, useDefaultBanner, moveMember, removeMember,
};
const changeActions = { uploadHomeImage, handleQuickUpload, uploadFlyerFile, uploadGalleryFiles, uploadVideoFiles, moveMedia, toggleRegistrationStatus };
const submitActions = { saveEvent, saveRegistration, saveHomeSection };

document.addEventListener('click', e => {
  // Let clicks on file inputs through untouched, or the file dialog would not open.
  if (e.target.matches('input[type="file"]')) return;
  const target = e.target.closest('[data-action]');
  const action = target && clickActions[target.dataset.action];
  if (!action) return;
  e.preventDefault();
  action(target.dataset.arg, target, e);
});

document.addEventListener('change', e => {
  const action = changeActions[e.target.dataset?.change];
  if (action) action(e.target);
});

document.addEventListener('submit', e => {
  const form = e.target.closest('[data-submit]');
  const action = form && submitActions[form.dataset.submit];
  if (!action) return;
  e.preventDefault();
  action(e, form.dataset.arg);
});

// Broken images fall back to a local placeholder (no third-party requests).
document.addEventListener('error', e => {
  if (e.target.tagName === 'IMG' && e.target.hasAttribute('data-fallback') && e.target.src !== PLACEHOLDER) e.target.src = PLACEHOLDER;
}, true);

document.getElementById('ev-flyer').addEventListener('input', e => updateFlyerPreview(e.target.value));
document.getElementById('ev-slug').addEventListener('input', () => { state.slugTouched = true; });
document.getElementById('ev-title').addEventListener('input', e => {
  if (state.isNewEvent && !state.slugTouched) document.getElementById('ev-slug').value = slugify(e.target.value);
});
window.addEventListener('beforeunload', e => {
  if (state.uploadsInFlight > 0) e.preventDefault();
});

// Errors from the Google sign-in redirect arrive as ?login_error=...; show once, then tidy the URL.
const loginError = new URLSearchParams(location.search).get('login_error');
if (loginError) {
  history.replaceState(null, '', '/');
  showLoginError(loginError);
}

checkAuth();
