import test from 'node:test';
import assert from 'node:assert/strict';
import { videoSource, registrationLink } from '../src/lib/media.mjs';

test('YouTube watch, share, shorts, live and embed links use the same player', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=F1VUwJJcerk&feature=share',
    'https://youtu.be/F1VUwJJcerk?si=abc',
    'https://youtube.com/shorts/F1VUwJJcerk',
    'https://youtube.com/live/F1VUwJJcerk',
    'https://www.youtube-nocookie.com/embed/F1VUwJJcerk',
  ]) assert.deepEqual(videoSource(url), {kind:'youtube',src:'https://www.youtube-nocookie.com/embed/F1VUwJJcerk'});
});

test('Uploaded clips preserve their URL and get the correct browser media type', () => {
  assert.deepEqual(videoSource('/uploads/videos/concert.MP4'), {kind:'file',src:'/uploads/videos/concert.MP4',type:'video/mp4'});
  assert.equal(videoSource('/uploads/videos/concert.webm').type, 'video/webm');
  assert.equal(videoSource('https://cdn.example.org/video.mp4?v=2').kind, 'file');
});

test('Unsafe and unsupported player links are rejected', () => {
  for (const value of ['', null, 'javascript:alert(1)', '//evil.test/video.mp4', 'https://youtube.com.evil.test/watch?v=F1VUwJJcerk', 'https://youtube.com/watch?v=bad', '/uploads/videos/video.mov', 'http://youtu.be/F1VUwJJcerk']) {
    assert.equal(videoSource(value), null, String(value));
  }
});

test('Registration allows HTTPS links and rejects executable, relative and credential-bearing URLs', () => {
  assert.equal(registrationLink('https://forms.gle/newForm'), 'https://forms.gle/newForm');
  for (const value of ['', undefined, '/registration/group', 'javascript:alert(1)', 'http://example.org', 'https://user:pass@example.org/form']) assert.equal(registrationLink(value), null);
});
