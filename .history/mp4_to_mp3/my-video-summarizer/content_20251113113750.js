// ======================= content.js =======================
// Nota: en el manifest asegúrate de tener "all_frames": true y "match_about_blank": true
// para enganchar iframes/blank y ver el src cuando aparezca.

// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// ---------- Helpers proveedor/thumbnail ----------
function ytIdFromURL(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    // Aceptamos 'youtube.com' y 'youtube-nocookie.com'
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

  // 2) fallback: referrer (clave para frames internos /s/player/... de YouTube)
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
  if (url.startsWith('http:') || url.startsWith('https:')) return url;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
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

// ---------- Helpers para iframes lazy sin src ----------
const YT_ID_RE    = /^[A-Za-z0-9_-]{8,15}$/; // tolerante (IDs estándar 11, admitimos 8–15)
const YT_EMBED_RE = /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{8,15})/i;
const YT_LINK_RE  = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{8,15})/i;
// Para detectar miniaturas existentes en el DOM (incluye vi_webp)
const YT_IMG_RE   = /https?:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\/vi(?:_webp)?\/([A-Za-z0-9_-]{8,15})\/[^"'\s)]+/i;

function ytThumbCandidates(id) {
  return [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/default.jpg`,
    `https://i.ytimg.com/vi/${id}/0.jpg`,
    `https://i.ytimg.com/vi/${id}/1.jpg`,
    `https://i.ytimg.com/vi/${id}/2.jpg`,
    `https://i.ytimg.com/vi/${id}/3.jpg`,
    `https://i.ytimg.com/vi_webp/${id}/maxresdefault.webp`,
    `https://i.ytimg.com/vi_webp/${id}/hqdefault.webp`,
  ];
}

function pickFromSrcOrSrcset(el) {
  const attrs = ['src','data-src','data-lazy-src','data-original','data-thumb','srcset','data-srcset'];
  for (const a of attrs) {
    const v = el.getAttribute(a);
    if (!v) continue;
    if (a.includes('srcset')) {
      const cand = v.split(',').map(s=>s.trim().split(/\s+/)[0]).find(u=>YT_IMG_RE.test(u));
      if (cand) return resolveUrl(cand);
    } else {
      if (YT_IMG_RE.test(v)) return resolveUrl(v);
    }
  }
  // último intento: background-image
  try {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
    if (m && YT_IMG_RE.test(m[1])) return m[1];
  } catch {}
  return null;
}

function buildProviderFromUrl(u) {
  const y = ytIdFromURL(u) || (YT_EMBED_RE.exec(u)?.[1]) || (YT_LINK_RE.exec(u)?.[1]);
  if (y) {
    return { 
      url: `https://www.youtube-nocookie.com/embed/${y}`, 
      meta: { provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` } 
    };
  }
  const v = vimeoIdFromURL(u);
  if (v) return { url: u, meta: { provider:'vimeo', providerId:v } };

  const d = dmIdFromURL(u);
  if (d) return { url: u, meta: { provider:'dm', providerId:d } };

  return null;
}

function extractFirstEmbedFromHTML(html) {
  if (!html) return null;
  // Busca un src de iframe o un href con YT/Vimeo/DM
  const mSrc = html.match(/src\s*=\s*["']([^"']+)["']/i);
  if (mSrc) {
    const prov = buildProviderFromUrl(resolveUrl(mSrc[1]));
    if (prov) return prov;
  }
  const mHref = html.match(/href\s*=\s*["']([^"']+)["']/i);
  if (mHref) {
    const prov = buildProviderFromUrl(resolveUrl(mHref[1]));
    if (prov) return prov;
  }
  // Busca URLs “a pelo”
  const mUrl = html.match(/https?:\/\/[^\s"'<>]+/g);
  if (mUrl) {
    for (const raw of mUrl) {
      const prov = buildProviderFromUrl(resolveUrl(raw));
      if (prov) return prov;
    }
  }
  return null;
}

function guessLazyFromIframe(ifr) {
  // 1) Atributos data-* típicos
  const attrs = ['data-src','data-lazy-src','data-embed','data-url','data-href','data-original','data-iframe','data-src-iframe'];
  for (const a of attrs) {
    const val = ifr.getAttribute(a);
    if (val) {
      // Puede ser URL o solo ID de YT
      const id = YT_ID_RE.test(val) ? val : null;
      if (id) {
        return { 
          url: `https://www.youtube-nocookie.com/embed/${id}`, 
          meta: { provider:'yt', providerId:id, thumb:`https://img.youtube.com/vi/${id}/hqdefault.jpg` } 
        };
      }
      const prov = buildProviderFromUrl(resolveUrl(val));
      if (prov) return prov;
    }
  }

  // 2) srcdoc con el HTML del embed
  const srcdoc = ifr.getAttribute('srcdoc');
  if (srcdoc) {
    const prov = extractFirstEmbedFromHTML(srcdoc);
    if (prov) return prov;
  }

  // 3) <noscript> cercano con el iframe real
  const nos = ifr.parentElement?.querySelector('noscript');
  if (nos) {
    const prov = extractFirstEmbedFromHTML(nos.textContent || nos.innerHTML || '');
    if (prov) return prov;
  }

  // 4) Ancestros “típicos” de builders (WordPress/Elementor/etc.)
  const wrap = ifr.closest('[data-ytid],[data-videoid],[data-yt-id], .wp-block-embed, .embed-youtube, .youtube-player, .elementor-widget-video, .jetpack-video-wrapper, figure, .video, .embed');
  if (wrap) {
    const vid = wrap.getAttribute('data-ytid') || wrap.getAttribute('data-videoid') || wrap.getAttribute('data-yt-id');
    if (vid && YT_ID_RE.test(vid)) {
      return { 
        url: `https://www.youtube-nocookie.com/embed/${vid}`, 
        meta: { provider:'yt', providerId:vid, thumb:`https://img.youtube.com/vi/${vid}/hqdefault.jpg` } 
      };
    }
    const a = wrap.querySelector('a[href*="youtube.com"], a[href*="youtu.be"], a[href*="vimeo.com"], a[href*="dailymotion.com"]');
    if (a?.href) {
      const prov = buildProviderFromUrl(resolveUrl(a.href));
      if (prov) return prov;
    }
    const ns = wrap.querySelector('noscript');
    if (ns) {
      const prov = extractFirstEmbedFromHTML(ns.textContent || ns.innerHTML || '');
      if (prov) return prov;
    }
  }

  return null;
}

