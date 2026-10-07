// Records which commit this build came from. The admin compares it with the
// latest draft to show whether the preview site is up to date.
export function GET() {
  return new Response(JSON.stringify({
    commit: process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || null,
    branch: process.env.CF_PAGES_BRANCH || process.env.GITHUB_REF_NAME || null,
    builtAt: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } });
}
