// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// --- ¡NUEVO HELPER! ---
// Resuelve cualquier URL (relativa o no) a una URL absoluta.
function resolveUrl(url) {
  try {
    let u = String(url || '');
    if (!u) return null;
    // Si ya es absoluta o es un blob/data/mediasource, está bien.
    if (u.startsWith('http') || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('mediasource:')) {
      return u;
    }
    // Si es relativa (p.ej. /video.mp4 o video.mp4), resuélvela
    // usando la ubicación del frame actual como base.
    return new URL(u, location.href).href;
  } catch (e) {
    // URL inválida (p.ej. 'javascript:void(0)')
    return null; 
  }
}

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
    
    // --- CAMBIO ---
    // Se requiere readyState >= 2 (HAVE_CURRENT_DATA) para poder capturar un frame.
    // readyState >= 1 (HAVE_METADATA) no es suficiente.
    if (v.videoWidth && v.videoHeight && v.readyState >= 2) {
      const ratio = v.videoWidth / v.videoHeight;
      const w = 320, h = Math.max(1, Math.round(w / ratio));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.6);
      // Evita miniaturas corruptas o demasiado grandes
      if (data.length > 1000 && data.length < 350000) return { thumb: data };
    }
  } catch(e) {
    // A veces falla por CORS si el vídeo es de otro dominio
    console.warn('Fallo al capturar thumbnail', e.message);
  }
  return {};
}

// ---------- Puente MAIN->SW (fusiona meta del proveedor SIEMPRE) ----------
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__VIDHOOK__ || d.kind !== 'video') return;
  const prov = providerMetaFromHere();
  const meta = { ...(d.meta || {}), ...(prov || {}) };

  // --- ¡CAMBIO! ---
  // Resuelve la URL recibida del 'page_hook'
  const url = resolveUrl(d.url);
  if (!url) return; // No enviar si la URL es nula o inválida

  chrome.runtime.sendMessage({
    type: 'videoFound',
    url: url, // <-- URL ya resuelta
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
    const url = resolveUrl(state.url); // --- ¡CAMBIO! Resuelve la URL
    if (!url) return;
    const meta = { ...(prov||{}) };
    if (withThumb) Object.assign(meta, captureThumbIfPossible(v));
    // Envía 'videoState' para actualizar el estado (play/pause) y la miniatura
    chrome.runtime.sendMessage({ type: 'videoState', url: url, meta }).catch(()=>{});
  };

  // --- CAMBIO ---
  // 'loadeddata' (readyState 2) es más fiable para capturar un frame que 'loadedmetadata' (readyState 1).
  v.addEventListener('loadeddata',     () => send(true),  { passive:true });
  v.addEventListener('play',            () => send(false), { passive:true });
  v.addEventListener('pause',           () => send(false), { passive:true });
  v.addEventListener('ended',           () => send(false), { passive:true });

  // Fallback por si 'loadeddata' ya se disparó.
  setTimeout(() => send(true), 50);
}

// ---------- Escaneo inicial + mutaciones ----------
function scanOnce() {
  try {
    const prov = providerMetaFromHere();

    document.querySelectorAll('video').forEach(v => {
      wireVideo(v);
      // --- ¡CAMBIO! Resuelve la URL ---
      const u = resolveUrl(v.currentSrc || v.src);
      
      // --- CAMBIO ---
      // Intento de captura inmediata al enviar 'videoFound'
      const thumbMeta = captureThumbIfPossible(v);
      const meta = { ...(prov||null), ...(thumbMeta||{}) };

      if (u) chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'video-tag', frameUrl: location.href, meta }).catch(()=>{});
      
      v.querySelectorAll('source').forEach(s => {
        // --- ¡CAMBIO! Resuelve la URL ---
        const uSrc = resolveUrl(s.src);
        if (uSrc) chrome.runtime.sendMessage({ type:'videoFound', url:uSrc, via:'source-tag', frameUrl: location.href, meta }).catch(()=>{});
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
      // --- ¡CAMBIO! Resuelve la URL ---
      const u = resolveUrl(l.getAttribute('href'));
      if (u) chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'preload-link', frameUrl: location.href, meta: prov||null }).catch(()=>{});
    });

    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    // --- ¡CAMBIO! Resuelve la URL ---
    const ogU = resolveUrl(og?.content);
    if (ogU) chrome.runtime.sendMessage({ type:'videoFound', url:ogU, via:'og:video', frameUrl: location.href, meta: prov||null }).catch(()=>{});
  } catch {}
}
new MutationObserver(scanOnce).observe(document, { childList:true, subtree:true });
scanOnce()