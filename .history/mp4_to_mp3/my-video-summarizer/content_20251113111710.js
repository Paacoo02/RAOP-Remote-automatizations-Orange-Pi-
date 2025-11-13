// Fichero: content.js

// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// ====================== Utils comunes ======================
function resolveUrl(url) {
  if (!url || typeof url !== 'string') return '';
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  if (url.startsWith('//')) return location.protocol + url;
  try { return new URL(url, location.href).href; } catch { return url; }
}

function ytIdFromWatchUrl(u) {
  try {
    const url = new URL(u);
    if (!/youtube\.com$|youtube-nocookie\.com$|youtu\.be$/.test(url.hostname)) return null;
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }
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

function captureThumbIfPossible(v) {
  try {
    const poster = v.getAttribute('poster');
    if (poster) return { thumb: resolveUrl(poster) };
    if (v.videoWidth && v.videoHeight && v.readyState >= 2) {
      const ratio = v.videoWidth / v.videoHeight;
      const w = 320, h = Math.max(1, Math.round(w / ratio));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.6);
      if (data.length < 350000) return { thumb: data };
    }
  } catch(e) { console.warn('[VideoDetector] Fallo thumb', e); }
  return {};
}

function providerMetaFromHere() {
  // 1) location.href
  let id = ytIdFromWatchUrl(location.href);
  if (id) return { provider: 'yt', providerId: id, thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };

  let vimeo = vimeoIdFromURL(location.href);
  if (vimeo) return { provider: 'vimeo', providerId: vimeo };

  let dm = dmIdFromURL(location.href);
  if (dm) return { provider: 'dm', providerId: dm };

  // 2) document.referrer
  try {
    if (document.referrer) {
      id = ytIdFromWatchUrl(document.referrer);
      if (id) return { provider: 'yt', providerId: id, thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };
      vimeo = vimeoIdFromURL(document.referrer);
      if (vimeo) return { provider: 'vimeo', providerId: vimeo };
      dm = dmIdFromURL(document.referrer);
      if (dm) return { provider: 'dm', providerId: dm };
    }
  } catch {}
  return null;
}

// ====================== Heurísticas de Lazy ======================
function extractYtIdFromStyle(styleStr) {
  // Busca ...i.ytimg.com/vi/VIDEOID/... en background-image u otros
  if (!styleStr) return null;
  const m = styleStr.match(/i\.ytimg\.com\/vi\/([a-zA-Z0-9_-]{6,})\//);
  return m ? m[1] : null;
}

function tryParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

function scanLazyYouTubeGlobal(report) {
  // 1) Plyr
  document.querySelectorAll('[data-plyr-provider="youtube"][data-plyr-embed-id]').forEach(el => {
    const id = el.getAttribute('data-plyr-embed-id');
    if (id) report({ id, via: 'lazy-plyr' });
  });

  // 2) Elementor: data-settings con JSON
  document.querySelectorAll('[data-settings]').forEach(el => {
    const raw = el.getAttribute('data-settings');
    if (!raw) return;
    const js = tryParseJSON(raw);
    const u = js?.youtube_url || js?.video_url || js?.url || null;
    const id = ytIdFromWatchUrl(u);
    if (id) report({ id, via: 'lazy-elementor' });
  });

  // 3) Cualquier elemento con fondo de i.ytimg.com/vi/ID
  document.querySelectorAll('[style*="i.ytimg.com/vi/"]').forEach(el => {
    const id = extractYtIdFromStyle(el.getAttribute('style') || '');
    if (id) report({ id, via: 'lazy-bg-thumb' });
  });

  // 4) Enlaces a YouTube presentes en la misma sección que un iframe vacío
  const emptyIframes = Array.from(document.querySelectorAll('iframe[allowfullscreen]:not([src])'));
  emptyIframes.forEach(ifr => {
    const scope = ifr.closest('section, article, div, figure') || document;
    const a = scope.querySelector('a[href*="youtu.be/"], a[href*="youtube.com/watch"], a[href*="youtube.com/shorts/"]');
    const id = a ? ytIdFromWatchUrl(a.getAttribute('href')) : null;
    if (id) report({ id, via: 'lazy-nearby-link' });
  });

  // 5) Custom elements tipo <lite-youtube videoid="...">
  document.querySelectorAll('lite-youtube, lite-youtube-embed').forEach(el => {
    const id = el.getAttribute('videoid') || el.getAttribute('video-id') || el.dataset.videoid || el.dataset.vid;
    if (id) report({ id, via: 'lazy-lite-youtube' });
  });
}

// ====================== Puente MAIN -> SW ======================
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__VIDHOOK__ || d.kind !== 'video') return;
  const prov = providerMetaFromHere();
  const meta = { ...(d.meta || {}), ...(prov || {}) };
  chrome.runtime.sendMessage({
    type: 'videoFound',
    url: resolveUrl(String(d.url || '')),
    via: d.via || 'hook',
    frameUrl: location.href,
    meta
  }).catch(()=>{});
}, false);

