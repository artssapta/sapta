// Only produce URLs that are safe to put in a player or public link.
export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function videoSource(value) {
  if (!value) return null;
  const local = value.startsWith('/') && !value.startsWith('//');
  const url = local ? new URL(value, 'https://local.invalid') : httpsUrl(value);
  if (!url) return null;
  if (/\.(mp4|webm)$/i.test(url.pathname)) {
    return { kind: 'file', src: value, type: /\.webm$/i.test(url.pathname) ? 'video/webm' : 'video/mp4' };
  }
  let id;
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:embed|shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : null;
  }
  return id && /^[\w-]{11}$/.test(id)
    ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}` }
    : null;
}

// Serve Cloudinary photos in the browser's best format (WebP/AVIF), at a
// sensible quality, and no wider than `width`. Other URLs pass through
// unchanged, as do Cloudinary URLs that already carry a transformation.
export function cloudinaryImage(value, width = 1600) {
  const url = httpsUrl(value);
  if (!url || url.hostname !== 'res.cloudinary.com') return value;
  const match = url.pathname.match(/^(\/[^/]+\/image\/upload\/)(.+)$/);
  if (!match) return value;
  const [, prefix, rest] = match;
  const first = rest.split('/')[0];
  const hasTransformation = rest.includes('/') && !/^v\d+$/.test(first) && /(^|,)[a-z]{1,3}_[^/]+$/.test(first);
  if (hasTransformation) return value;
  url.pathname = `${prefix}f_auto,q_auto,c_limit,w_${Math.round(width)}/${rest}`;
  return url.href;
}

/**
 * The officially embeddable address of a registration form, or null when the
 * link cannot be embedded (the page then shows a button instead).
 *  - Google Forms: any docs.google.com/forms/d/… link (viewform, edit,
 *    prefill…) becomes …/viewform?embedded=true; prefilled answers are kept.
 *  - Microsoft Forms: ResponsePage links get &embed=true.
 * Short forms.gle links need a network lookup: see resolveFormEmbed().
 */
export function formEmbedUrl(value) {
  const url = httpsUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'docs.google.com') {
    const match = url.pathname.match(/^\/forms\/(?:u\/\d+\/)?d\/(e\/)?([\w-]{10,})(?:\/|$)/);
    if (!match) return null;
    const embed = new URL(`https://docs.google.com/forms/d/${match[1] || ''}${match[2]}/viewform`);
    for (const [key, val] of url.searchParams) if (key.startsWith('entry.')) embed.searchParams.append(key, val);
    embed.searchParams.set('embedded', 'true');
    return embed.href;
  }
  if ((host === 'forms.office.com' || host === 'forms.microsoft.com') && /^\/pages\/responsepage\.aspx$/i.test(url.pathname) && url.searchParams.get('id')) {
    const embed = new URL(url.href);
    embed.searchParams.set('embed', 'true');
    return embed.href;
  }
  return null;
}

/**
 * Decides whether a form link can be shown inside the page, and how.
 * Returns { embed, reason }:
 *   reason 'ok'            embed is the address to put in the <iframe>;
 *                          signIn: true when the form makes visitors sign in
 *   reason 'not-supported' not a Google/Microsoft form → show a button
 *   reason 'needs-sign-in' Google only shows this form to signed-in users
 *                          (e.g. it has a file-upload question), and its
 *                          sign-in page cannot appear inside other sites
 *   reason 'unreachable'   the link could not be checked (network) → button
 * Follows forms.gle short links and, for Google Forms, asks Google whether
 * the embedded form loads for a visitor who is not signed in. Never throws,
 * so a slow network can only ever mean "show a button", not a broken build.
 */
export async function checkFormEmbed(value, { fetchImpl = fetch, timeoutMs = 6000, verify = !skipFormCheck() } = {}) {
  let embed = formEmbedUrl(value);
  const url = httpsUrl(value);
  if (!embed && url?.hostname.toLowerCase() === 'forms.gle') {
    if (!verify) return { embed: null, reason: 'unreachable' }; // offline (tests): no lookups at all
    try {
      const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel?.();
      const location = response.headers.get('location');
      embed = location ? formEmbedUrl(new URL(location, url).href) : null;
      if (!embed) return { embed: null, reason: location ? 'not-supported' : 'unreachable' };
    } catch {
      return { embed: null, reason: 'unreachable' };
    }
  }
  if (!embed) return { embed: null, reason: 'not-supported' };
  if (!verify || !embed.startsWith('https://docs.google.com/')) return { embed, reason: 'ok' };
  // 1. Google's official embed address. Forms that need sign-in (e.g. a
  //    file-upload question) answer 401 here …
  const official = await framable(embed, fetchImpl, timeoutMs);
  if (official === 'ok') return { embed, reason: 'ok' };
  if (official === 'unreachable') return { embed: null, reason: 'unreachable' };
  // 2. … but their normal page still loads for visitors, and may be framed
  //    (this is how the site embedded forms before).
  const plain = new URL(embed);
  plain.searchParams.delete('embedded');
  const fallback = await framable(plain.href, fetchImpl, timeoutMs);
  // signIn: the form shows inside the page, but Google asks visitors to sign
  // in before they can fill it in, and that cannot happen inside the page.
  if (fallback === 'ok') return { embed: plain.href, reason: 'ok', signIn: true };
  return { embed: null, reason: fallback === 'unreachable' ? 'unreachable' : 'needs-sign-in' };
}

/**
 * 'ok' if the page loads for a signed-out visitor and does not forbid being
 * shown inside another site; 'blocked' if it needs sign-in or forbids
 * framing; 'unreachable' on network trouble.
 */
async function framable(href, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(href, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel?.();
    if (response.status === 401 || response.status === 403) return 'blocked';
    if (!response.ok) return 'unreachable';
    const xfo = (response.headers.get('x-frame-options') || '').toLowerCase();
    // Only the enforced header counts (Google also sends a report-only one).
    const csp = (response.headers.get('content-security-policy') || '').toLowerCase();
    if (xfo === 'deny' || xfo === 'sameorigin' || /frame-ancestors\s+'none'/.test(csp)) return 'blocked';
    return 'ok';
  } catch {
    return 'unreachable';
  }
}

/** The address to embed, or null to show a button instead. */
export async function resolveFormEmbed(value, options) {
  return (await checkFormEmbed(value, options)).embed;
}

// Tests build the site offline; they set SAPTA_SKIP_FORM_CHECK=1.
function skipFormCheck() {
  return globalThis.process?.env?.SAPTA_SKIP_FORM_CHECK === '1';
}

export function registrationLink(value) {
  return httpsUrl(value)?.href ?? null;
}
