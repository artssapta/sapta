#!/usr/bin/env node
// Makes small, phone-friendly WebP copies of the website's own images.
//
//   npm run images
//
// For every JPG/PNG/WebP in public/assets and public/uploads it writes
// public/_img/<same path>-<width>.webp at 480, 960 and 1600 px wide (never
// larger than the original), applying the camera's rotation, plus
// public/_img/manifest.json with each image's size and available widths.
// src/lib/images.mjs uses the manifest to give every <img> a srcset, so a
// phone downloads a ~50 KB file instead of a 5 MB photo.
//
// The output is committed, so site builds stay fast. Run this again after
// adding images to public/assets (tests/images.test.mjs reminds you).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, '_img');
const SOURCES = ['assets', 'uploads'];
export const WIDTHS = [480, 960, 1600];
const QUALITY = 78;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) yield full;
  }
}

const outName = (rel, width) => rel.replace(/\.[^.]+$/, `-${width}.webp`);

const manifest = {};
let made = 0;
let reused = 0;
let before = 0;
let after = 0;

for (const dir of SOURCES) {
  for await (const file of walk(path.join(PUBLIC, dir))) {
    const rel = path.relative(PUBLIC, file).split(path.sep).join('/'); // assets/x/IMG_1.JPG
    const stat = await fs.stat(file);
    const meta = await sharp(file).metadata();
    // EXIF orientations 5–8 swap width and height.
    const [w, h] = (meta.orientation || 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
    const widths = [...new Set(WIDTHS.map(width => Math.min(width, w)))];
    before += stat.size;
    for (const width of widths) {
      const target = path.join(OUT, outName(rel, width));
      const existing = await fs.stat(target).catch(() => null);
      if (existing && existing.mtimeMs >= stat.mtimeMs) {
        reused++;
        after += existing.size;
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const info = await sharp(file).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: QUALITY }).toFile(target);
      after += info.size;
      made++;
    }
    manifest[`/${rel}`] = { width: w, height: h, widths };
  }
}

// Icons and the link-preview image (WhatsApp, iMessage, social media),
// all made from the logo.
const LOGO = path.join(PUBLIC, 'assets', 'image_186b79.png');
const LOGO_BLUE = { r: 51, g: 109, b: 159 };
const icons = [
  ['favicon-32.png', img => img.resize(32, 32, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png()],
  ['apple-touch-icon.png', img => img.resize(180, 180, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png()],
  // The logo's own blue (rgb 51,109,159) extended to 1200×630, the size link previews use.
  ['og-image.jpg', img => img.flatten({ background: LOGO_BLUE }).resize(560, 525, { fit: 'contain', background: LOGO_BLUE })
    .extend({ top: 52, bottom: 53, left: 320, right: 320, background: LOGO_BLUE }).jpeg({ quality: 86 })],
];
const logoTime = (await fs.stat(LOGO)).mtimeMs;
for (const [name, make] of icons) {
  const target = path.join(PUBLIC, name);
  const existing = await fs.stat(target).catch(() => null);
  if (existing && existing.mtimeMs >= logoTime) continue;
  await make(sharp(LOGO)).toFile(target);
  made++;
}

const sorted = Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]]));
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${Object.keys(sorted).length} images: ${made} versions made, ${reused} already up to date.`);
console.log(`Originals ${(before / 1048576).toFixed(1)} MB → all optimized versions ${(after / 1048576).toFixed(1)} MB.`);
