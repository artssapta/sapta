import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { responsiveImage, optimizedUrl } from '../src/lib/images.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, '_img', 'manifest.json'), 'utf-8'));

function* images(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* images(full);
    else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) yield `/${path.relative(PUBLIC, full).split(path.sep).join('/')}`;
  }
}

test('every website image has phone-sized versions (run "npm run images" after adding images)', () => {
  const missing = [];
  for (const dir of ['assets', 'uploads']) {
    for (const src of images(path.join(PUBLIC, dir))) {
      const entry = manifest[src];
      if (!entry) { missing.push(`${src} (not in manifest)`); continue; }
      for (const width of entry.widths) {
        const file = path.join(PUBLIC, '_img', `${src.slice(1).replace(/\.[^.]+$/, '')}-${width}.webp`);
        if (!fs.existsSync(file)) missing.push(`${src} → ${width}px`);
      }
    }
  }
  assert.deepEqual(missing, [], `Run "npm run images" and commit public/_img:\n${missing.join('\n')}`);
});

test('icons and the link-preview image exist', () => {
  for (const file of ['favicon-32.png', 'apple-touch-icon.png', 'og-image.jpg']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, file)), file);
  }
});

test('responsive images: site files and Cloudinary photos get srcsets, others pass through', () => {
  const [src] = Object.keys(manifest);
  const local = responsiveImage(src, { sizes: '50vw' });
  assert.match(local.src, /^\/_img\/.+-\d+\.webp$/);
  assert.equal(local.srcset.split(', ').length, manifest[src].widths.length);
  assert.equal(local.width, manifest[src].width);
  const cloud = responsiveImage('https://res.cloudinary.com/demo/image/upload/v1/a.jpg', { sizes: '50vw' });
  assert.match(cloud.srcset, /c_limit,w_480\/v1\/a\.jpg 480w/);
  assert.deepEqual(responsiveImage('/assets/not-there.png'), { src: '/assets/not-there.png' });
  assert.equal(optimizedUrl('https://example.org/x.jpg'), 'https://example.org/x.jpg');
});
