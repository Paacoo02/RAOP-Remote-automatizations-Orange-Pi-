(() => {
  const RX_MEDIA = /\.(m3u8|mpd|mp4|m4v|webm|m4s|ts|mov)(\?|#|$)/i;
  const post = (url, via, meta) => { try{ window.postMessage({ __VIDHOOK__: true, kind:'video', url, via, meta: meta||null }, '*'); }catch{} };
  const S = (x) => { try { return String(x||''); } catch { return ''; } };

  // fetch
  try {
    const _f = window.fetch;
    window.fetch = async function(...args) {
      try { const u = S(args?.[0]?.url || args?.[0]); if (RX_MEDIA.test(u)) post(u,'fetch'); } catch {}
      const res = await _f.apply(this, args);
      try {
        const u = S(res?.url); const ct = res?.headers?.get?.('content-type') || '';
        if (RX_MEDIA.test(u) || /^video\//i.test(ct) || /application\/(vnd\.apple\.mpegurl|x-mpegURL|dash\+xml)/i.test(ct)) post(u,'fetch(res)', { ct });
      } catch {}
      return res;
    };
  } catch {}

  // XHR
  try {
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, url, ...rest) { try{ const u=S(url); if (RX_MEDIA.test(u)) this.__vidext_url = u; }catch{} return _open.call(this, m, url, ...rest); };
    XMLHttpRequest.prototype.send = function(...args) {
      try { if (this.__vidext_url) post(this.__vidext_url,'xhr'); } catch {}
      this.addEventListener('load', () => {
        try {
          const u = S(this.responseURL || this.__vidext_url);
          const ct = this.getResponseHeader('content-type') || '';
          if (RX_MEDIA.test(u) || /^video\//i.test(ct) || /application\/(vnd\.apple\.mpegurl|x-mpegURL|dash\+xml)/i.test(ct)) post(u,'xhr(load)', { ct });
        } catch {}
      });
      return _send.apply(this, args);
    };
  } catch {}

  // Hls.js
  try {
    const wrapHls = () => {
      if (!window.Hls || !window.Hls.isSupported) return;
      const _load = window.Hls.prototype.loadSource;
      if (_load && !_load.__vidext_wrapped) {
        window.Hls.prototype.loadSource = function(url){ try { post(S(url),'hls.loadSource'); } catch {}; return _load.apply(this, arguments); };
        window.Hls.prototype.loadSource.__vidext_wrapped = true;
      }
    };
    wrapHls();
    Object.defineProperty(window,'Hls',{ configurable:true, set(v){ Object.defineProperty(window,'Hls',{ value:v, writable:true, configurable:true }); try{ const _=v?.prototype?.loadSource; if (_&&!_.__vidext_wrapped){ v.prototype.loadSource=function(u){ try{ post(S(u),'hls.loadSource'); }catch{} return _.apply(this,arguments); }; v.prototype.loadSource.__vidext_wrapped=true; } }catch{} }, get(){ return undefined; } });
  } catch {}

  // Shaka
  try {
    const wrapShaka = () => {
      const P = (window.shaka||window.ShakaPlayer||window.shakaPlayer)?.Player;
      if (!P) return;
      const _load = P.prototype.load;
      if (_load && !_load.__vidext_wrapped) {
        P.prototype.load = function(url){ try { post(S(url),'shaka.load'); } catch {}; return _load.apply(this, arguments); };
        P.prototype.load.__vidext_wrapped = true;
      }
    };
    wrapShaka();
    Object.defineProperty(window,'shaka',{ configurable:true, set(v){ Object.defineProperty(window,'shaka',{ value:v, writable:true, configurable:true }); try{ const P=v?.Player, _=P&&P.prototype.load; if(_&&!_.__vidext_wrapped){ P.prototype.load=function(u){ try{ post(S(u),'shaka.load'); }catch{} return _.apply(this,arguments); }; P.prototype.load.__vidext_wrapped=true; } }catch{} }, get(){ return undefined; } });
  } catch {}

  // MSE / blob:
  try {
    const _add = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function(mime){ try{ post('mediasource:'+String(mime||''), 'MediaSource.addSourceBuffer', { mime }); }catch{} return _add.apply(this, arguments); };
  } catch {}
  try {
    const _createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(obj){ const u=_createObjectURL.apply(this, arguments); try{ if (obj && (obj instanceof MediaSource)) post(String(u), 'createObjectURL(MediaSource)'); }catch{} return u; };
  } catch {}

  // Señal play()
  try {
    const _play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ try{ const u=this.currentSrc||this.src||''; if (u) post(String(u),'media.play'); }catch{} return _play.apply(this, arguments); };
  } catch {}

  // Descubrimiento inicial
  const scan = () => {
    try {
      document.querySelectorAll('video').forEach(v=>{
        const u=v.currentSrc||v.src; if (u) post(S(u),'video-tag');
        v.querySelectorAll('source').forEach(s=> s.src && post(S(s.src),'source-tag'));
      });
      document.querySelectorAll('iframe[src]').forEach(ifr=>{
        const s=String(ifr.getAttribute('src')||'');
        if (/youtube\.com\/(embed|watch|shorts)/i.test(s)) post(s,'embed-youtube');
        if (/player\.vimeo\.com\/video\//i.test(s)) post(s,'embed-vimeo');
        if (/dailymotion\.com\/embed\/video\//i.test(s)) post(s,'embed-dailymotion');
      });
      document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{ const u=l.getAttribute('href'); if (u) post(S(u),'preload-link'); });
      const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
      if (og?.content) post(S(og.content),'og:video');
    } catch {}
  };
  scan();
  new MutationObserver(scan).observe(document,{childList:true,subtree:true});
})();
