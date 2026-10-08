import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenCodec } from '../admin/core/session.mjs';
import { signParams, signUpload } from '../admin/core/cloudinary.mjs';
import { deliveryUrl, isOwnCloudinaryUrl } from '../admin/public/shared/cloudinary-url.mjs';
import { validateEvent, stringifyFrontmatter, parseFrontmatter } from '../admin/core/content.mjs';
import { readConfig, ConfigError } from '../admin/core/config.mjs';
import { cloudinaryImage } from '../src/lib/media.mjs';

const cloud = { cloudName: 'demo', apiKey: 'key', apiSecret: 'secret', folder: 'sapta', ready: true, problems: [] };

test('session tokens: valid, tamper-proof, purpose-bound and expiring', () => {
  const codec = createTokenCodec('x'.repeat(32));
  const token = codec.sign('session', { sub: 'a@b.c' }, 60);
  assert.equal(codec.verify('session', token).sub, 'a@b.c');
  assert.equal(codec.verify('google-oauth', token), null, 'cannot be replayed as another token type');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'evil@x.y', exp: 9e9 })).toString('base64url');
  assert.equal(codec.verify('session', `${forged}.${sig}`), null);
  assert.equal(createTokenCodec('y'.repeat(32)).verify('session', token), null, 'other secret');
  assert.equal(codec.verify('session', codec.sign('session', {}, -1)), null, 'expired');
  assert.equal(codec.verify('session', `${body}`), null);
});

test('Cloudinary signature matches the documented example', () => {
  // https://cloudinary.com/documentation/authentication_signatures
  assert.equal(
    signParams({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: '1315060510' }, 'abcd'),
    'bfd09f95f331f558cbd1320e67aa8d488770583e',
  );
});

test('signed uploads pin folder, tags, formats and no-overwrite', () => {
  const { uploadUrl, fields } = signUpload(cloud, { kind: 'photo', eventSlug: 'svasthya', filename: 'IMG_1.HEIC', actor: 'artssapta@gmail.com' });
  assert.equal(uploadUrl, 'https://api.cloudinary.com/v1_1/demo/image/upload');
  assert.equal(fields.folder, 'sapta/events/svasthya');
  assert.equal(fields.tags, 'sapta,event-svasthya');
  assert.equal(fields.overwrite, 'false');
  assert.match(fields.allowed_formats, /heic/);
  assert.doesNotMatch(fields.allowed_formats, /svg/);
  const { signature, api_key: apiKey, ...signed } = fields;
  assert.equal(apiKey, 'key');
  assert.equal(signature, signParams(signed, 'secret'), 'every parameter is covered by the signature');
  assert.equal(signUpload(cloud, { kind: 'video', eventSlug: 'x', actor: 'a' }).uploadUrl, 'https://api.cloudinary.com/v1_1/demo/video/upload');
});

test('delivery URLs are browser-safe: HEIC → JPG, MOV → MP4', () => {
  const base = 'https://res.cloudinary.com/demo';
  assert.equal(deliveryUrl({ secure_url: `${base}/image/upload/v1/sapta/events/x/a.heic`, resource_type: 'image', format: 'heic' }), `${base}/image/upload/v1/sapta/events/x/a.jpg`);
  assert.equal(deliveryUrl({ secure_url: `${base}/image/upload/v1/a.png`, resource_type: 'image', format: 'png' }), `${base}/image/upload/v1/a.png`);
  assert.equal(deliveryUrl({ secure_url: `${base}/video/upload/v1/clip.mov`, resource_type: 'video', format: 'mov' }), `${base}/video/upload/v1/clip.mp4`);
});

test('only this account\'s Cloudinary URLs count as Cloudinary media', () => {
  assert.ok(isOwnCloudinaryUrl('https://res.cloudinary.com/demo/image/upload/v1/a.jpg', 'demo'));
  for (const bad of ['https://res.cloudinary.com/other/image/upload/a.jpg', 'http://res.cloudinary.com/demo/image/upload/a.jpg',
    'https://res.cloudinary.com.evil.test/demo/image/upload/a.jpg', 'https://res.cloudinary.com/demo/raw/upload/a.html', 'javascript:alert(1)']) {
    assert.equal(isOwnCloudinaryUrl(bad, 'demo'), false, bad);
  }
});

test('the public site serves Cloudinary photos resized and in modern formats', () => {
  assert.equal(
    cloudinaryImage('https://res.cloudinary.com/dkudoatww/image/upload/v1782263309/IMG_8769_zuqazu.jpg'),
    'https://res.cloudinary.com/dkudoatww/image/upload/f_auto,q_auto,c_limit,w_1600/v1782263309/IMG_8769_zuqazu.jpg',
  );
  const transformed = 'https://res.cloudinary.com/d/image/upload/w_300,c_fill/v1/a.jpg';
  assert.equal(cloudinaryImage(transformed), transformed);
  assert.equal(cloudinaryImage('https://res.cloudinary.com/d/video/upload/v1/a.mp4'), 'https://res.cloudinary.com/d/video/upload/v1/a.mp4');
});

