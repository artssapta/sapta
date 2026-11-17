// Event and registration content: validation, parsing and serialisation.
// Pure functions (no storage). Validation mirrors src/content.config.ts so that
// anything the admin saves also passes the website build.
import yaml from 'js-yaml';
import { videoSource, registrationLink } from '../../src/lib/media.mjs';
import { isOwnCloudinaryUrl } from '../public/shared/cloudinary-url.mjs';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const REGISTRATION_IDS = ['group', 'spotlight'];
export const EVENTS_DIR = 'src/content/events';
export const REGISTRATIONS_DIR = 'src/content/registrations';

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data = yaml.load(match[1], { schema: yaml.CORE_SCHEMA }) || {};
  return { data, body: match[2].trim() };
}

export function stringifyFrontmatter(data, body = '') {
  // Default schema on dump so strings that look like dates/booleans get quoted
  // and Astro reads them back as strings.
  const front = yaml.dump(data, { lineWidth: -1, noRefs: true });
  return body ? `---\n${front}---\n\n${body}\n` : `---\n${front}---\n`;
}

export const eventPath = slug => {
  if (!SLUG_RE.test(slug)) throw new ValidationError('Invalid event identifier.');
  return `${EVENTS_DIR}/${slug}.md`;
};

export const registrationPath = id => {
  if (!REGISTRATION_IDS.includes(id)) throw new ValidationError('Unknown registration form.', 404);
  return `${REGISTRATIONS_DIR}/${id}.md`;
};

function text(value, { field, max, required = false }) {
  if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${field} must be text.`);
  }
  const result = String(value ?? '').trim();
  if (required && !result) throw new ValidationError(`${field} is required.`);
  if (result.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`);
  return result;
}

/**
 * Photos must be hosted on this site's Cloudinary account or be a file already
 * in the repository (/assets/... or /uploads/...).
 */
export function validateMediaPath(value, { field, cloudName }) {
  if (isOwnCloudinaryUrl(value, cloudName)) return value;
  if (/^\/(assets|uploads)\/[\w\-./ ]+$/.test(value) && !value.split('/').includes('..') && !value.includes('//')) return value;
  throw new ValidationError(`${field} must be a Cloudinary URL from the "${cloudName}" account or a site path starting with /assets/ or /uploads/.`);
}

export function normalizeSlug(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateEvent(body, { cloudName }) {
  if (!body || typeof body !== 'object') throw new ValidationError('Invalid request body.');
  const slug = normalizeSlug(body.slug);
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('Identifier must be 1–64 lowercase letters, numbers or hyphens, starting and ending with a letter or number.');
  }

  const order = Number(body.order);
  if (!Number.isInteger(order) || order < 1 || order > 9999) throw new ValidationError('Display order must be a whole number of 1 or more.');
  if (!['upcoming', 'past'].includes(body.status)) throw new ValidationError('Status must be "upcoming" or "past".');

  const flyerImage = validateMediaPath(text(body.flyerImage, { field: 'Flyer image', max: 2048, required: true }), { field: 'Flyer image', cloudName });

  const rawGallery = body.gallery ?? [];
  if (!Array.isArray(rawGallery) || rawGallery.length > 500) throw new ValidationError('Gallery must be a list of at most 500 photos.');
  const gallery = rawGallery.map((item, i) => {
    const field = `Gallery photo ${i + 1}`;
    if (!item || typeof item !== 'object') throw new ValidationError(`${field} is invalid.`);
    return {
      src: validateMediaPath(text(item.src, { field, max: 2048, required: true }), { field, cloudName }),
      alt: text(item.alt, { field: `${field} description`, max: 300 }),
    };
  });

  const rawVideos = body.videos ?? [];
  if (!Array.isArray(rawVideos) || rawVideos.length > 100) throw new ValidationError('Videos must be a list of at most 100 entries.');
  const videos = rawVideos.map((item, i) => {
    const field = `Video ${i + 1}`;
    if (!item || typeof item !== 'object') throw new ValidationError(`${field} is invalid.`);
    const source = item.source === 'upload' ? 'upload' : 'youtube';
    const title = text(item.title, { field: `${field} title`, max: 200 });
    if (source === 'upload') {
      const file = text(item.file, { field, max: 2048, required: true });
      validateMediaPath(file, { field, cloudName });
      if (videoSource(file)?.kind !== 'file') throw new ValidationError(`${field} must be an MP4 or WebM file.`);
      return { title, source, file };
    }
    const videoUrl = text(item.videoUrl, { field, max: 2048, required: true });
    if (videoSource(videoUrl)?.kind !== 'youtube') throw new ValidationError(`${field} must be a valid https:// YouTube link.`);
    return { title, source, videoUrl };
  });

  const data = {
    title: text(body.title, { field: 'Title', max: 200, required: true }),
    order,
    status: body.status,
    subtitle: text(body.subtitle, { field: 'Subtitle', max: 300 }),
    date: text(body.date, { field: 'Date', max: 100, required: true }),
    time: text(body.time, { field: 'Time', max: 100 }),
    location: text(body.location, { field: 'Venue', max: 300 }),
    description: text(body.description, { field: 'Description', max: 5000 }),
    flyerImage,
  };
  if (gallery.length) data.gallery = gallery;
  if (videos.length) data.videos = videos;
  return { slug, data };
}

