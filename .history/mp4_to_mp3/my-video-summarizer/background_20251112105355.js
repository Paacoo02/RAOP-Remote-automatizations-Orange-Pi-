function providerKeyFrom(entry) {
  const url = String(entry.url||'');
  const frame = String(entry.frameUrl||'');
  const meta = entry.meta || {};

  // 0) Si hay meta explícita, úsala SIEMPRE (viene desde content.js)
  if (meta.provider && meta.providerId) return `${meta.provider}:${meta.providerId}`;

  // 1) Inferencias por URL o frame
  const y1 = ytId(urlFromMaybeString(url)); if (y1) return `yt:${y1}`;
  const y2 = ytId(urlFromMaybeString(frame)); if (y2) return `yt:${y2}`;

  const v1 = vimeoId(urlFromMaybeString(url)); if (v1) return `vimeo:${v1}`;
  const v2 = vimeoId(urlFromMaybeString(frame)); if (v2) return `vimeo:${v2}`;

  const d1 = dailymotionId(urlFromMaybeString(url)); if (d1) return `dm:${d1}`;
  const d2 = dailymotionId(urlFromMaybeString(frame)); if (d2) return `dm:${d2}`;

  // 2) blob dentro de frame de YouTube y (por si acaso) meta.providerId
  if (url.startsWith('blob:') && /(^|\.)youtube\.com$/i.test(hostnameOf(frame)) && meta.providerId) {
    return `yt:${meta.providerId}`;
  }
  // 3) blob agrupado por origen de frame
  if (url.startsWith('blob:') && frame) return `frame:${new URL(frame).origin}`;

  return null;
}
function canonicalKey(entry) {
  return providerKeyFrom(entry) || String(entry.url||'');
}

// helpers locales
function urlFromMaybeString(s){ try{ return new URL(String(s)); }catch{ return null; } }
function hostnameOf(s){ try{ return new URL(String(s)).hostname; }catch{ return ''; } }
function ytId(u){ if(!u) return null; if(u.hostname.endsWith('youtube.com')){ const p=u.pathname; if(p.startsWith('/embed/')) return p.split('/')[2]||null; if(p.startsWith('/shorts/')) return p.split('/')[2]||null; if(p==='/watch') return u.searchParams.get('v'); } return null; }
function vimeoId(u){ if(!u) return null; if(u.hostname==='player.vimeo.com' && u.pathname.startsWith('/video/')) return u.pathname.split('/')[2]||null; return null; }
function dailymotionId(u){ if(!u) return null; if(u.hostname==='www.dailymotion.com' && u.pathname.startsWith('/embed/video/')) return u.pathname.split('/')[3]||null; return null; }