test('event validation mirrors the site schema and keeps gallery order', () => {
  const urls = [3, 1, 2].map(n => `https://res.cloudinary.com/demo/image/upload/v1/p${n}.jpg`);
  const { slug, data } = validateEvent({
    slug: 'Navaratri-2026', title: ' Navarātri ', order: 1, status: 'upcoming', date: '2026-10-20',
    flyerImage: '/assets/flyer.png', gallery: urls.map(src => ({ src, alt: '' })),
  }, { cloudName: 'demo' });
  assert.equal(slug, 'navaratri-2026');
  assert.deepEqual(data.gallery.map(g => g.src), urls);
  const roundTrip = parseFrontmatter(stringifyFrontmatter(data)).data;
  assert.equal(roundTrip.date, '2026-10-20', 'date-like strings stay strings');
  assert.equal(roundTrip.title, 'Navarātri');

  const base = { slug: 'x', title: 'X', order: 1, status: 'past', date: 'd' };
  for (const flyerImage of ['https://evil.example/a.jpg', 'javascript:alert(1)', '/assets/../../etc/passwd', '//evil.example/a.jpg']) {
    assert.throws(() => validateEvent({ ...base, flyerImage }, { cloudName: 'demo' }), /Flyer image/, flyerImage);
  }
  for (const s of ['../x', 'a/b', '-x', 'x'.repeat(65)]) {
    assert.throws(() => validateEvent({ ...base, slug: s, flyerImage: '/assets/a.png' }, { cloudName: 'demo' }), /Identifier/, s);
  }
  assert.throws(() => validateEvent({ ...base, flyerImage: '/assets/a.png', videos: [{ source: 'upload', file: 'https://res.cloudinary.com/demo/video/upload/v1/a.mov' }] }, { cloudName: 'demo' }), /MP4 or WebM/);
});

test('configuration: production requires HTTPS, secrets and Google; uploads degrade gracefully', () => {
  const env = {
    PUBLIC_URL: 'https://admin.example.org', SESSION_SECRET: 's'.repeat(32), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GITHUB_TOKEN: 't',
  };
  const cfg = readConfig(env);
  assert.equal(cfg.google.redirectUri, 'https://admin.example.org/auth/google/callback');
  assert.equal(cfg.cloudinary.ready, false, 'missing Cloudinary keys disable uploads only');
  assert.throws(() => readConfig({ ...env, SESSION_SECRET: '' }), ConfigError);
  assert.throws(() => readConfig({ ...env, SESSION_SECRET: 'short' }), ConfigError);
  assert.throws(() => readConfig({ ...env, GITHUB_TOKEN: '' }), ConfigError);
  assert.throws(() => readConfig({ ...env, PUBLIC_URL: 'http://admin.example.org' }), ConfigError);
  assert.throws(() => readConfig({ ...env, GOOGLE_CLIENT_SECRET: '' }), ConfigError);
});

import { cloudinaryAsset, cloudinaryThumb } from '../admin/public/shared/cloudinary-url.mjs';

test('public IDs are read from delivery URLs, with or without transformations', () => {
  const base = 'https://res.cloudinary.com/demo';
  assert.deepEqual(cloudinaryAsset(`${base}/image/upload/v1782263309/IMG_8769_zuqazu.jpg`, 'demo'), { resourceType: 'image', publicId: 'IMG_8769_zuqazu' });
  assert.deepEqual(cloudinaryAsset(`${base}/image/upload/f_auto,q_auto/v1/sapta/events/eka/IMG_1.jpg`, 'demo'), { resourceType: 'image', publicId: 'sapta/events/eka/IMG_1' });
  assert.deepEqual(cloudinaryAsset(`${base}/video/upload/v1/sapta/events/eka/clip.mp4`, 'demo'), { resourceType: 'video', publicId: 'sapta/events/eka/clip' });
  assert.equal(cloudinaryAsset('https://res.cloudinary.com/other/image/upload/v1/a.jpg', 'demo'), null);
});

test('thumbnails are small Cloudinary renditions; videos get a still frame', () => {
  assert.equal(
    cloudinaryThumb('https://res.cloudinary.com/demo/image/upload/v1/a.jpg?x=1', { width: 120 }),
    'https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,w_120,h_120,f_auto,q_auto/v1/a.jpg',
  );
  assert.equal(
    cloudinaryThumb('https://res.cloudinary.com/demo/video/upload/v1/sapta/clip.mp4', { width: 400, height: 280 }),
    'https://res.cloudinary.com/demo/video/upload/so_1,c_fill,g_auto,w_400,h_280,q_auto/v1/sapta/clip.jpg',
  );
  assert.equal(cloudinaryThumb('/assets/eka_flyer.png'), '/assets/eka_flyer.png');
});

import { checkFormEmbed } from '../src/lib/media.mjs';

test('form embedding: only when Google will show the form to signed-out visitors', async () => {
  const embedOf = id => `https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`;
  const fetchImpl = async (url, init) => {
    if (url === 'https://forms.gle/short123') return new Response(null, { status: 302, headers: { location: 'https://docs.google.com/forms/d/e/1FAIpQLSopenform00/viewform?usp=send_form' } });
    if (url === embedOf('1FAIpQLSopenform00')) return new Response('<form>', { status: 200 });
    if (url === embedOf('1FAIpQLSsigninform')) return new Response('Sign in', { status: 401 });
    throw new Error('offline');
  };
  assert.deepEqual(await checkFormEmbed('https://forms.gle/short123', { fetchImpl, verify: true }), { embed: embedOf('1FAIpQLSopenform00'), reason: 'ok' });
  assert.deepEqual(await checkFormEmbed('https://docs.google.com/forms/d/e/1FAIpQLSsigninform/viewform', { fetchImpl, verify: true }), { embed: null, reason: 'needs-sign-in' });
  assert.equal((await checkFormEmbed('https://example.org/form', { fetchImpl, verify: true })).reason, 'not-supported');
  assert.equal((await checkFormEmbed('https://forms.gle/offline', { fetchImpl, verify: true })).reason, 'unreachable', 'network trouble means a button, never an error');
  assert.equal((await checkFormEmbed('https://docs.google.com/forms/d/e/1FAIpQLSdownnnnnn/viewform', { fetchImpl, verify: true })).reason, 'unreachable');
});
