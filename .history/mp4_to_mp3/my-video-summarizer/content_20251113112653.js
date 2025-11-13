// ======================= content.js =======================
// Requisitos en manifest: "all_frames": true, "match_about_blank": true, "run_at": "document_idle"

// Inyecta el hook en MAIN world para este frame (si tienes page-hook)
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// ----------------- Utilidades de debug -----------------
const dbg = (tag, extra={})=>{
  try { chrome.runtime.sendMessage({ type:'dbg.ping', from: tag, extra }); } catch {}
};

// ----------------- Helpers proveedor/thumbnail -----------------
function ytIdFromURL(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
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

function providerMetaFromHere() {
  let id = ytIdFromURL(location.href);
  if (id) return { provider:'yt', providerId:id, thumb:`https://img.youtube.com/vi/${id}/hqdefault.jpg` };

  let vimeo = vimeoIdFromURL(location.href);
  if (vimeo) return { provider:'vimeo', providerId:vimeo };

  let dm = dmIdFromURL(location.href);
  if (dm) return { provider:'dm', providerId:dm };

  try {
    if (document.referrer) {
      id = ytIdFromURL(document.referrer);
      if (id) return { provider:'yt', providerId:id, thumb:`https://img.youtube.com/vi/${id}/hqdefault.jpg` };
      vimeo = vimeoIdFromURL(document.referrer);
      if (vimeo) return { provider:'vimeo', providerId:vimeo };
      dm = dmIdFromURL(document.referrer);
      if (dm) return { provider:'dm', providerId:dm };
    }
  } catch {}
  return null;
}

function resolveUrl(url) {
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('http:') || url.startsWith('https:')) return url;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (url.startsWith('//')) return location.protocol + url;
  try { return new URL(url, location.href).href; } catch { return url; }
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
  } catch (e) { console.warn('[VideoDetector] thumb CORS/err', e); }
  return {};
}

// ---------- Heurísticas para iframes lazy ----------
const YT_ID_RE    = /^[A-Za-z0-9_-]{8,15}$/;
const YT_EMBED_RE = /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{8,15})/i;
const YT_LINK_RE  = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{8,15})/i;
const YT_IMG_RE   = /https?:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\/vi\/([A-Za-z0-9_-]{8,15})\//i;

