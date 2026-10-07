// Rebuilds the preview site after the drafts change, via a Cloudflare Pages
// deploy hook. Changes made while handling one request (e.g. catching the
// drafts up with the live site, then saving) trigger a single build, sent
// after the response so it never slows the editor down.
export function createPreviewTrigger(hookUrl, { fetchImpl = fetch } = {}) {
  let dirty = false;
  return {
    /** Pass to the store as onDraftsChanged. */
    markChanged() {
      dirty = true;
    },
    /** Call after each request; returns a promise to hand to waitUntil (or ignore). */
    flush() {
      if (!dirty || !hookUrl) return Promise.resolve();
      dirty = false;
      return fetchImpl(hookUrl, { method: 'POST', signal: AbortSignal.timeout(10_000) })
        .then(response => {
          if (response.ok) console.log('[preview] rebuild requested');
          else console.warn(`[preview] deploy hook returned HTTP ${response.status}`);
        })
        .catch(err => console.warn(`[preview] deploy hook failed: ${err.message}`));
    },
  };
}
