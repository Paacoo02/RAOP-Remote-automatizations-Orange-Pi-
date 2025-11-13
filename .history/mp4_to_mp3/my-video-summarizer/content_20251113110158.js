// Fichero: content.js

// --- Helpers de Identificación ---
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

// --- Conjunto para evitar duplicados EN ESTE FRAME ---
const sentUrls = new Set();
const currentFrameUrl = location.href;

// --- Función Principal de Escaneo ---
function scanPageForVideos() {
  
  // DEBUG: Anuncia que este frame se está escaneando
  console.warn(`[VideoDetector] scanPageForVideos ejecutándose en: ${currentFrameUrl}`);
  chrome.runtime.sendMessage({ 
    type: 'dbg.ping', 
    from: 'scanPageForVideos', 
    extra: { frameUrl: currentFrameUrl } 
  }).catch(()=>{});

  // 1. Buscar <video> y <source>
  document.querySelectorAll('video').forEach(v => {
    const u = resolveUrl(v.currentSrc || v.src);
    if (u && !sentUrls.has(u)) {
      sentUrls.add(u);
      chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'video-tag', frameUrl: currentFrameUrl, meta: {} }).catch(()=>{});
    }
    v.querySelectorAll('source').forEach(s => {
      const uSrc = resolveUrl(s.src);
      if (uSrc && !sentUrls.has(uSrc)) {
        sentUrls.add(uSrc);
        chrome.runtime.sendMessage({ type:'videoFound', url:uSrc, via:'source-tag', frameUrl: currentFrameUrl, meta: null }).catch(()=>{});
      }
    });
  });

  // 2. Buscar <iframe>
  document.querySelectorAll('iframe').forEach(ifr => {
    const s = resolveUrl(ifr.getAttribute('src') || '');
    if (!s || s.startsWith('about:blank') || s.startsWith('javascript:')) return;
    if (sentUrls.has(s)) return;

    let provider = null;
    let providerId = null;
    let thumb = null;
    let via = 'embed-unknown';

    // YouTube
    const y = ytIdFromURL(s);
    if (y) {
      provider = 'yt';
      providerId = y;
      thumb = `https://img.youtube.com/vi/${y}/hqdefault.jpg`;
      via = 'embed-youtube';
    }
    
    // Vimeo
    const vimeo = vimeoIdFromURL(s);
    if (vimeo) {
      provider = 'vimeo';
      providerId = vimeo;
      via = 'embed-vimeo';
    }

    // Dailymotion
    const dm = dmIdFromURL(s);
    if (dm) {
      provider = 'dm';
      providerId = dm;
      via = 'embed-dailymotion';
    }

    // Enviar CUALQUIER iframe con un src válido
    sentUrls.add(s);
    chrome.runtime.sendMessage({ 
        type:'videoFound', 
        url:s, 
        via: via,
        frameUrl: currentFrameUrl, 
        meta: { provider, providerId, thumb }
    }).catch(()=>{});
  });

  // 3. Buscar datos <meta> (solo en el frame principal)
  if (window.top === window.self) {
    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    if (og?.content) {
      const u = resolveUrl(String(og.content));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'og:video', frameUrl: currentFrameUrl, meta: null }).catch(()=>{});
      }
    }
  }
}

// --- Ejecución ---

// 1. Inyectar el hook (solo en el frame principal)
if (window.top === window.self) {
  chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});
}

// 2. Ejecutar el escaneo
// Como "run_at" es "document_idle", el DOM debería estar listo.
scanPageForVideos();

// 3. Volcado de DOM (nuestro debug original)
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
    });
  } catch (e) {
    chrome.runtime.sendMessage({ 
      type: 'dbg.contentScriptError',
      error: `[DomDebugScanner] ${e?.message || String(e)}`,
      frameUrl: window.location.href
    }).catch(()=>{});
  }
})();