function buildProviderFromUrl(u) {
  const y = ytIdFromURL(u) || (YT_EMBED_RE.exec(u)?.[1]) || (YT_LINK_RE.exec(u)?.[1]);
  if (y) return { url:`https://www.youtube-nocookie.com/embed/${y}`, meta:{ provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` } };
  const v = vimeoIdFromURL(u); if (v) return { url:u, meta:{ provider:'vimeo', providerId:v } };
  const d = dmIdFromURL(u);    if (d) return { url:u, meta:{ provider:'dm', providerId:d } };
  return null;
}

function extractFirstEmbedFromHTML(html) {
  if (!html) return null;
  const mImg = html.match(YT_IMG_RE);
  if (mImg) return buildProviderFromUrl(`https://www.youtube-nocookie.com/embed/${mImg[1]}`);
  const mSrc = html.match(/src\s*=\s*["']([^"']+)["']/i);
  if (mSrc) { const prov = buildProviderFromUrl(resolveUrl(mSrc[1])); if (prov) return prov; }
  const mHref = html.match(/href\s*=\s*["']([^"']+)["']/i);
  if (mHref){ const prov = buildProviderFromUrl(resolveUrl(mHref[1])); if (prov) return prov; }
  const mUrl = html.match(/https?:\/\/[^\s"'<>]+/g);
  if (mUrl) for (const raw of mUrl) { const prov = buildProviderFromUrl(resolveUrl(raw)); if (prov) return prov; }
  return null;
}

function guessLazyFromIframe(ifr) {
  // data-* conocidos + Litespeed, etc.
  const attrs = [
    'data-src','data-lazy-src','data-embed','data-url','data-href','data-original',
    'data-iframe','data-src-iframe','data-ytid','data-youtube-id','data-videoid','data-vid',
    'data-oembed','data-litespeed-src'
  ];
  for (const a of attrs) {
    const val = ifr.getAttribute(a);
    if (val) {
      if (YT_ID_RE.test(val)) return { url:`https://www.youtube-nocookie.com/embed/${val}`, meta:{ provider:'yt', providerId:val, thumb:`https://img.youtube.com/vi/${val}/hqdefault.jpg` } };
      const prov = buildProviderFromUrl(resolveUrl(val)); if (prov) return prov;
    }
  }

  const srcdoc = ifr.getAttribute('srcdoc');
  if (srcdoc) { const prov = extractFirstEmbedFromHTML(srcdoc); if (prov) return prov; }

  // alrededor del iframe
  const wrap = ifr.closest('[data-ytid],[data-videoid],[data-yt-id], .wp-block-embed, .embed-youtube, .youtube-player, .elementor-widget-video, .jetpack-video-wrapper, figure, .video, .embed, .lite-yt, .lyte');
  if (wrap) {
    const vid = wrap.getAttribute('data-ytid') || wrap.getAttribute('data-videoid') || wrap.getAttribute('data-yt-id');
    if (vid && YT_ID_RE.test(vid)) return { url:`https://www.youtube-nocookie.com/embed/${vid}`, meta:{ provider:'yt', providerId:vid, thumb:`https://img.youtube.com/vi/${vid}/hqdefault.jpg` } };
    // enlaces dentro
    const a = wrap.querySelector('a[href*="youtube.com"],a[href*="youtu.be"],a[href*="vimeo.com"],a[href*="dailymotion.com"]');
    if (a?.href) { const prov = buildProviderFromUrl(resolveUrl(a.href)); if (prov) return prov; }
    // imagen miniatura ytimg
    const img = wrap.querySelector('img[src*="ytimg.com"], img[src*="img.youtube.com"]');
    if (img?.src) {
      const m = img.src.match(YT_IMG_RE);
      if (m) return { url:`https://www.youtube-nocookie.com/embed/${m[1]}`, meta:{ provider:'yt', providerId:m[1], thumb:img.src } };
    }
    // background-image con ytimg
    const bg = getComputedStyle(wrap).backgroundImage;
    const mb = bg && bg.match(YT_IMG_RE);
    if (mb) return { url:`https://www.youtube-nocookie.com/embed/${mb[1]}`, meta:{ provider:'yt', providerId:mb[1], thumb:`https://img.youtube.com/vi/${mb[1]}/hqdefault.jpg` } };
    // noscript
    const ns = wrap.querySelector('noscript');
    if (ns) { const prov = extractFirstEmbedFromHTML(ns.textContent || ns.innerHTML || ''); if (prov) return prov; }
  }

  // microdatos / ld+json cercanos
  const meta = ifr.parentElement?.querySelector('meta[itemprop="embedUrl"]');
  if (meta?.content) { const prov = buildProviderFromUrl(resolveUrl(meta.content)); if (prov) return prov; }

  const scriptLd = ifr.parentElement?.querySelector('script[type="application/ld+json"]');
  if (scriptLd?.textContent) {
    const prov = extractFirstEmbedFromHTML(scriptLd.textContent); if (prov) return prov;
    const m = scriptLd.textContent.match(/"embedUrl"\s*:\s*"([^"]+)"/i);
    if (m) { const p = buildProviderFromUrl(resolveUrl(m[1])); if (p) return p; }
  }

  return null;
}

// ---------- Búsqueda profunda con Shadow DOM abiertos ----------
function* iterateShadowHosts(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = /** @type {Element} */(walker.currentNode);
    if (el.shadowRoot) yield el;
  }
}

function deepQueryAll(root, selector) {
  const out = Array.from(root.querySelectorAll(selector));
  for (const host of iterateShadowHosts(root)) {
    out.push(...deepQueryAll(host.shadowRoot, selector));
  }
  return out;
}

// Observación profunda (documento + todos los shadow roots "open")
const seenShadowRoots = new WeakSet();
const observerOptions = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src','srcdoc','poster','data-src','data-lazy-src','data-embed','data-url','data-href','data-videoid','data-ytid','data-yt-id','data-oembed','data-litespeed-src']
};
function observeDeep(root) {
  try {
    scanObserver.observe(root, observerOptions);
  } catch {}
  for (const host of iterateShadowHosts(root)) {
    const sr = host.shadowRoot;
    if (sr && !seenShadowRoots.has(sr)) {
      seenShadowRoots.add(sr);
      try { scanObserver.observe(sr, observerOptions); } catch {}
      // Recursivo
      observeDeep(sr);
    }
  }
}

function pollNewShadowRoots() {
  // Por si se crean shadow roots tras insertar el host (muy común)
  for (const host of deepQueryAll(document, '*')) {
    if (host.shadowRoot && !seenShadowRoots.has(host.shadowRoot)) {
      dbg('shadow-root-new');
      observeDeep(host.shadowRoot);
      // una pasada de escaneo tras enganchar
      scheduleScanSoon();
    }
  }
}

// ---------- Puente MAIN->SW (desde page-hook si lo tienes) ----------
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

// ---------- Estado de los <video> ----------
function snapshot(v) {
  return {
    url: resolveUrl(v.currentSrc || v.src || ''),
    paused: v.paused, muted: v.muted, volume: v.volume,
    readyState: v.readyState,
    duration: Number.isFinite(v.duration) ? v.duration : null,
    currentTime: v.currentTime,
    width: v.videoWidth, height: v.videoHeight,
    autoplay: !!v.autoplay, controls: !!v.controls,
    frameUrl: location.href, playing: !v.paused, ts: Date.now()
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
    chrome.runtime.sendMessage({ type:'videoState', state, meta }).catch(()=>{});
  };
  if (v.readyState >= 2) send(true);
  else v.addEventListener('loadedmetadata', () => send(true), { passive:true, once:true });
  v.addEventListener('play',  () => send(false), { passive:true });
  v.addEventListener('pause', () => send(false), { passive:true });
  v.addEventListener('ended', () => send(false), { passive:true });
  setTimeout(() => send(false), 0);
}

// ---------- Escaneo inicial + mutaciones ----------
const sentUrls = new Set();

function scanOnce(root=document) {
  dbg('scanOnce');
  try {
    const prov = providerMetaFromHere();

    // ---- <video>/<source> (deep) ----
    deepQueryAll(root, 'video').forEach(v => {
      wireVideo(v);
      const u = resolveUrl(String(v.currentSrc || v.src));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        dbg('scanOnce_SENDING_videoFound', { via:'video-tag', src:u });
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'video-tag', frameUrl: location.href, meta:{...prov, ...captureThumbIfPossible(v)} }).catch(()=>{});
      }
      v.querySelectorAll('source').forEach(s=>{
        const uSrc = resolveUrl(String(s.src));
        if (uSrc && !sentUrls.has(uSrc)) {
          sentUrls.add(uSrc);
          dbg('scanOnce_SENDING_videoFound', { via:'source-tag', src:uSrc });
          chrome.runtime.sendMessage({ type:'videoFound', url:uSrc, via:'source-tag', frameUrl: location.href, meta:prov||null }).catch(()=>{});
        }
      });
    });

    // ---- Iframes (deep), incluyendo sin src ----
    deepQueryAll(root, 'iframe').forEach(ifr => {
      let s = resolveUrl(String(ifr.getAttribute('src')||''));
      dbg('scanOnce_found_iframe', { src: s || '(empty)', class: ifr.className });

      if (!s || s.startsWith('about:blank') || s.startsWith('javascript:')) {
        const guess = guessLazyFromIframe(ifr);
        if (guess?.url && !sentUrls.has(guess.url)) {
          sentUrls.add(guess.url);
          dbg('scanOnce_SENDING_videoFound', { via:'embed-lazy-guess', src: guess.url });
          chrome.runtime.sendMessage({ type:'videoFound', url:guess.url, via:'embed-lazy-guess', frameUrl: location.href, meta: guess.meta }).catch(()=>{});
        }
        return;
      }

      if (sentUrls.has(s)) return;

      const y = ytIdFromURL(s);
      if (y) {
        sentUrls.add(s);
        dbg('scanOnce_SENDING_videoFound', { via:'embed-youtube', src:s });
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube', frameUrl: location.href, meta:{ provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` } }).catch(()=>{});
        return;
      }
      const vimeo = vimeoIdFromURL(s);
      if (vimeo) {
        sentUrls.add(s);
        dbg('scanOnce_SENDING_videoFound', { via:'embed-vimeo', src:s });
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta:{ provider:'vimeo', providerId:vimeo } }).catch(()=>{});
        return;
      }
      const dm = dmIdFromURL(s);
      if (dm) {
        sentUrls.add(s);
        dbg('scanOnce_SENDING_videoFound', { via:'embed-dailymotion', src:s });
        chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta:{ provider:'dm', providerId:dm } }).catch(()=>{});
        return;
      }

      sentUrls.add(s);
      dbg('scanOnce_SENDING_videoFound', { via:'embed-unknown', src:s });
      chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-unknown', frameUrl: location.href, meta:{ ...(prov||{}), provider:'iframe' } }).catch(()=>{});
    });

    // ---- Data-* sueltos (deep) ----
    deepQueryAll(root, '[data-videoid], [data-ytid], [data-yt-id]').forEach(el=>{
      const videoId = el.dataset.videoid || el.dataset.ytid || el.dataset.ytId;
      dbg('scanOnce_lazy_candidate_check', { videoId: videoId || 'NULL', tagName: el.tagName, className: el.className });
      if (!videoId || !YT_ID_RE.test(videoId)) return;
      const s = `https://www.youtube-nocookie.com/embed/${videoId}`;
      if (sentUrls.has(s)) return;
      sentUrls.add(s);
      dbg('scanOnce_SENDING_videoFound', { via:'embed-youtube-lazy', src:s });
      chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube-lazy', frameUrl: location.href, meta:{ provider:'yt', providerId:videoId, thumb:`https://img.youtube.com/vi/${videoId}/hqdefault.jpg` } }).catch(()=>{});
    });

    // ---- Miniaturas ytimg (deep) -> inferir ID ----
    deepQueryAll(root, 'img[src*="ytimg.com"], img[src*="img.youtube.com"]').forEach(img=>{
      const m = img.src && img.src.match(YT_IMG_RE);
      if (!m) return;
      const s = `https://www.youtube-nocookie.com/embed/${m[1]}`;
      if (sentUrls.has(s)) return;
      sentUrls.add(s);
      dbg('scanOnce_SENDING_videoFound', { via:'ytimg-thumb', src:s });
      chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'ytimg-thumb', frameUrl: location.href, meta:{ provider:'yt', providerId:m[1], thumb: img.src } }).catch(()=>{});
    });

    // ---- <link rel="preload" as="video"> (deep) ----
    deepQueryAll(root, 'link[rel="preload"][as="video"]').forEach(l=>{
      const u = resolveUrl(String(l.getAttribute('href')));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        dbg('scanOnce_SENDING_videoFound', { via:'preload-link', src:u });
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'preload-link', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      }
    });

    // ---- OpenGraph ----
    deepQueryAll(root, 'meta[property="og:video"], meta[name="og:video"]').forEach(og=>{
      const u = resolveUrl(String(og.content||''));
      if (u && !sentUrls.has(u)) {
        sentUrls.add(u);
        dbg('scanOnce_SENDING_videoFound', { via:'og:video', src:u });
        chrome.runtime.sendMessage({ type:'videoFound', url:u, via:'og:video', frameUrl: location.href, meta: prov||null }).catch(()=>{});
      }
    });

    // ---- Scripts con URLs de embed (solo los del documento principal) ----
    if (root === document) {
      const scripts = Array.from(document.scripts).filter(s=>!s.src && s.textContent && s.textContent.length < 2_000_000);
      for (const s of scripts) {
        const prov = extractFirstEmbedFromHTML(s.textContent);
        if (prov?.url && !sentUrls.has(prov.url)) {
          sentUrls.add(prov.url);
          dbg('scanOnce_SENDING_videoFound', { via:'script-embed', src: prov.url });
          chrome.runtime.sendMessage({ type:'videoFound', url:prov.url, via:'script-embed', frameUrl: location.href, meta: prov.meta }).catch(()=>{});
          break;
        }
      }
    }

  } catch(e) {
    console.error('[VideoDetector] Error en scanOnce:', e);
    try { chrome.runtime.sendMessage({ type:'dbg.contentScriptError', error:`[scanOnce] ${e?.message || String(e)}`, frameUrl: window.location.href }); } catch {}
  }
}

