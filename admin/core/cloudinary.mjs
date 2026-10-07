// Cloudinary on the server side: signs upload requests so the browser can
// upload straight to Cloudinary without ever seeing the API secret, and reads
// the Media Library via the Admin API.
import crypto from 'node:crypto';
import { ALLOWED_FORMATS, deliveryUrl } from '../public/shared/cloudinary-url.mjs';

// https://cloudinary.com/documentation/authentication_signatures
export function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

const tagFor = value => String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60);

/**
 * Everything the browser needs for one upload. Folder, tags, accepted formats
 * and overwrite protection are all inside the signature, so the browser cannot
 * change them. Signatures expire after one hour (Cloudinary checks timestamp).
 */
export function signUpload(cfg, { kind, eventSlug, customFolder, filename, actor }) {
  const target = customFolder
    ? { folder: `${cfg.folder}/folders/${customFolder}`, tag: `folder-${tagFor(customFolder)}` }
    : { folder: `${cfg.folder}/events/${eventSlug || 'unsorted'}`, tag: `event-${tagFor(eventSlug || 'unsorted')}` };
  const params = {
    folder: target.folder,
    tags: ['sapta', target.tag].join(','),
    context: `original_filename=${String(filename || 'upload').replace(/[|=]/g, '_').slice(0, 200)}|uploaded_by=${String(actor).replace(/[|=]/g, '_')}`,
    allowed_formats: ALLOWED_FORMATS[kind].join(','),
    use_filename: 'true',
    unique_filename: 'true',
    overwrite: 'false',
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/${kind === 'video' ? 'video' : 'image'}/upload`,
    fields: { ...params, signature: signParams(params, cfg.apiSecret), api_key: cfg.apiKey },
  };
}

function adminHeaders(cfg) {
  return { Authorization: `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64')}` };
}

/** Assets tagged "sapta", so uploads not yet attached to an event stay findable. */
export async function listTaggedResources(cfg, { fetchImpl = fetch } = {}) {
  const results = [];
  for (const resourceType of ['image', 'video']) {
    const response = await fetchImpl(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/resources/${resourceType}/tags/sapta?max_results=500&context=true`,
      { headers: adminHeaders(cfg), signal: AbortSignal.timeout(20_000) },
    );
    if (!response.ok) throw new Error(`Cloudinary media listing failed (HTTP ${response.status}).`);
    const json = await response.json();
    for (const r of json.resources || []) {
      results.push({
        url: deliveryUrl(r),
        type: r.resource_type === 'video' ? 'video' : 'photo',
        title: r.context?.custom?.original_filename || r.public_id.split('/').pop(),
        folder: r.asset_folder || r.public_id.split('/').slice(0, -1).join('/'),
      });
    }
  }
  return results;
}

/**
 * Deletes assets of one resource type (max 100 per call) and purges them from
 * the CDN. Returns { [publicId]: 'deleted' | 'not_found' }.
 */
export async function deleteResources(cfg, resourceType, publicIds, { fetchImpl = fetch } = {}) {
  const query = new URLSearchParams({ invalidate: 'true' });
  for (const id of publicIds) query.append('public_ids[]', id);
  const response = await fetchImpl(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/resources/${resourceType}/upload?${query}`,
    { method: 'DELETE', headers: adminHeaders(cfg), signal: AbortSignal.timeout(20_000) },
  );
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message || `Cloudinary delete failed (HTTP ${response.status}).`);
  return json.deleted || {};
}

/** Creates a Media Library folder (no-op if it exists). */
export async function createFolder(cfg, path, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/folders/${path.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'POST', headers: adminHeaders(cfg), signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok && response.status !== 409) throw new Error(`Could not create Cloudinary folder ${path} (HTTP ${response.status}).`);
}

const folderUrl = (cfg, path) => `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/folders/${path.split('/').map(encodeURIComponent).join('/')}`;

async function adminCall(cfg, url, init, what, fetchImpl) {
  const response = await fetchImpl(url, { ...init, headers: { ...adminHeaders(cfg), ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error?.message || `Cloudinary could not ${what} (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return json;
}

/** Names of the folders directly inside `path` (empty list if it does not exist). */
export async function listSubfolders(cfg, path, { fetchImpl = fetch } = {}) {
  try {
    const json = await adminCall(cfg, `${folderUrl(cfg, path)}?max_results=500`, { method: 'GET' }, 'list folders', fetchImpl);
    return (json.folders || []).map(f => f.name);
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/**
 * Renames a folder. With Cloudinary's dynamic folders the files inside keep
 * their public IDs, so every existing link keeps working.
 */
export async function renameFolder(cfg, from, to, { fetchImpl = fetch } = {}) {
  await adminCall(cfg, folderUrl(cfg, from), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ to_folder: to }).toString(),
  }, 'rename the folder', fetchImpl);
}

/** Deletes a folder; Cloudinary refuses if it still contains files. */
export async function deleteFolder(cfg, path, { fetchImpl = fetch } = {}) {
  await adminCall(cfg, folderUrl(cfg, path), { method: 'DELETE' }, 'delete the folder', fetchImpl);
}

/** Moves one asset to another folder (its URL does not change). */
export async function moveAsset(cfg, { resourceType, publicId }, folder, { fetchImpl = fetch } = {}) {
  await adminCall(cfg, `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/resources/${resourceType}/upload/${publicId.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ asset_folder: folder }).toString(),
  }, 'move the file', fetchImpl);
}

/** Checks the credentials with the Admin API "ping" endpoint. */
export async function checkCloudinary(cfg, { fetchImpl = fetch } = {}) {
  if (!cfg.ready) return { ok: false, detail: cfg.problems.join(' ') };
  try {
    const response = await fetchImpl(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/ping`, {
      headers: adminHeaders(cfg), signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true, detail: `Connected to "${cfg.cloudName}" with signed uploads.` };
    if (response.status === 401) return { ok: false, detail: 'Cloudinary rejected the API key or secret.' };
    return { ok: false, detail: `Cloudinary responded with HTTP ${response.status}.` };
  } catch {
    return { ok: false, detail: 'Could not reach Cloudinary.' };
  }
}
