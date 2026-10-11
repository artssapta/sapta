// Responsive images: every <img> gets a srcset so a phone downloads a small
// file and a large screen a sharp one.
//  - Site images (/assets/…, /uploads/…) use the WebP copies made by
//    `npm run images` (listed in public/_img/manifest.json).
//  - Cloudinary photos are resized by Cloudinary (f_auto,q_auto,c_limit,w_…).
// Used by the Astro components and by the admin's instant preview, so both
// produce the same markup.
import manifest from '../../public/_img/manifest.json' with { type: 'json' };
import { cloudinaryImage } from './media.mjs';

const CLOUDINARY_WIDTHS = [480, 960, 1600];

/**
 * Attributes for an <img>: { src, srcset?, sizes?, width?, height? }.
 * `sizes` describes how wide the image is shown, e.g. "(max-width: 600px) 50vw, 300px".
 * `fallbackWidth` picks the plain src for browsers without srcset support.
 */
export function responsiveImage(src, { sizes, fallbackWidth = 960 } = {}) {
  if (!src) return { src };
  const entry = manifest[src];
  if (entry) {
    const base = src.replace(/\.[^./]+$/, '');
    const url = width => `/_img${base}-${width}.webp`;
    const fallback = entry.widths.find(w => w >= fallbackWidth) ?? entry.widths[entry.widths.length - 1];
    return {
      src: url(fallback),
      srcset: entry.widths.map(w => `${url(w)} ${w}w`).join(', '),
      sizes,
      width: entry.width,
      height: entry.height,
    };
  }
  if (/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(src)) {
    return {
      src: cloudinaryImage(src, fallbackWidth),
      srcset: CLOUDINARY_WIDTHS.map(w => `${cloudinaryImage(src, w)} ${w}w`).join(', '),
      sizes,
    };
  }
  return { src };
}

/** A single optimized URL (e.g. for CSS backgrounds), or the original. */
export function optimizedUrl(src, width = 1600) {
  const entry = manifest[src];
  if (entry) {
    const pick = entry.widths.find(w => w >= width) ?? entry.widths[entry.widths.length - 1];
    return `/_img${src.replace(/\.[^./]+$/, '')}-${pick}.webp`;
  }
  return /^https:\/\/res\.cloudinary\.com\//.test(src || '') ? cloudinaryImage(src, width) : src;
}