// ----------------- MutationObserver con throttle -----------------
let _scanScheduled = false;
const scanObserver = new MutationObserver((muts) => {
  // Enganchar nuevos shadow roots abiertos si aparecen
  for (const m of muts) {
    for (const n of m.addedNodes || []) {
      if (n && n.nodeType === 1) {
        const el = /** @type {Element} */(n);
        if (el.shadowRoot) observeDeep(el.shadowRoot);
      }
    }
  }
  scheduleScanSoon();
});
function scheduleScanSoon() {
  if (_scanScheduled) return;
  _scanScheduled = true;
  setTimeout(() => { _scanScheduled = false; scanOnce(); }, 80);
}

// Empezar a observar documento y shadow roots ya presentes
try { observeDeep(document); } catch {}
// Pequeño poll para cazar shadow roots que aparezcan tarde
setInterval(pollNewShadowRoots, 600);

// Escaneo inicial
scanOnce();

// ----------------- Volcado de DOM (debug) -----------------
(function dumpMediaOnce(){
  if (window.__myDomDebugScannerHasRun) return;
  window.__myDomDebugScannerHasRun = true;
  try {
    const media = deepQueryAll(document, 'video, iframe, object, embed');
    const html = media.map(el => {
      try { return el.outerHTML; } catch { return `<${el.tagName.toLowerCase()}>`; }
    });
    chrome.runtime.sendMessage({ type:'dbg.foundMediaElements', elements: html, count: html.length, frameUrl: location.href }).catch(()=>{});
  } catch(e) {
    try { chrome.runtime.sendMessage({ type:'dbg.contentScriptError', error:`[DomDebugScanner] ${e?.message || String(e)}`, frameUrl: window.location.href }); } catch {}
  }
})();

// ===================== fin content.js =====================
// Notas:
// - Si el sitio usa Shadow DOM "cerrado", solo el page-hook en MAIN world puede ver dentro.
// - Con esto deberías ver aparecer eventos via: embed-lazy-guess, ytimg-thumb o script-embed,
//   incluso si el <iframe> visible no trae src hasta más tarde.
