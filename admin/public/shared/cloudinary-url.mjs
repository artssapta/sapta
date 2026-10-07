// Cloudinary URL rules shared by the admin server and the admin page.
// No Node or browser-specific APIs here: this file runs in both.

// Formats every browser can display; anything else (HEIC, TIFF, MOV, ...) is
// requested in a converted format, which Cloudinary produces on delivery.
const WEB_IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif']);
const WEB_VIDEO_FORMATS = new Set(['mp4', 'webm']);

/**
 * The URL stored in event content for an upload result. Browser-safe
 * originals are used as-is; iPhone HEIC photos become .jpg and MOV videos
 * .mp4. Video URLs therefore always end in .mp4/.webm, which the site's
 * content schema requires.
 */
export function deliveryUrl({ secure_url: secureUrl, resource_type: resourceType, format }) {
  const url = new URL(secureUrl);
  const fmt = String(format || '').toLowerCase();
  const target = resourceType === 'video'
    ? (WEB_VIDEO_FORMATS.has(fmt) ? fmt : 'mp4')
    : (WEB_IMAGE_FORMATS.has(fmt) ? fmt : 'jpg');
  const segments = url.pathname.split('/');
  const last = segments.pop();
  const base = last.includes('.') ? last.slice(0, last.lastIndexOf('.')) : last;
  segments.push(`${base}.${target}`);
  url.pathname = segments.join('/');
  return url.href;
}

/** True for https://res.cloudinary.com/<cloudName>/(image|video)/upload/... */
export function isOwnCloudinaryUrl(value, cloudName) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'res.cloudinary.com'
      && !url.username && !url.password
      && url.pathname.startsWith(`/${cloudName}/`)
      && /^\/[^/]+\/(image|video)\/upload\//.test(url.pathname);
  } catch {
    return false;
  }
}

const isTransformation = segment => segment.includes(',') || /^[a-z]{1,3}_[^/]+$/.test(segment);

/**
 * { resourceType, publicId } for one of this account's delivery URLs, or null.
 * Handles optional transformations and version segments, and drops the
 * extension (public IDs have none).
 */
export function cloudinaryAsset(value, cloudName) {
  if (!isOwnCloudinaryUrl(value, cloudName)) return null;
  const [, , resourceType, , ...rest] = new URL(value).pathname.split('/');
  let i = 0;
  while (i < rest.length - 1 && isTransformation(rest[i])) i++;
  if (i < rest.length - 1 && /^v\d+$/.test(rest[i])) i++;
  const path = rest.slice(i).map(decodeURIComponent).join('/');
  const publicId = path.replace(/\.[a-z0-9]+$/i, '');
  return publicId ? { resourceType, publicId } : null;
}

/**
 * A small preview of a Cloudinary photo or video (a still frame for videos),
 * cropped to `width`×`height` around the interesting part and served in the
 * browser's best format. Non-Cloudinary URLs are returned unchanged.
 */
export function cloudinaryThumb(value, { width = 300, height = width, crop = 'fill' } = {}) {
  let url;
  try { url = new URL(value); } catch { return value; }
  const match = url.hostname === 'res.cloudinary.com' && url.pathname.match(/^(\/[^/]+\/(image|video)\/upload\/)(.+)$/);
  if (!match) return value;
  const [, prefix, type, rest] = match;
  const size = crop === 'fill' ? `c_fill,g_auto,w_${width},h_${height}` : `c_limit,w_${width},h_${height}`;
  if (type === 'video') {
    url.pathname = `${prefix}so_1,${size},q_auto/${rest.replace(/\.[a-z0-9]+$/i, '')}.jpg`;
  } else {
    url.pathname = `${prefix}${size},f_auto,q_auto/${rest}`;
  }
  url.search = '';
  return url.href;
}

// Formats Cloudinary will accept per upload kind (enforced via the signed
// allowed_formats parameter). SVG and other script-capable types are excluded.
export const ALLOWED_FORMATS = {
  photo: ['jpg', 'png', 'webp', 'avif', 'heic', 'heif', 'gif', 'tiff'],
  video: ['mp4', 'mov', 'webm', 'm4v'],
};
