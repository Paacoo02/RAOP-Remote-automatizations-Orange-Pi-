// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// ---------- Helpers proveedor/thumbnail ----------
function ytIdFromURL(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (!url.hostname.endsWith('youtube.com')) return null;
    if (url.pathname.startsWith('/embed/'))  return url.pathname.split('/')[2] || null;
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    if (url.pathname === '/watch')           return url.searchParams.get('v');
  } catch {}
  return null;
}
function vimeoIdFromURL(u) {
  try {
    const url = new URL(u);
    if (url.hostname === 'player.vimeo.com' && url.pathname.startsWith('/video/')) {
      return url.pathname.split('/')[2] || null;
    }
  } catch {}
  return null;
}
function dmIdFromURL(u) {
  try {
    const url = new URL(u);
    if (url.hostname === 'www.dailymotion.com' && url.pathname.startsWith('/embed/video/')) {
      return url.pathname.split('/')[3] || null;
    }
  } catch {}
  return null;
}

/**
 * Devuelve meta { provider, providerId, thumb? } tomando primero location.href
 * y si no hay id (p. ej. frame interno de YouTube), intenta con document.referrer.
 */
function providerMetaFromHere() {
  // 1) location.href
  let id = ytIdFromURL(location.href);
  if (id) return { provider: 'yt', providerId: id, thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };

  let vimeo = vimeoIdFromURL(location.href);
  if (vimeo) return { provider: 'vimeo', providerId: vimeo };

  let dm = dmIdFromURL(location.href);
  if (dm) return { provider: 'dm', providerId: dm };

  // 2) fallback: document.referrer (clave para frames internos /s/player/… de YouTube)
  try {
    if (document.referrer) {
      id = ytIdFromURL(document.referrer);
      if (id) return { provider: 'yt', providerId: id, thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };

      vimeo = vimeoIdFromURL(document.referrer);
      if (vimeo) return { provider: 'vimeo', providerId: vimeo };

      dm = dmIdFromURL(document.referrer);
      if (dm) return { provider: 'dm', providerId: dm };
    }
  } catch {}

  return null;
}

function captureThumbIfPossible(v) {
  try {
    const poster = v.getAttribute('poster');
    if (poster) return { thumb: poster };
    if (v.videoWidth && v.videoHeight && v.readyState >= 2) {
      const ratio = v.videoWidth / v.videoHeight;
      const w = 320, h = Math.max(1, Math.round(w / ratio));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.6);
      if (data.length < 350000) return { thumb: data };
    }
  } catch {}
  return {};
}

// ---------- Puente MAIN->SW (fusiona meta del proveedor SIEMPRE) ----------
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__VIDHOOK__ || d.kind !== 'video') return;
  const prov = providerMetaFromHere();
  const meta = { ...(d.meta || {}), ...(prov || {}) };
  chrome.runtime.sendMessage({
    type: 'videoFound',
    url: String(d.url || ''),
    via: d.via || 'hook',
    frameUrl: location.href,
    meta
  }).catch(()=>{});
}, false);

// ---------- Estado de los <video> ----------
function snapshot(v) {
  return {
    url: v.currentSrc || v.src || '',
    paused: v.paused,
    muted: v.muted,
    volume: v.volume,
    readyState: v.readyState,
    duration: Number.isFinite(v.duration) ? v.duration : null,
    currentTime: v.currentTime,
    width: v.videoWidth,
    height: v.videoHeight,
    autoplay: !!v.autoplay,
    controls: !!v.controls,
    frameUrl: location.href,
    playing: !v.paused,
    ts: Date.now()
  };
}
function wireVideo(v) {
  if (v.__vidext_wired) return;
  v.__vidext_wired = true;

  const prov = providerMetaFromHere();

  const send = (withThumb=false) => {
    const state = snapshot(v);
    if (!state.url) return;
    const meta = { ...(prov||{}) };
    if (withThumb) Object.assign(meta, captureThumbIfPossible(v));
    chrome.runtime.sendMessage({ type: 'videoState', state, meta }).catch(()=>{});
  };

  v.addEventListener('loadedmetadata', () => send(true),  { passive:true });
  v.addEventListener('play',            () => send(false), { passive:true });
  v.addEventListener('pause',           () => send(false), { passive:true });
  v.addEventListener('ended',           () => send(false), { passive:true });

  setTimeout(() => send(true), 0);
}

// ---------- Escaneo inicial + mutaciones ----------
function scanOnce() {
  try {
    const prov = providerMetaFromHere();

    document.querySelectorAll('video').forEach(v => {
      wireVideo(v);
      const u = v.currentSrc || v.src;
      if (u) chrome.runtime.sendMessage({ type:'videoFound', url:String(u), via:'video-tag', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      v.querySelectorAll('source').forEach(s => {
        if (s.src) chrome.runtime.sendMessage({ type:'videoFound', url:String(s.src), via:'source-tag', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      });
    });

    document.querySelectorAll('iframe[src]').forEach(ifr => {
      const s = String(ifr.getAttribute('src')||'');
      // YouTube
      const y = ytIdFromURL(s);
      if (y) chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube', frameUrl: location.href, meta: { provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` }});
      // Vimeo
      const vimeo = vimeoIdFromURL(s);
      if (vimeo) chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta: { provider:'vimeo', providerId:vimeo }});
      // Dailymotion
      const dm = dmIdFromURL(s);
      if (dm) chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta: { provider:'dm', providerId:dm }});
    });

    document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{
      const u = l.getAttribute('href');
      if (u) chrome.runtime.sendMessage({ type:'videoFound', url:String(u), via:'preload-link', frameUrl: location.href, meta: prov||null }).catch(()=>{});
    });

    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    if (og?.content) chrome.runtime.sendMessage({ type:'videoFound', url:String(og.content), via:'og:video', frameUrl: location.href, meta: prov||null }).catch(()=>{});
  } catch {}
}
new MutationObserver(scanOnce).observe(document, { childList:true, subtree:true });
scanOnce();
