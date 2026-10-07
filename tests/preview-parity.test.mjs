// The admin's instant preview must render exactly what the real site renders.
// This builds the site with Astro and compares, so a change to Events.astro or
// Registration.astro that is not mirrored in admin/core/render-preview.mjs
// fails the tests (and therefore blocks publishing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderEventsSection, renderRegistrationSection, normalizeHtml } from '../admin/core/render-preview.mjs';
import { eventFromFile, registrationFromFile } from '../admin/core/content.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let out;

function built(page) {
  if (!out) {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'sapta-parity-'));
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', out, '--silent'], { cwd: ROOT, stdio: 'pipe' });
  }
  return fs.readFileSync(path.join(out, page, 'index.html'), 'utf-8');
}

/** The first <section class="…"> … </section> and its scoped-style attribute. */
function section(html, className) {
  const start = html.indexOf(`<section class="${className}"`);
  assert.ok(start >= 0, `section .${className} not found`);
  const end = html.indexOf('</section>', start) + '</section>'.length;
  const markup = html.slice(start, end);
  return { markup, cid: markup.match(/data-astro-cid-[a-z0-9]+/)?.[0] };
}

const contentDir = dir => path.join(ROOT, 'src/content', dir);

test('instant preview renders the Events section exactly like the site', { timeout: 120_000 }, () => {
  const { markup, cid } = section(built('events'), 'events-section');
  const events = fs.readdirSync(contentDir('events')).filter(f => f.endsWith('.md')).map(f => {
    const slug = f.slice(0, -3);
    const { slug: _, ...data } = eventFromFile(slug, fs.readFileSync(path.join(contentDir('events'), f), 'utf-8'));
    return { ...data, id: slug };
  });
  const title = markup.match(/<h1[^>]*>([^<]*)<\/h1>/)[1];
  const color = markup.match(/background-color: ([^;"]+);/)[1];
  assert.equal(normalizeHtml(renderEventsSection(events, { title, color, cid })), normalizeHtml(markup));
});

for (const id of ['group', 'spotlight']) {
  test(`instant preview renders the ${id} registration page exactly like the site`, { timeout: 120_000 }, () => {
    const { markup, cid } = section(built(`registration/${id}`), 'registration');
    const reg = registrationFromFile(id, fs.readFileSync(path.join(contentDir('registrations'), `${id}.md`), 'utf-8'));
    assert.equal(normalizeHtml(renderRegistrationSection(reg, { cid })), normalizeHtml(markup));
  });
}

test('instant preview also matches for open registrations and every event layout', () => {
  // Layout branches the current content may not exercise: an open form, an
  // upcoming event without media, and an uploaded video.
  const open = renderRegistrationSection({ title: 'T', status: 'open', message: 'M', url: 'https://forms.gle/x' }, { cid: 'data-astro-cid-x' });
  assert.match(open, /class="action" href="https:\/\/forms\.gle\/x" target="_blank"/);
  assert.match(open, /The form opens in a new tab\./);
  const upcoming = renderEventsSection([{ id: 'n', order: 1, status: 'upcoming', title: 'N & Co', date: 'D', time: '', location: '', subtitle: '', description: "It's", flyerImage: '/assets/f.png', gallery: [], videos: [] }], { cid: 'data-astro-cid-x' });
  assert.match(upcoming, /upcoming-event-card/);
  assert.match(upcoming, /N &amp; Co/);
  assert.match(upcoming, /It&#39;s/);
  const video = renderEventsSection([{ id: 'v', order: 1, status: 'past', title: 'V', date: 'D', flyerImage: '/assets/f.png', gallery: [], videos: [{ title: 'Clip', source: 'upload', file: 'https://res.cloudinary.com/d/video/upload/v1/c.mp4' }] }], {});
  assert.match(video, /<source src="https:\/\/res\.cloudinary\.com\/d\/video\/upload\/v1\/c\.mp4" type="video\/mp4">/);
});
