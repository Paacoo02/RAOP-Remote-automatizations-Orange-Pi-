// Fichero: content.js

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

/**
 * Intenta resolver una URL relativa (ej: "/video.mp4") a una URL absoluta
 * usando la ubicación actual del documento.
 */
function resolveUrl(url) {
  if (!url || typeof url !== 'string') return '';
  // Si ya es absoluta, devolverla
  if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('blob:') || url.startsWith('data:')) {
    return url;
  }
  // Si es relativa al protocolo (ej: //google.com)
  if (url.startsWith('//')) {
    return location.protocol + url;
  }
  // Resolverla usando la base del documento
  try {
    return new URL(url, location.href).href;
  } catch {
    return url; // fallback
  }
}

function captureThumbIfPossible(v) {
  try {
    const poster = v.getAttribute('poster');
    // Usar el poster si existe
    if (poster) return { thumb: resolveUrl(poster) };
    
    // Si no, intentar capturar un fotograma del vídeo
    if (v.videoWidth && v.videoHeight && v.readyState >= 2) { // 2 = HAVE_METADATA
      const ratio = v.videoWidth / v.videoHeight;
      const w = 320, h = Math.max(1, Math.round(w / ratio));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.6);
      if (data.length < 350000) return { thumb: data }; // Evitar dataURIs enormes
    }
  } catch (e) {
    // A veces falla por CORS al pintar en el canvas
    console.warn('Fallo al capturar thumbnail', e);
  }
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
    url: resolveUrl(String(d.url || '')), // Resolver URL siempre
    via: d.via || 'hook',
    frameUrl: location.href,
    meta
  }).catch(()=>{});
}, false);

// ---------- Estado de los <video> ----------
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

  // El vídeo ya puede tener metadatos, hacer una captura inicial
  if (v.readyState >= 2) {
    send(true);
  } else {
    // Si no, esperar a que carguen los metadatos para la miniatura
    v.addEventListener('loadedmetadata', () => send(true),  { passive:true, once: true });
  }

  // Escuchar eventos de reproducción
  v.addEventListener('play',            () => send(false), { passive:true });
  v.addEventListener('pause',           () => send(false), { passive:true });
  v.addEventListener('ended',           () => send(false), { passive:true });

  // Envío inicial por si acaso
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
        return; // Es de YouTube, no lo listes genéricamente
      }
      
      // Vimeo
      const vimeo = vimeoIdFromURL(s);
      if (vimeo) {
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta: { provider:'vimeo', providerId:vimeo }});
        return; // Es de Vimeo
      }

      // Dailymotion
      const dm = dmIdFromURL(s);
      if (dm) {
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta: { provider:'dm', providerId:dm }});
        return; // Es de Dailymotion
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

// Este script escanea el DOM en busca de etiquetas <video>, <iframe>, etc.
// y envía su HTML (outerHTML) al service worker bajo el mensaje
// 'dbg.foundMediaElements', que es lo que querías originalmente.

(function() {
  // Usamos un guardián único para este bloque
  if (window.myDomDebugScannerHasRun) {
    return;
  }
  window.myDomDebugScannerHasRun = true;

  try {
    // 1. Buscar los elementos
    const mediaElements = document.querySelectorAll('video, iframe, object, embed');
    
    // 2. Extraer su HTML (outerHTML)
    const mediaHtmlList = [];
    mediaElements.forEach(el => mediaHtmlList.push(el.outerHTML));

    // 3. Enviar SIEMPRE el mensaje, incluso si count es 0
    // (Esto confirma que el script se ejecutó)
    chrome.runtime.sendMessage({ 
      type: 'dbg.foundMediaElements', 
      elements: mediaHtmlList, 
      count: mediaHtmlList.length,
      frameUrl: location.href 
    });

  } catch (e) {
    // Enviar un error si este escáner específico falla
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