// ---------- Buscador profundo (incluye shadow DOM simple) ----------
function deepQueryAll(root, selector) {
  const out = [...root.querySelectorAll(selector)];
  const all = root.querySelectorAll('*');
  for (const el of all) {
    if (el.shadowRoot) {
      out.push(...el.shadowRoot.querySelectorAll(selector));
    }
  }
  return out;
}

// ---------- Puente MAIN->SW (fusiona meta del proveedor SIEMPRE) ----------
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__VIDHOOK__ || d.kind !== 'video') return;
  const prov = providerMetaFromHere();
  const meta = { ...(d.meta || {}), ...(prov || {}) };
  if (meta?.provider === 'yt' && meta.providerId) {
    const cand = ytThumbCandidates(meta.providerId);
    meta.thumb = meta.thumb || cand[0];
    meta.thumbCandidates = cand;
  }
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
    if (meta?.provider === 'yt' && meta.providerId) {
      const cand = ytThumbCandidates(meta.providerId);
      meta.thumb = meta.thumb || cand[0];
      meta.thumbCandidates = cand;
    }
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

    // ----------------- <video> / <source> -----------------
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

    // ----------------- Iframes (incluye lazy sin src) -----------------
    document.querySelectorAll('iframe').forEach(ifr => {
      let s = resolveUrl(String(ifr.getAttribute('src')||''));
      console.warn(`[VideoDetector] scanOnce: Found iframe. src is: "${s || '(empty)'}"`);
      chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_found_iframe', extra: { src: s || '(empty)', sent: s ? sentUrls.has(s) : false } }).catch(()=>{});

      // 0) Si no hay src (lazy puro), intentar adivinarlo
      if (!s || s.startsWith('about:blank') || s.startsWith('javascript:')) {
        const guess = guessLazyFromIframe(ifr);
        if (guess?.url) {
          const u = guess.url;
          if (!sentUrls.has(u)) {
            sentUrls.add(u);
            console.warn(`[VideoDetector] scanOnce: Sending videoFound (Lazy-guess): "${u}"`);
            const meta = { ...(guess.meta || {}) };
            if (meta?.provider === 'yt' && meta.providerId) {
              const cand = ytThumbCandidates(meta.providerId);
              meta.thumb = meta.thumb || cand[0];
              meta.thumbCandidates = cand;
            }
            chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-lazy-guess', src: u } }).catch(()=>{});
            chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'embed-lazy-guess', frameUrl: location.href, meta }).catch(()=>{});
          }
          return; // ya enviado por lazy-guess
        } else {
          // Nada que enviar aún (placeholder real). Esperamos a que asignen src más tarde.
          return;
        }
      }

      // Evitar duplicados
      if (sentUrls.has(s)) {
        console.warn(`[VideoDetector] scanOnce: Iframe skipped (already sent): "${s}"`);
        return;
      }

      // YouTube
      const y = ytIdFromURL(s);
      if (y) {
        console.warn(`[VideoDetector] scanOnce: Sending videoFound (YouTube): "${s}"`);
        const meta = { provider:'yt', providerId:y };
        const cand = ytThumbCandidates(y);
        meta.thumb = cand[0];
        meta.thumbCandidates = cand;
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-youtube', src: s } }).catch(()=>{});
        sentUrls.add(s);
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube', frameUrl: location.href, meta }).catch(()=>{});
        return; 
      }
      
      // Vimeo
      const vimeo = vimeoIdFromURL(s);
      if (vimeo) {
        console.warn(`[VideoDetector] scanOnce: Sending videoFound (Vimeo): "${s}"`);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-vimeo', src: s } }).catch(()=>{});
        sentUrls.add(s);
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta: { provider:'vimeo', providerId:vimeo }}).catch(()=>{});
        return;
      }

      // Dailymotion
      const dm = dmIdFromURL(s);
      if (dm) {
        console.warn(`[VideoDetector] scanOnce: Sending videoFound (Dailymotion): "${s}"`);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-dailymotion', src: s } }).catch(()=>{});
        sentUrls.add(s);
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta: { provider:'dm', providerId:dm }}).catch(()=>{});
        return;
      }

      // Desconocidos
      console.warn(`[VideoDetector] scanOnce: Sending videoFound (Unknown): "${s}"`);
      chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'embed-unknown', src: s } }).catch(()=>{});
      sentUrls.add(s);
      chrome.runtime.sendMessage({ 
          type:'videoFound', 
          url:s, 
          via:'embed-unknown',
          frameUrl: location.href, 
          meta: { ...(providerMetaFromHere()||{}), provider:'iframe' }
      }).catch(()=>{});
    });

    // ----------------- Buscador de LAZY-LOAD por data-* -----------------
    const lazyElements = document.querySelectorAll('[data-videoid], [data-ytid], [data-yt-id]');
    if (lazyElements.length > 0) {
      chrome.runtime.sendMessage({ 
        type: 'dbg.ping', 
        from: 'scanOnce_lazy_found_candidates', 
        extra: { count: lazyElements.length } 
      }).catch(()=>{});
    }
    lazyElements.forEach(el => {
      const videoId = el.dataset.videoid || el.dataset.ytid || el.dataset.ytId;
      chrome.runtime.sendMessage({ 
        type: 'dbg.ping', 
        from: 'scanOnce_lazy_candidate_check', 
        extra: { videoId: videoId || 'NULL', tagName: el.tagName, className: el.className } 
      }).catch(()=>{});
      if (!videoId || videoId === 'false') return;
      
      const s = `https://www.youtube-nocookie.com/embed/${videoId}`;
      if (sentUrls.has(s)) {
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_lazy_DUPLICATE', extra: { src: s } }).catch(()=>{});
        return;
      }

      console.warn(`[VideoDetector] scanOnce: Sending videoFound (Lazy-yt data-*): "${s}"`);
      const cand = ytThumbCandidates(videoId);
      sentUrls.add(s);
      chrome.runtime.sendMessage({ 
        type:'videoFound', 
        url:s, 
        via:'embed-youtube-lazy',
        frameUrl: location.href, 
        meta: { provider:'yt', providerId: videoId, thumb: cand[0], thumbCandidates: cand }
      }).catch(()=>{});
    });

    // ----------------- Miniaturas ytimg -> inferir ID y registrar (src/srcset/data-*/background) -----------------
    deepQueryAll(document,
      'img[src*="ytimg.com"], img[src*="img.youtube.com"], ' +
      'img[data-src*="ytimg.com"], img[data-lazy-src*="ytimg.com"], img[data-original*="ytimg.com"], ' +
      'img[data-thumb*="ytimg.com"], img[srcset*="ytimg.com"], img[data-srcset*="ytimg.com"], ' +
      '[style*="ytimg.com"]'
    ).forEach(img=>{
      const urlOrSet = pickFromSrcOrSrcset(img) || img.getAttribute('src') || img.getAttribute('data-src') || '';
      const m = urlOrSet && String(urlOrSet).match(YT_IMG_RE);
      if (!m) return;

      const id = m[1];
      const s  = `https://www.youtube-nocookie.com/embed/${id}`;
      if (sentUrls.has(s)) return;
      sentUrls.add(s);

      const thumbs = ytThumbCandidates(id);
      chrome.runtime.sendMessage({
        type:'videoFound',
        url:s,
        via:'ytimg-thumb',
        frameUrl: location.href,
        meta:{ provider:'yt', providerId:id, thumb:urlOrSet || thumbs[0], thumbCandidates: thumbs }
      }).catch(()=>{});
    });

    // ----------------- <link rel="preload" as="video"> -----------------
    document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{
      const u = resolveUrl(String(l.getAttribute('href')));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'scanOnce_SENDING_videoFound', extra: { via: 'preload-link', src: u } }).catch(()=>{});
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'preload-link', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      }
    });

    // ----------------- OpenGraph: og:video -----------------
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