export function validateRegistration(id, body) {
  if (!REGISTRATION_IDS.includes(id)) throw new ValidationError('Unknown registration form.', 404);
  if (!body || typeof body !== 'object') throw new ValidationError('Invalid request body.');
  const status = body.status === 'open' ? 'open' : 'coming-soon';
  const url = text(body.url, { field: 'Form link', max: 2048 });
  if (url && !registrationLink(url)) throw new ValidationError('Form link must be a complete https:// URL.');
  if (status === 'open' && !url) throw new ValidationError('To open registration, paste the form link (https://…) first.');
  const fields = {
    status,
    // Required while coming soon. While open it is hidden, so an empty one
    // gets a neutral default (the site schema needs a value).
    message: text(body.message, { field: 'Message while coming soon', max: 2000, required: status !== 'open' }) || 'Registration will open soon.',
    url,
  };
  const openMessage = text(body.openMessage, { field: 'Message when open', max: 2000 });
  if (openMessage) fields.openMessage = openMessage;
  return fields;
}

/** Normalises a stored event file for the editor. */
export function eventFromFile(slug, text) {
  const { data } = parseFrontmatter(text);
  return {
    slug,
    title: String(data.title ?? slug),
    order: Number(data.order) || 99,
    status: data.status === 'upcoming' ? 'upcoming' : 'past',
    subtitle: String(data.subtitle ?? ''),
    date: String(data.date ?? ''),
    time: String(data.time ?? ''),
    location: String(data.location ?? ''),
    description: String(data.description ?? ''),
    flyerImage: String(data.flyerImage ?? ''),
    gallery: Array.isArray(data.gallery) ? data.gallery.filter(g => g && g.src).map(g => ({ src: String(g.src), alt: String(g.alt ?? '') })) : [],
    videos: Array.isArray(data.videos) ? data.videos.filter(Boolean).map(v => ({
      title: String(v.title ?? ''), source: v.source === 'upload' ? 'upload' : 'youtube',
      file: String(v.file ?? ''), videoUrl: String(v.videoUrl ?? ''),
    })) : [],
  };
}

export function registrationFromFile(id, text) {
  const { data } = parseFrontmatter(text);
  return {
    id,
    title: String(data.title ?? id),
    status: data.status === 'open' ? 'open' : 'coming-soon',
    message: String(data.message ?? ''),
    openMessage: String(data.openMessage ?? ''),
    url: String(data.url ?? ''),
  };
}

// ---------- homepage and team ----------

export const HOME_PATH = 'src/content/pages/home.md';
export const TEAM_DIR = 'src/content/team';
export const HOME_SECTIONS = ['hero', 'about', 'team'];

