// Inyecta el hook en MAIN world para este frame
chrome.runtime.sendMessage({ type: 'ensureHook' }).catch(()=>{});

// Reenvía hallazgos del hook MAIN->SW
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__VIDHOOK__ || d.kind !== 'video') return;
  chrome.runtime.sendMessage({
    type: 'videoFound',
    url: String(d.url || ''),
    via: d.via || 'hook',
    frameUrl: location.href,
    meta: d.meta || null
  }).catch(()=>{});
}, false);

// ---------- Helpers proveedor/thumbnail ----------
function ytIdFromHere() {
  try {
    const u = new URL(location.href);
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
      if (u.pathname === '/watch') return u.searchParams.get('v');
    }
  } catch {}
  return null;
}
function providerMetaFromHere() {
  const y = ytIdFromHere();
  if (y) return { provider: 'yt', providerId: y, thumb: `https://img.youtube.com/vi/${y}/hqdefault.jpg` };
  // (Vimeo/Dailymotion pueden añadirse; miniaturas requieren API pública, aquí dejamos provider/id para deduplicar)
  try {
    const u = new URL(location.href);
    if (u.hostname === 'player.vimeo.com' && u.pathname.startsWith('/video/')) {
      return { provider: 'vimeo', providerId: u.pathname.split('/')[2] || null };
    }
    if (u.hostname === 'www.dailymotion.com' && u.pathname.startsWith('/embed/video/')) {
      return { provider: 'dm', providerId: u.pathname.split('/')[3] || null };
    }
  } catch {}
  return null;
}

function captureThumbIfPossible(v) {
  try {
    // 1) poster del <video>
    const poster = v.getAttribute('poster');
    if (poster) return { thumb: poster };

    // 2) snapshot (CORS puede bloquear). Escala a ancho 320 px.
    if (v.videoWidth && v.videoHeight && v.readyState >= 2) {
      const ratio = v.videoWidth / v.videoHeight;
      const w = 320, h = Math.max(1, Math.round(w / ratio));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, w, h);
      const data = c.toDataURL('image/jpeg', 0.6);
      // límite ~300KB para no saturar
      if (data.length < 350000) return { thumb: data };
    }
  } catch { /* CORS/DRM */ }
  return {};
}

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

  v.addEventListener('loadedmetadata', () => send(true), { passive: true });
  v.addEventListener('play', () => send(false), { passive: true });
  v.addEventListener('pause', () => send(false), { passive: true });
  v.addEventListener('ended', () => send(false), { passive: true });

  // primer snapshot + intento de miniatura
  setTimeout(() => send(true), 0);
}

// Escaneo inicial + mutaciones
function scanOnce() {
  try {
    document.querySelectorAll('video').forEach(v => {
      wireVideo(v);
      const u = v.currentSrc || v.src; if (u) chrome.runtime.sendMessage({ type:'videoFound', url:String(u), via:'video-tag', frameUrl: location.href, meta: providerMetaFromHere()||null }).catch(()=>{});
      v.querySelectorAll('source').forEach(s => s.src && chrome.runtime.sendMessage({ type:'videoFound', url:String(s.src), via:'source-tag', frameUrl: location.href, meta: providerMetaFromHere()||null }).catch(()=>{}));
    });

    // Embeds visibles desde este frame (p.ej. el frame padre)
    document.querySelectorAll('iframe[src]').forEach(ifr => {
      const s = String(ifr.getAttribute('src')||'');
      // YouTube → añade meta con thumb directa
      const y = (()=>{ try{ const u=new URL(s); if (u.hostname.endsWith('youtube.com')) { if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2]||null; if (u.pathname==='/watch') return u.searchParams.get('v'); if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2]||null; } }catch{} return null; })();
      if (y) chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-youtube', frameUrl: location.href, meta: { provider:'yt', providerId:y, thumb:`https://img.youtube.com/vi/${y}/hqdefault.jpg` }});

      const vimeo = (()=>{ try{ const u=new URL(s); if (u.hostname==='player.vimeo.com' && u.pathname.startsWith('/video/')) return u.pathname.split('/')[2]||null; }catch{} return null; })();
      if (vimeo) chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-vimeo', frameUrl: location.href, meta: { provider:'vimeo', providerId:vimeo }});

      const dm = (()=>{ try{ const u=new URL(s); if (u.hostname==='www.dailymotion.com' && u.pathname.startsWith('/embed/video/')) return u.pathname.split('/')[3]||null; }catch{} return null; })();
      if (dm) chrome.runtime.sendMessage({ type:'videoFound', url:s, via:'embed-dailymotion', frameUrl: location.href, meta: { provider:'dm', providerId:dm }});
    });

    document.querySelectorAll('link[rel="preload"][as="video"]').forEach(l=>{
      const u = l.getAttribute('href'); if (u) chrome.runtime.sendMessage({ type:'videoFound', url:String(u), via:'preload-link', frameUrl: location.href, meta: providerMetaFromHere()||null }).catch(()=>{});
    });

    const og = document.querySelector('meta[property="og:video"], meta[name="og:video"]');
    if (og?.content) chrome.runtime.sendMessage({ type:'videoFound', url:String(og.content), via:'og:video', frameUrl: location.href, meta: providerMetaFromHere()||null }).catch(()=>{});
  } catch {}
}

new MutationObserver(scanOnce).observe(document, { childList:true, subtree:true });
scanOnce();
