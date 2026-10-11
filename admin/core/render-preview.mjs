// Instant previews: renders the Events and Registration sections exactly as
// src/components/blocks/Events.astro and src/components/Registration.astro do,
// so drafts can be shown inside the real site's page in about a second instead
// of waiting for a full site build.
//
// KEEP IN SYNC with those components. tests/preview-parity.test.mjs builds the
// real site and fails if this output differs from Astro's.
import { videoSource, registrationLink } from '../../src/lib/media.mjs';
import { responsiveImage, optimizedUrl } from '../../src/lib/images.mjs';

// Astro's text/attribute escaping.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Minimal element builder that mirrors Astro's output: attributes in order,
 * null/false omitted, `true` as a bare attribute, and the component's scoped
 * style attribute (data-astro-cid-…) added to every element.
 */
function makeH(cid) {
  const scope = cid ? ` ${cid}` : '';
  const attrs = list => Object.entries(list)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join('');
  const h = (tag, list = {}, ...children) => `<${tag}${attrs(list)}${scope}>${children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false).join('')}</${tag}>`;
  h.void = (tag, list = {}) => `<${tag}${attrs(list)}${scope}>`;
  h.text = esc;
  return h;
}

const resolvePath = p => p;
// Same sizes as Events.astro.
const FLYER_SIZES = '(max-width: 960px) 92vw, 440px';
const PHOTO_SIZES = '(max-width: 600px) 46vw, (max-width: 960px) 30vw, 240px';
const imgAttrs = (src, sizes) => {
  const im = responsiveImage(src, { sizes });
  return { src: im.src, srcset: im.srcset, sizes: im.sizes, width: im.width, height: im.height };
};