// ====================== Estado de <video> ======================
function snapshot(v) {
  return {
    url: resolveUrl(v.currentSrc || v.src || ''),
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

  if (v.readyState >= 2) { send(true); }
  else { v.addEventListener('loadedmetadata', () => send(true),  { passive:true, once: true }); }
  v.addEventListener('play',  () => send(false), { passive:true });
  v.addEventListener('pause', () => send(false), { passive:true });
  v.addEventListener('ended', () => send(false), { passive:true });

  setTimeout(() => send(false), 0);
}

// ====================== Escaneo + Mutations ======================
const sentUrls = new Set();              // URLs reales
const sentVirtual = new Set();           // Claves virtuales (p. ej., virtual:yt:ID)

function sendFound(url, via, meta) {
  if (!url) return;
  if (sentUrls.has(url)) return;
  sentUrls.add(url);
  chrome.runtime.sendMessage({ type:'videoFound', url, via, frameUrl: location.href, meta }).catch(()=>{});
}

function sendVirtual(key, url, via, meta) {
  if (sentVirtual.has(key)) return;
  sentVirtual.add(key);
  sendFound(url, via, meta);
}

let scanTimer = null;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanOnce, 60);
}

function scanOnce() {
  // DEBUG opcional
  chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce' }).catch(()=>{});

  try {
    const prov = providerMetaFromHere();

    // 1) <video> y <source>
    document.querySelectorAll('video').forEach(v => {
      wireVideo(v);
      const u = resolveUrl(String(v.currentSrc || v.src));
      if (u) sendFound(u, 'video-tag', { ...(prov||{}), ...captureThumbIfPossible(v) });
      v.querySelectorAll('source').forEach(s => {
        const uSrc = resolveUrl(String(s.src));
        if (uSrc) sendFound(uSrc, 'source-tag', prov||null);
      });
    });

    // 2) iframes con src directo
    document.querySelectorAll('iframe').forEach(ifr => {
      const s = resolveUrl(String(ifr.getAttribute('src')||''));
      chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_found_iframe', extra: { src: s || '(empty)' } }).catch(()=>{});

      if (!s || s.startsWith('about:blank') || s.startsWith('javascript:')) return;

      const y = ytIdFromWatchUrl(s);
      if (y) return sendFound(s, 'embed-youtube', { provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` });

      const vimeo = vimeoIdFromURL(s);
      if (vimeo) return sendFound(s, 'embed-vimeo', { provider:'vimeo', providerId:vimeo });

      const dm = dmIdFromURL(s);
      if (dm) return sendFound(s, 'embed-dailymotion', { provider:'dm', providerId:dm });

      // catch-all
      sendFound(s, 'embed-unknown', { ...(prov||{}), provider:'iframe' });
    });

    // 3) Heurísticas de L A Z Y (cuando no hay src)
    scanLazyYouTubeGlobal(({ id, via }) => {
      const key = `virtual:yt:${id}`;
      const url = `https://www.youtube-nocookie.com/embed/${id}`;
      const meta = { provider:'yt', providerId:id, thumb:`https://img.youtube.com/vi/${id}/hqdefault.jpg` };
      sendVirtual(key, url, via, meta);
    });

    // 4) Preload y OG
    document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{
      const u = resolveUrl(String(l.getAttribute('href')));
      if (u) sendFound(u, 'preload-link', prov||null);
    });
    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    if (og?.content) {
      const u = resolveUrl(String(og.content));
      if (u) sendFound(u, 'og:video', prov||null);
    }

  } catch(e) {
    console.error('[VideoDetector] Error en scanOnce:', e);
    chrome.runtime.sendMessage({ type: 'dbg.contentScriptError', error: `[scanOnce] ${e?.message || String(e)}`, frameUrl: window.location.href }).catch(()=>{});
  }

  // Volcado simple para debug visual (como ya tenías)
  try {
    const mediaElements = document.querySelectorAll('video, iframe, object, embed');
    const mediaHtmlList = [];
    mediaElements.forEach(el => mediaHtmlList.push(el.outerHTML));
    chrome.runtime.sendMessage({
      type: 'dbg.foundMediaElements',
      elements: mediaHtmlList,
      count: mediaHtmlList.length,
      frameUrl: location.href
    }).catch(()=>{});
  } catch {}
}

// Observador (throttleado)
const scanObserver = new MutationObserver(() => scheduleScan());
scanObserver.observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcdoc', 'style', 'data-settings', 'data-plyr-embed-id', 'data-plyr-provider']
});

// Escaneo inicial
scanOnce();
