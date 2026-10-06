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

export function registrationLink(value) {
  return httpsUrl(value)?.href ?? null;
}
