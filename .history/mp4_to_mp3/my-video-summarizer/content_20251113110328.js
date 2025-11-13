// Fichero: content.js

// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// ---------- Helpers proveedor/thumbnail ----------
function ytIdFromURL(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    // Aceptamos 'youtube.com' Y 'youtube-nocookie.com'
    if (!url.hostname.endsWith('youtube.com') && !url.hostname.endsWith('youtube-nocookie.com')) return null;
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
    console.warn('[VideoDetector] Fallo al capturar thumbnail', e);
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

// Para evitar envíos duplicados de 'videoFound' para la misma URL
const sentUrls = new Set();

function scanOnce() {
  
  // ### DEBUG ###: Envía un ping CADA VEZ que scanOnce() se ejecuta.
  console.warn('VideoDetector: Ejecutando scanOnce()');
  chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce' }).catch(()=>{});

  try {
    const prov = providerMetaFromHere();

    document.querySelectorAll('video').forEach(v => {
      wireVideo(v);
      const u = resolveUrl(String(v.currentSrc || v.src));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'video-tag', src: u } }).catch(()=>{});
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'video-tag', frameUrl: location.href, meta: {...prov, ...captureThumbIfPossible(v)} }).catch(()=>{});
      }
      v.querySelectorAll('source').forEach(s => {
        const uSrc = resolveUrl(String(s.src));
        if (uSrc && !sentUrls.has(uSrc)) {
          sentUrls.add(uSrc);
          chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'source-tag', src: uSrc } }).catch(()=>{});
          chrome.runtime.sendMessage({ type:'videoFound', url:uSrc, via:'source-tag', frameUrl: location.href, meta: prov||null }).catch(()=>{});
        }
      });
    });

    document.querySelectorAll('iframe').forEach(ifr => {
      const s = resolveUrl(String(ifr.getAttribute('src')||''));
      
      console.warn(`[VideoDetector] scanOnce: Found iframe. src is: "${s}"`);
      chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_found_iframe', extra: { src: s, sent: sentUrls.has(s) } }).catch(()=>{});

      if (!s || s.startsWith('about:blank') || s.startsWith('javascript:')) {
        console.warn('[VideoDetector] scanOnce: Iframe skipped (no src).');
        return; // Saltar este iframe, pero continuar el bucle
      }
      if (sentUrls.has(s)) {
        console.warn(`[VideoDetector] scanOnce: Iframe skipped (already sent): "${s}"`);
        return; // Saltar este iframe, pero continuar el bucle
      }

      // YouTube
      const y = ytIdFromURL(s);
      if (y) {
        console.warn(`[VideoDetector] scanOnce: Sending videoFound (YouTube): "${s}"`);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-youtube', src: s } }).catch(()=>{});
        sentUrls.add(s);
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube', frameUrl: location.href, meta: { provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` }});
        return; 
      }
      
      // Vimeo
      const vimeo = vimeoIdFromURL(s);
      if (vimeo) {
        console.warn(`[VideoDetector] scanOnce: Sending videoFound (Vimeo): "${s}"`);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-vimeo', src: s } }).catch(()=>{});
        sentUrls.add(s);
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta: { provider:'vimeo', providerId:vimeo }});
        return;
      }

      // Dailymotion
      const dm = dmIdFromURL(s);
      if (dm) {
        console.warn(`[VideoDetector] scanOnce: Sending videoFound (Dailymotion): "${s}"`);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-dailymotion', src: s } }).catch(()=>{});
        sentUrls.add(s);
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta: { provider:'dm', providerId:dm }});
        return;
      }

      // Lógica "Catch-all" para iframes desconocidos (COMO EL DE GOOGLE SITES)
      console.warn(`[VideoDetector] scanOnce: Sending videoFound (Unknown): "${s}"`);
      chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-unknown', src: s } }).catch(()=>{});
      sentUrls.add(s);
      chrome.runtime.sendMessage({ 
          type:'videoFound', 
          url:s, 
          via:'embed-unknown',
          frameUrl: location.href, 
          meta: { ...(prov||{}), provider:'iframe' }
      }).catch(()=>{});
      
    });

    // ####################################################################
    // ### INICIO DE LA MODIFICACIÓN: BUSCADOR DE LAZY-LOAD (CON DEBUG) ###
    // ####################################################################
    
    // Busca elementos que tengan atributos de datos con el ID de YouTube
    const lazyElements = document.querySelectorAll('[data-videoid], [data-ytid], [data-yt-id]');
    
    // ### DEBUG 1: ¿Encontramos candidatos? ###
    if (lazyElements.length > 0) {
        chrome.runtime.sendMessage({ 
            type: 'dbg.ping', 
            from: 'scanOnce_lazy_found_candidates', 
            extra: { count: lazyElements.length } 
        }).catch(()=>{});
    }

    lazyElements.forEach(el => {
      const videoId = el.dataset.videoid || el.dataset.ytid || el.dataset.ytId;

      // ### DEBUG 2: ¿Qué ID extrajimos? ###
      chrome.runtime.sendMessage({ 
          type: 'dbg.ping', 
          from: 'scanOnce_lazy_candidate_check', 
          extra: { 
              videoId: videoId || 'NULL', // Muestra el ID encontrado
              tagName: el.tagName,
              className: el.className 
          } 
      }).catch(()=>{});

      if (!videoId || videoId === 'false') {
        return;
      }
      
      const s = `https://www.youtube-nocookie.com/embed/${videoId}`;

      if (sentUrls.has(s)) {
        // ### DEBUG 3: ¿Era un duplicado? ###
        chrome.runtime.sendMessage({ 
            type: 'dbg.ping', 
            from: 'scanOnce_lazy_DUPLICATE', 
            extra: { src: s } 
        }).catch(()=>{});
        return;
      }

      // ¡Encontrado! Enviarlo a la extensión.
      console.warn(`[VideoDetector] scanOnce: Sending videoFound (Lazy-load): "${s}"`);
      chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-lazy-yt', src: s } }).catch(()=>{});
      sentUrls.add(s);
      
      chrome.runtime.sendMessage({ 
        type:'videoFound', 
        url:s, 
        via:'embed-youtube-lazy', // Un 'via' especial para saber que lo sacamos así
        frameUrl: location.href, 
        meta: { 
          provider:'yt', 
          providerId: videoId, 
          thumb:`https://img.youtube.com/vi/${videoId}/hqdefault.jpg` 
        }
      });
    });
    // ####################################################################
    // ### FIN DE LA MODIFICACIÓN ###
    // ####################################################################


    document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{
      const u = resolveUrl(String(l.getAttribute('href')));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'preload-link', src: u } }).catch(()=>{});
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'preload-link', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      }
    });

    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    if (og?.content) {
      const u = resolveUrl(String(og.content));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'og:video', src: u } }).catch(()=>{});
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'og:video', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      }
    }
  
  } catch(e) {
    console.error('[VideoDetector] Error en scanOnce:', e);
    chrome.runtime.sendMessage({ type: 'dbg.contentScriptError', error: `[scanOnce] ${e?.message || String(e)}`, frameUrl: window.location.href }).catch(()=>{});
  }
}

// Asignar el observador a una variable para evitar que sea eliminado por el recolector de basura
const scanObserver = new MutationObserver(scanOnce);

// Observar cambios en atributos (como 'src') y la adición/eliminación de nodos
scanObserver.observe(document, { 
  childList: true,    // Vigila si se añaden/quitan elementos
  subtree: true,      // Vigila en todo el documento
  attributes: true    // Vigila CUALQUIER cambio de atributo
});

scanOnce(); // Ejecutar el escaneo inicial


// ####################################################################
// ### INICIO DEL CÓDIGO AÑADIDO PARA EL VOLCADO DE DOM ###
// ####################################################################
(function() {
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