// ----------------- MutationObserver con throttle -----------------
let _scanScheduled = false;
const scanObserver = new MutationObserver(() => {
  if (_scanScheduled) return;
  _scanScheduled = true;
  setTimeout(() => { _scanScheduled = false; scanOnce(); }, 60); // coalesce mutaciones
});

// Observar cambios en atributos (como 'src') y la adición/eliminación de nodos
try {
  scanObserver.observe(document.documentElement || document, { 
    childList: true,    // Vigila si se añaden/quitan elementos
    subtree: true,      // Vigila en todo el documento
    attributes: true,   // Vigila cambios de atributos
    attributeFilter: ['src','srcdoc','poster','data-src','data-lazy-src','data-embed','data-url','data-href','data-videoid','data-ytid','data-yt-id','style']
  });
} catch(e) {
  // fallback por si algún documento no permite observar atributos
  scanObserver.observe(document, { childList:true, subtree:true });
}

scanOnce(); // Ejecutar el escaneo inicial

// ####################################################################
// ### VOLCADO DE DOM (debug de elementos multimedia) ###
// ####################################################################
(function() {
  if (window.myDomDebugScannerHasRun) return;
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
    }).catch(()=>{});
  } catch (e) {
    try {
      chrome.runtime.sendMessage({ 
        type: 'dbg.contentScriptError',
        error: `[DomDebugScanner] ${e?.message || String(e)}`,
        frameUrl: window.location.href
      }).catch(()=>{});
    } catch(e2) {
      console.error('Error en DomDebugScanner y al reportarlo:', e, e2);
    }
  }
})();

// ===================== fin content.js =====================
