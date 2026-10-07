// Reads and validates configuration from environment variables (Node
// process.env locally, Worker vars/secrets in production).
import crypto from 'node:crypto';

const MB = 1024 * 1024;
const CLOUD_NAME_RE = /^[a-z0-9_-]{1,64}$/i;

export class ConfigError extends Error {}

function list(value, fallback) {
  return String(value || fallback).split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param env      key/value environment
 * @param defaults runtime defaults, e.g. { store: 'fs', publicUrl: 'http://localhost:4322' }
 */
export function readConfig(env, defaults = {}) {
  const problems = [];
  const store = (env.CONTENT_STORE || defaults.store || 'github').toLowerCase();
  if (!['github', 'fs'].includes(store)) problems.push('CONTENT_STORE must be "github" or "fs".');

  const publicUrl = String(env.PUBLIC_URL || defaults.publicUrl || '').replace(/\/+$/, '');
  let origin = '';
  try {
    const u = new URL(publicUrl);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) problems.push('PUBLIC_URL must use https://.');
    origin = u.origin;
  } catch {
    problems.push('PUBLIC_URL must be the full address of the admin, e.g. https://sapta-admin.example.workers.dev');
  }
  const secure = origin.startsWith('https:');

  // Sessions are signed cookies. Production needs a fixed secret so sessions
  // survive restarts; locally a random one per run is fine.
  let sessionSecret = env.SESSION_SECRET || '';
  if (!sessionSecret) {
    if (secure) problems.push('SESSION_SECRET is required (at least 32 random characters).');
    else sessionSecret = crypto.randomBytes(32).toString('hex');
  } else if (sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters.');
  }

  const google = {
    clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
    allowedEmails: new Set(list(env.ADMIN_GOOGLE_EMAILS, 'artssapta@gmail.com')),
    redirectUri: `${origin}/auth/google/callback`,
  };
  if (!google.clientId || !google.clientSecret) problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.');

  const github = {
    token: (env.GITHUB_TOKEN || '').trim(),
    repo: (env.GITHUB_REPO || 'artssapta/sapta').trim(),
    branch: (env.GITHUB_BRANCH || 'main').trim(),
    // Saves go here first; "" turns drafts off (saves publish immediately).
    draftBranch: (env.GITHUB_DRAFT_BRANCH ?? 'drafts').trim(),
  };
  if (store === 'github') {
    if (!github.token) problems.push('GITHUB_TOKEN is required when CONTENT_STORE is "github".');
    if (!/^[\w.-]+\/[\w.-]+$/.test(github.repo)) problems.push('GITHUB_REPO must look like "owner/repo".');
    if (github.draftBranch && !/^[\w./-]+$/.test(github.draftBranch)) problems.push('GITHUB_DRAFT_BRANCH has invalid characters.');
  }

  if (problems.length) throw new ConfigError(problems.join('\n'));

  // Cloudinary problems do not stop the server: editing still works, uploads
  // are disabled and the Status tab explains why.
  const cloudinary = {
    cloudName: (env.CLOUDINARY_CLOUD_NAME || '').trim(),
    apiKey: (env.CLOUDINARY_API_KEY || '').trim(),
    apiSecret: (env.CLOUDINARY_API_SECRET || '').trim(),
    folder: (env.CLOUDINARY_FOLDER || 'sapta').trim().replace(/^\/+|\/+$/g, ''),
    problems: [],
  };
  if (!CLOUD_NAME_RE.test(cloudinary.cloudName)) cloudinary.problems.push('CLOUDINARY_CLOUD_NAME is missing or invalid.');
  if (!cloudinary.apiKey || !cloudinary.apiSecret) cloudinary.problems.push('CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not set.');
  if (!/^[\w-]+(\/[\w-]+)*$/.test(cloudinary.folder)) cloudinary.problems.push('CLOUDINARY_FOLDER may only contain letters, numbers, "-", "_" and "/".');
  cloudinary.ready = cloudinary.problems.length === 0;

  return {
    store,
    origin,
    secure,
    sessionSecret,
    google,
    github,
    cloudinary,
    // Site built from the drafts (Cloudflare Pages), shown as "Preview".
    previewUrl: String(env.PREVIEW_URL || '').replace(/\/+$/, ''),
    // Public website, used to preview /assets/... images from the admin.
    siteUrl: String(env.SITE_URL ?? defaults.siteUrl ?? 'https://saptaarts.org').replace(/\/+$/, ''),
    // Defaults match Cloudinary's free plan; raise them if the plan allows.
    limits: {
      photo: Number(env.MAX_PHOTO_MB || 10) * MB,
      video: Number(env.MAX_VIDEO_MB || 100) * MB,
    },
  };
}
