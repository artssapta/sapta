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
 *   reason 'ok'            embed is the address to put in the <iframe>
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
  try {
    const response = await fetchImpl(embed, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel?.();
    if (response.status === 401 || response.status === 403) return { embed: null, reason: 'needs-sign-in' };
    return response.ok ? { embed, reason: 'ok' } : { embed: null, reason: 'unreachable' };
  } catch {
    return { embed: null, reason: 'unreachable' };
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
