// Fichero: content.js

// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// ---------- Helpers proveedor/thumbnail ----------
function ytIdFromURL(u) {
  // ... (sin cambios)
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
  // ... (sin cambios)
  try {
    const url = new URL(u);
    if (url.hostname === 'player.vimeo.com' && url.pathname.startsWith('/video/')) {
      return url.pathname.split('/')[2] || null;
    }
  } catch {}
  return null;
}
function dmIdFromURL(u) {
  // ... (sin cambios)
  try {
    const url = new URL(u);
    if (url.hostname === 'www.dailymotion.com' && url.pathname.startsWith('/embed/video/')) {
      return url.pathname.split('/')[3] || null;
    }
  } catch {}
  return null;
}
function providerMetaFromHere() {
  // ... (sin cambios)
  let id = ytIdFromURL(location.href);
  if (id) return { provider: 'yt', providerId: id, thumb: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };
  let vimeo = vimeoIdFromURL(location.href);
  if (vimeo) return { provider: 'vimeo', providerId: vimeo };
  let dm = dmIdFromURL(location.href);
  if (dm) return { provider: 'dm', providerId: dm };
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
function resolveUrl(url) {
  // ... (sin cambios)
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('blob:') || url.startsWith('data:')) {
    return url;
  }
  if (url.startsWith('//')) {
    return location.protocol + url;
  }
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}
function captureThumbIfPossible(v) {
  // ... (sin cambios)
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
  } catch (e) {
    console.warn('Fallo al capturar thumbnail', e);
  }
  return {};
}

// ---------- Puente MAIN->SW (fusiona meta del proveedor SIEMPRE) ----------
window.addEventListener('message', (ev) => {
  // ... (sin cambios)
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

// ---------- Estado de los <video> ----------
function snapshot(v) {
  // ... (sin cambios)
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
  // ... (sin cambios)
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
  if (v.readyState >= 2) {
    send(true);
  } else {
    v.addEventListener('loadedmetadata', () => send(true),  { passive:true, once: true });
  }
  v.addEventListener('play',            () => send(false), { passive:true });
  v.addEventListener('pause',           () => send(false), { passive:true });
  v.addEventListener('ended',           () => send(false), { passive:true });
  setTimeout(() => send(false), 0);
}

// ---------- Escaneo inicial + mutaciones ----------
function scanOnce() {
  try {
    const prov = providerMetaFromHere();

    document.querySelectorAll('video').forEach(v => {
      wireVideo(v); // Asignar listeners
      const u = v.currentSrc || v.src;
      if (u) chrome.runtime.sendMessage({ type:'videoFound', url:resolveUrl(String(u)), via:'video-tag', frameUrl: location.href, meta: {...prov, ...captureThumbIfPossible(v)} }).catch(()=>{});
      
      v.querySelectorAll('source').forEach(s => {
        if (s.src) chrome.runtime.sendMessage({ type:'videoFound', url:resolveUrl(String(s.src)), via:'source-tag', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      });
    });

    // ### CAMBIO 1: El selector ahora es 'iframe' (no 'iframe[src]') ###
    document.querySelectorAll('iframe').forEach(ifr => {
      const s = resolveUrl(String(ifr.getAttribute('src')||''));
      
      // Si el iframe no tiene 'src' todavía, no podemos hacer nada con él
      if (!s) return;

      // YouTube
      const y = ytIdFromURL(s);
      if (y) {
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube', frameUrl: location.href, meta: { provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` }});
        return; 
      }
      
      // Vimeo
      const vimeo = vimeoIdFromURL(s);
      if (vimeo) {
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta: { provider:'vimeo', providerId:vimeo }});
        return;
      }

      // Dailymotion
      const dm = dmIdFromURL(s);
      if (dm) {
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta: { provider:'dm', providerId:dm }});
        return;
      }
    });

    document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{
      const u = l.getAttribute('href');
      if (u) chrome.runtime.sendMessage({ type:'videoFound', url:resolveUrl(String(u)), via:'preload-link', frameUrl: location.href, meta: prov||null }).catch(()=>{});
    });

    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    if (og?.content) chrome.runtime.sendMessage({ type:'videoFound', url:resolveUrl(String(og.content)), via:'og:video', frameUrl: location.href, meta: prov||null }).catch(()=>{});
  
  } catch {}
}

// ### CAMBIO 2: El observador ahora vigila 'attributes' también ###
// Observar cambios en atributos (como 'src') y la adición/eliminación de nodos
new MutationObserver(scanOnce).observe(document, { 
  childList: true,    // Vigila si se añaden/quitan elementos (ej: el iframe)
  subtree: true,      // Vigila en todo el documento
  attributes: true,   // Vigila si cambian atributos (ej: 'src' en el iframe)
  attributeFilter: ['src'] // Opcional: solo nos importa si cambia 'src'
});
scanOnce(); // Ejecutar el escaneo inicial


// ####################################################################
// ### INICIO DEL CÓDIGO AÑADIDO PARA EL VOLCADO DE DOM ###
// ####################################################################
(function() {
  // ... (esto es nuestro código de depuración, sin cambios)
  if (window.myDomDebugScannerHasRun) {
    return;
  }
  window.myDomDebugScannerHasRun = true;
  try {
    const mediaElements = document.querySelectorAll('video, iframe, object, embed');
    const mediaHtmlList = [];
    mediaElements.forEach(el => mediaHtmlList.push(el.outerHTML));
    chrome.runtime.sendMessage({ 
      type: 'dbg.foundMediaElements', 
      elements: mediaHtmlList, 
      count: mediaHtmlList.length,
      frameUrl: location.href 
    });
  } catch (e) {
    try {
      chrome.runtime.sendMessage({ 
        type: 'dbg.contentScriptError',
        error: `[DomDebugScanner] ${e?.message || String(e)}`,
        frameUrl: window.location.href
      });
    } catch(e2) {
      console.error('Error en DomDebugScanner y al reportarlo:', e, e2);
    }
  }
})();
// ####################################################################
// ### FIN DEL CÓDIGO AÑADIDO ###
// ####################################################################