export const teamPath = id => {
  if (!SLUG_RE.test(String(id))) throw new ValidationError('Invalid team member.');
  return `${TEAM_DIR}/${id}.md`;
};

const blockOf = (data, type) => (Array.isArray(data.blocks) ? data.blocks : []).find(b => b && b.type === type);

/** The editable parts of home.md. */
export function homeFromFile(raw) {
  const { data } = parseFrontmatter(raw);
  const hero = blockOf(data, 'hero') || {};
  const about = blockOf(data, 'about') || {};
  const team = blockOf(data, 'team-grid') || {};
  return {
    hero: { title: String(hero.title ?? ''), subtitle: String(hero.subtitle ?? ''), image: String(hero.image ?? '') },
    about: { title: String(about.title ?? ''), text: String(about.text ?? ''), image: String(about.image ?? ''), imageSide: about.imageSide === 'left' ? 'left' : 'right' },
    team: { title: String(team.title ?? '') },
    hasHero: Boolean(blockOf(data, 'hero')),
    hasAbout: Boolean(blockOf(data, 'about')),
    hasTeam: Boolean(blockOf(data, 'team-grid')),
  };
}

/**
 * Applies one section's edits to home.md and returns the new file. Everything
 * else in the file (other sections, colours, buttons) is kept as it is.
 */
export function applyHomeEdit(raw, section, fields, { cloudName }) {
  if (!HOME_SECTIONS.includes(section)) throw new ValidationError('Unknown homepage section.');
  if (!fields || typeof fields !== 'object') throw new ValidationError('Invalid request body.');
  const { data } = parseFrontmatter(raw);
  const type = section === 'team' ? 'team-grid' : section;
  const block = blockOf(data, type);
  if (!block) throw new ValidationError(`The homepage has no ${section} section.`, 404);

  if (section === 'hero') {
    block.title = text(fields.title, { field: 'Banner title', max: 100, required: true });
    const subtitle = text(fields.subtitle, { field: 'Banner subtitle', max: 300 });
    if (subtitle) block.subtitle = subtitle; else delete block.subtitle;
    const image = text(fields.image, { field: 'Banner picture', max: 2048 });
    if (image) block.image = validateMediaPath(image, { field: 'Banner picture', cloudName }); else delete block.image;
  } else if (section === 'about') {
    block.title = text(fields.title, { field: 'About heading', max: 200, required: true });
    block.text = text(fields.text, { field: 'About text', max: 5000, required: true });
    block.image = validateMediaPath(text(fields.image, { field: 'About picture', max: 2048, required: true }), { field: 'About picture', cloudName });
    if (!['left', 'right'].includes(fields.imageSide)) throw new ValidationError('Picture side must be left or right.');
    block.imageSide = fields.imageSide;
  } else {
    const title = text(fields.title, { field: 'Team heading', max: 200 });
    if (title) block.title = title; else delete block.title;
  }
  return stringifyFrontmatter(data);
}

export function teamFromFile(id, raw) {
  const { data, body } = parseFrontmatter(raw);
  return {
    id,
    name: String(data.name ?? id),
    role: String(data.role ?? ''),
    photo: String(data.photo ?? ''),
    order: Number(data.order) || 99,
    bio: body,
  };
}

/** A team member file: name, role, photo and order up top, the bio as the body. */
export function validateTeamMember(body, { cloudName, order }) {
  if (!body || typeof body !== 'object') throw new ValidationError('Invalid request body.');
  const data = {
    name: text(body.name, { field: 'Name', max: 100, required: true }),
    role: text(body.role, { field: 'Role', max: 100 }),
    photo: validateMediaPath(text(body.photo, { field: 'Photo', max: 2048, required: true }), { field: 'Photo', cloudName }),
    order,
  };
  const bio = text(body.bio, { field: 'Bio', max: 3000 });
  return { data, bio };
}

/** A file name for a new team member, e.g. "Priya Raman" → "priya-raman". */
export function teamIdFor(name, taken) {
  const base = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'member';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