const ICONS = {
  date: h => h('svg', { class: 'meta-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('rect', { x: '3', y: '4', width: '18', height: '18', rx: '2', ry: '2' }),
    h('line', { x1: '16', y1: '2', x2: '16', y2: '6' }),
    h('line', { x1: '8', y1: '2', x2: '8', y2: '6' }),
    h('line', { x1: '3', y1: '10', x2: '21', y2: '10' })),
  time: h => h('svg', { class: 'meta-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('circle', { cx: '12', cy: '12', r: '10' }),
    h('polyline', { points: '12 6 12 12 16 14' })),
  venue: h => h('svg', { class: 'meta-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z' }),
    h('circle', { cx: '12', cy: '10', r: '3' })),
};

function metadata(h, event) {
  const item = (icon, label, value) => h('div', { class: 'meta-item' },
    h('div', { class: 'icon-wrapper' }, ICONS[icon](h)),
    h('div', { class: 'meta-text' },
      h('span', { class: 'meta-label' }, label),
      h('span', { class: 'meta-val' }, h.text(value))));
  return h('div', { class: 'event-metadata' },
    item('date', 'Date', event.date),
    event.time && item('time', 'Time', event.time),
    event.location && item('venue', 'Venue', event.location));
}

function upcomingPanel(h, event) {
  return h('div', { class: 'upcoming-event-card' },
    h('div', { class: 'upcoming-card-grid' },
      h('div', { class: 'upcoming-flyer-box' },
        h.void('img', { ...imgAttrs(event.flyerImage, FLYER_SIZES), alt: `${event.title} Flyer`, class: 'upcoming-flyer-img', decoding: 'async', 'data-full': optimizedUrl(event.flyerImage) })),
      h('div', { class: 'upcoming-details-box' },
        h('div', { class: 'upcoming-badge-row' },
          h('span', { class: 'upcoming-badge-tag' }, h('span', { class: 'pulse-dot' }), ' Upcoming Event')),
        h('h2', { class: 'upcoming-event-name' }, h.text(event.title)),
        event.subtitle && h('p', { class: 'upcoming-event-subtitle' }, h.text(event.subtitle)),
        metadata(h, event),
        event.description && h('div', { class: 'event-description upcoming-desc' }, h('p', {}, h.text(event.description))))));
}

function videoCard(h, event, vid) {
  const source = videoSource(vid.source === 'upload' ? vid.file : vid.videoUrl);
  if (!source) return null;
  if (source.kind === 'file') {
    return h('div', { class: 'video-card' },
      h('div', { class: 'video-wrapper' },
        h('video', { controls: true, playsinline: true, preload: 'metadata', class: 'local-video', 'aria-label': vid.title || `${event.title} performance` },
          h.void('source', { src: resolvePath(source.src), type: source.type }),
          ' Your browser does not support the video tag. ')),
      vid.title && h('p', { class: 'video-caption' }, h.text(vid.title)));
  }
  return h('div', { class: 'video-card' },
    h('div', { class: 'iframe-wrapper' },
      h('iframe', { src: source.src, loading: 'lazy', title: vid.title || 'YouTube video player', allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture', allowfullscreen: true })),
    vid.title && h('p', { class: 'video-caption' }, h.text(vid.title)));
}

function archivePanel(h, event) {
  const hasMedia = event.videos?.length || event.gallery?.length;
  return h('div', { class: `event-main-grid ${hasMedia ? 'has-media' : 'no-media'}` },
    h('div', { class: 'event-info-col' },
      h('div', { class: 'details-text-card' },
        h('div', { class: 'title-status-row' },
          h('h3', { class: 'event-title' }, h.text(event.title)),
          h('span', { class: `status-pill ${event.status}` }, event.status === 'upcoming' ? 'Upcoming Event' : 'Past Event')),
        event.subtitle && h('p', { class: 'event-subtitle' }, h.text(event.subtitle)),
        metadata(h, event),
        event.description && h('div', { class: 'event-description' }, h('p', {}, h.text(event.description)))),
      h('div', { class: 'flyer-card' },
        h('div', { class: 'flyer-card-inner' },
          h.void('img', { ...imgAttrs(event.flyerImage, FLYER_SIZES), alt: `${event.title} Flyer`, loading: 'lazy', decoding: 'async', 'data-full': optimizedUrl(event.flyerImage) })))),
    h('div', { class: 'event-media-col' },
      event.videos?.length > 0 && h('div', { class: 'event-videos-section' },
        h('h3', { class: 'media-title' }, event.status === 'upcoming' ? 'Event videos' : 'Relive the Moment'),
        h('div', { class: 'videos-grid' }, event.videos.map(vid => videoCard(h, event, vid)))),
      event.gallery?.length > 0 && h('div', { class: 'event-gallery-section' },
        h('h3', { class: 'media-title' }, 'Event Gallery'),
        h('div', { class: 'photo-grid-scroll' },
          h('div', { class: 'photo-grid' }, event.gallery.map(img =>
            h('div', { class: 'photo-card' },
              h('div', { class: 'photo-card-inner' },
                h.void('img', { ...imgAttrs(img.src, PHOTO_SIZES), alt: img.alt || `${event.title} event photo`, loading: 'lazy', decoding: 'async', 'data-full': optimizedUrl(img.src) })))))))));
}

/** The whole <section class="events-section">…</section>, as Events.astro renders it. */
export function renderEventsSection(events, { title, color = '#316fa6', cid } = {}) {
  const h = makeH(cid);
  const sorted = [...events].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return h('section', { class: 'events-section' },
    h('div', { class: 'events-hero', style: `background-image: url(${optimizedUrl('/assets/hero_music_banner.png')}); background-color: ${color};` },
      h('div', { class: 'events-hero-overlay' }),
      h('div', { class: 'events-hero-content' }, h('h1', {}, h.text(title || 'Events')))),
    sorted.length > 0 && h('div', { class: 'events-nav-container' },
      h('div', { class: 'events-tabs-nav' }, sorted.map((event, index) =>
        h('button', { class: `event-tab-btn ${event.status === 'upcoming' ? 'upcoming-tab' : 'past-tab'} ${index === 0 ? 'active' : ''}`, 'data-event-id': event.id },
          event.status === 'upcoming' && h('span', { class: 'pulse-dot' }),
          h('span', { class: 'tab-title-text' }, h.text(event.title)),
          h('span', { class: `tab-badge ${event.status === 'upcoming' ? 'badge-upcoming' : 'badge-past'}` }, event.status === 'upcoming' ? 'Upcoming' : 'Past'))))),
    h('div', { class: 'container' }, sorted.map((event, index) =>
      h('div', { id: `panel-${event.id}`, class: `event-panel ${index === 0 ? 'active' : ''}` },
        event.status === 'upcoming' && !event.gallery?.length && !event.videos?.length ? upcomingPanel(h, event) : archivePanel(h, event)))),
    h('div', { id: 'lightbox-modal', class: 'lightbox-modal' },
      h('span', { class: 'lightbox-close' }, '&times;'),
      h('div', { class: 'lightbox-box' },
        h('button', { class: 'lightbox-prev', 'aria-label': 'Previous image' }, '&#10094;'),
        h.void('img', { class: 'lightbox-content', id: 'lightbox-img', src: '', alt: 'Enlarged view' }),
        h('button', { class: 'lightbox-next', 'aria-label': 'Next image' }, '&#10095;'))));
}

/**
 * <section class="registration">…</section>, as Registration.astro renders it.
 * `embed` is the result of resolveFormEmbed(url) (resolved by the caller,
 * because it may need a network lookup).
 */
export function renderRegistrationSection({ title, status, message, openMessage, url }, { cid, embed = null, signIn = false } = {}) {
  const h = makeH(cid);
  const link = registrationLink(url);
  const isOpen = status === 'open' && link;
  if (!isOpen) embed = null;
  const visitorMessage = isOpen
    ? (openMessage || (embed ? 'Registration is open! Fill in the form below.' : 'Registration is open! Use the button below to open the form.'))
    : message;
  return h('section', { class: 'registration', 'aria-labelledby': 'registration-title' },
    h('p', { class: 'eyebrow' }, 'Perform with SAPTA'),
    h('h1', { id: 'registration-title' }, h.text(title)),
    h('div', { class: 'notice' },
      h('p', { class: 'status' }, isOpen ? 'Registration is open' : 'Coming soon'),
      h('p', { class: 'message' }, h.text(visitorMessage)),
      !isOpen && h('p', { class: 'note' }, 'The new registration link will appear on this page when it’s ready.'),
      isOpen && !embed && h('a', { class: 'action', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open registration form ', h('span', { 'aria-hidden': 'true' }, '↗')),
      isOpen && !embed && h('p', { class: 'note' }, 'The form opens in a new tab.')),
    embed && h('div', { class: 'form-embed' },
      signIn && h('p', { class: 'note sign-in-note' }, 'This form asks you to sign in with Google. If signing in doesn’t work here, ',
        h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'open the form in a new tab ', h('span', { 'aria-hidden': 'true' }, '↗'))),
      h('iframe', { src: embed, title: `${title} form`, loading: 'lazy' }, 'Loading the registration form…'),
      h('p', { class: 'note' }, 'Can’t see the form? ',
        h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open it in a new tab ', h('span', { 'aria-hidden': 'true' }, '↗')))),
    h('div', { class: 'links' },
      h('a', { href: '/events/' }, 'Explore our events ', h('span', { 'aria-hidden': 'true' }, '→')),
      h('a', { href: 'mailto:artssapta@gmail.com' }, 'Contact us')));
}

/**
 * For comparing with Astro's output: collapses whitespace and drops spaces
 * next to tags (they never change how the page looks), keeping every tag,
 * attribute and word.
 */
export function normalizeHtml(html) {
  return html.replace(/\s+/g, ' ').replace(/\s*(<[^>]+>)\s*/g, '$1').trim();
}
