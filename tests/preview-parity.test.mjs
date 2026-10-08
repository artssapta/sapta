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
import { formEmbedUrl, resolveFormEmbed } from '../src/lib/media.mjs';
import { eventFromFile, registrationFromFile } from '../admin/core/content.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builds = {};

/**
 * Builds the site once per variant. "real" is the repository as it is;
 * "open" is a temporary copy where both registrations are open, so the
 * embedded-form and button layouts are checked too.
 */
function built(variant, page) {
  if (!builds[variant]) {
    let root = ROOT;
    if (variant !== 'real') {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'sapta-parity-src-'));
      for (const entry of ['src', 'astro.config.mjs', 'package.json']) fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
      for (const entry of ['public', 'node_modules']) fs.symlinkSync(path.join(ROOT, entry), path.join(root, entry));
      for (const [id, data] of Object.entries(variant === 'open' ? OPEN_REGISTRATIONS : SOON_REGISTRATIONS)) {
        fs.writeFileSync(path.join(root, 'src/content/registrations', `${id}.md`), `---\n${Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`);
      }
    }
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sapta-parity-'));
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', out, '--silent'], {
      cwd: root, stdio: 'pipe', env: { ...process.env, SAPTA_SKIP_FORM_CHECK: '1' }, // no network needed
    });
    builds[variant] = out;
  }
  return fs.readFileSync(path.join(builds[variant], page, 'index.html'), 'utf-8');
}

const SOON_REGISTRATIONS = {
  group: { title: 'Group Registration', status: 'coming-soon', message: "We're preparing the next round.", url: '' },
  spotlight: { title: 'SAPTA Spotlight', status: 'coming-soon', message: 'Coming soon.', openMessage: 'Not shown while coming soon', url: 'https://forms.gle/abc' },
};

// Links that need no network at build time (a forms.gle link would).
const OPEN_REGISTRATIONS = {
  group: { title: 'Group Registration', status: 'open', message: "We're preparing the next round.", openMessage: 'Sign up your group below!', url: 'https://docs.google.com/forms/d/e/1FAIpQLScgKqjFdibHT11I5htoLphuKNhGikKiIOyrpeQwuGSD2ul0mw/viewform?usp=header' },
  spotlight: { title: 'SAPTA Spotlight', status: 'open', message: 'Coming soon.', url: 'https://example.org/spotlight-form' },
};

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
  const { markup, cid } = section(built('real', 'events'), 'events-section');
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
  test(`instant preview renders the ${id} registration page exactly like the site (current content)`, { timeout: 120_000 }, async () => {
    const { markup, cid } = section(built('real', `registration/${id}`), 'registration');
    const reg = registrationFromFile(id, fs.readFileSync(path.join(contentDir('registrations'), `${id}.md`), 'utf-8'));
    const embed = reg.status === 'open' ? await resolveFormEmbed(reg.url, { verify: false }) : null;
    assert.equal(normalizeHtml(renderRegistrationSection(reg, { cid, embed })), normalizeHtml(markup));
  });

  test(`instant preview renders the ${id} registration page exactly like the site (coming soon)`, { timeout: 120_000 }, () => {
    const { markup, cid } = section(built('soon', `registration/${id}`), 'registration');
    assert.equal(normalizeHtml(renderRegistrationSection(SOON_REGISTRATIONS[id], { cid })), normalizeHtml(markup));
  });

  test(`instant preview renders the ${id} registration page exactly like the site (open)`, { timeout: 120_000 }, () => {
    const { markup, cid } = section(built('open', `registration/${id}`), 'registration');
    const reg = OPEN_REGISTRATIONS[id];
    assert.equal(normalizeHtml(renderRegistrationSection(reg, { cid, embed: formEmbedUrl(reg.url) })), normalizeHtml(markup));
  });
}

test('open registrations: Google Forms are embedded and the "preparing" text is gone', () => {
  const group = built('open', 'registration/group');
  assert.match(group, /<iframe src="https:\/\/docs\.google\.com\/forms\/d\/e\/1FAIpQLScgKqjFdibHT11I5htoLphuKNhGikKiIOyrpeQwuGSD2ul0mw\/viewform\?embedded=true"/);
  assert.match(group, /Sign up your group below!/);
  assert.doesNotMatch(group, /preparing/);
  assert.doesNotMatch(group, /will appear on this page/);
  const spotlight = built('open', 'registration/spotlight');
  assert.doesNotMatch(spotlight, /<iframe/, 'non-Google links are not embedded');
  assert.match(spotlight, /class="action" href="https:\/\/example\.org\/spotlight-form"/);
  assert.match(spotlight, /Registration is open! Use the button below/);
  assert.doesNotMatch(spotlight, /Coming soon\./);
});

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
