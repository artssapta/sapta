// Cloudflare Worker entry point for the hosted SAPTA admin.
// Configuration: wrangler.jsonc (vars) + `wrangler secret put` (secrets).
import { readConfig, ConfigError } from './core/config.mjs';
import { createApp } from './core/app.mjs';
import { createGitHubStore } from './core/stores/github.mjs';

let cached; // { env, origin, handle } — built once per isolate

// Without PUBLIC_URL the Worker's own address is used; on workers.dev the
// host name is what routed the request here, so it can be trusted.
function build(env, origin) {
  const config = readConfig(env, { store: 'github', publicUrl: origin });
  return createApp({
    config,
    store: createGitHubStore(config.github),
    assets: path => env.ASSETS.fetch(new Request(`https://assets.local${path}`)),
  });
}

export default {
  async fetch(request, env) {
    const origin = new URL(request.url).origin;
    if (!cached || cached.env !== env || (!env.PUBLIC_URL && cached.origin !== origin)) {
      try {
        cached = { env, origin, handle: build(env, origin) };
      } catch (err) {
        cached = undefined;
        if (err instanceof ConfigError) {
          console.error(`[admin] configuration problem:\n${err.message}`);
          return new Response(`The admin is not configured correctly:\n\n${err.message}\n\nSee README → "Hosted admin".`, {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        throw err;
      }
    }
    return cached.handle(request);
  },
};
