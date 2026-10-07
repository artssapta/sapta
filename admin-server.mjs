// Local SAPTA admin: `npm run admin` → http://localhost:4322
//
// Runs the same application as the hosted admin (admin/worker.mjs). By default
// it edits the files in this checkout (CONTENT_STORE=fs); set
// CONTENT_STORE=github to save straight to GitHub like the hosted version.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './admin/lib/env.mjs';
import { readConfig, ConfigError } from './admin/core/config.mjs';
import { createApp } from './admin/core/app.mjs';
import { createFsStore } from './admin/core/stores/fs.mjs';
import { createGitHubStore } from './admin/core/stores/github.mjs';
import { createPreviewTrigger } from './admin/core/preview.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_UI = path.join(ROOT, 'admin', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

async function fileResponse(baseDir, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const full = path.resolve(baseDir, `.${decoded}`);
  const type = TYPES[path.extname(full).toLowerCase()];
  if (!type || decoded.includes('\0') || !full.startsWith(baseDir + path.sep)) return null;
  try {
    if (!(await fsp.stat(full)).isFile()) return null;
  } catch {
    return null;
  }
  return new Response(Readable.toWeb(fs.createReadStream(full)), { headers: { 'Content-Type': type } });
}

/** Builds the Node HTTP server around the shared app. Exported for tests. */
export function createAdminServer({ env = process.env, port = 4322, fetchImpl = fetch, rootDir = ROOT } = {}) {
  const config = readConfig(env, { store: 'fs', publicUrl: `http://localhost:${port}`, siteUrl: '' });
  const preview = createPreviewTrigger(config.previewDeployHook, { fetchImpl });
  const store = config.store === 'github'
    ? createGitHubStore(config.github, { fetchImpl, onDraftsChanged: preview.markChanged })
    : createFsStore(rootDir);
  const handle = createApp({ config, store, fetchImpl, assets: p => fileResponse(PUBLIC_UI, p) });
  const siteDir = path.join(rootDir, 'public');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let response;
      // Locally there is no public website to preview images from, so serve
      // the repository's own images (only when SITE_URL is not set).
      if (!config.siteUrl && /^\/(assets|uploads)\//.test(url.pathname) && req.method === 'GET') {
        response = (await fileResponse(siteDir, url.pathname)) || new Response('Not found', { status: 404 });
        response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
        response.headers.set('X-Content-Type-Options', 'nosniff');
      } else {
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        response = await handle(new Request(url, {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]])),
          body: hasBody ? Readable.toWeb(req) : undefined,
          duplex: hasBody ? 'half' : undefined,
        }));
      }
      const headers = {};
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') headers[key] = value; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body).pipe(res);
      else res.end();
      preview.flush();
    } catch (err) {
      console.error('[admin] request failed:', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    }
  });
  server.config = config;
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnvFile(path.join(ROOT, '.env'));
  const port = Number(process.env.ADMIN_PORT || 4322);
  let server;
  try {
    server = createAdminServer({ port });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`\n✖ The admin is not configured:\n  ${err.message.split('\n').join('\n  ')}\n\nSee README → "Hosted admin".\n`);
    process.exit(1);
  }
  const { config } = server;
  server.listen(port, '127.0.0.1', () => {
    console.log('SAPTA admin (local)');
    console.log(`  URL:        http://localhost:${port}/`);
    console.log(`  Login:      Google (${[...config.google.allowedEmails].join(', ')})`);
    console.log(`  Saves to:   ${config.store === 'github' ? `GitHub ${config.github.repo}@${config.github.branch} (publishes the site)` : 'local files (commit and push to publish)'}`);
    console.log(`  Cloudinary: ${config.cloudinary.ready ? `${config.cloudinary.cloudName} (signed uploads)` : `uploads disabled — ${config.cloudinary.problems.join(' ')}`}`);
  });
}
