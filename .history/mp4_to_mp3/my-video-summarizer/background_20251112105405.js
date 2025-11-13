// ============== Log corto ==============
const LOG = [];
const L = (...a) => { const s = `[${new Date().toISOString()}] ${a.map(x=>{try{return typeof x==='object'?JSON.stringify(x):String(x);}catch{return String(x);}}).join(' ')}`; console.log('[vidext]', ...a); LOG.push(s); if (LOG.length>400) LOG.shift(); };

// ============== Estado por pestaña ==============
const videosByTab = new Map();    // tabId -> entries[]
const indexByTab = new Map();     // tabId -> Map(key -> idx)
const injectedFrames = new Set(); // `${tabId}:${frameId}`
const stateByTab = new Map();     // tabId -> Map(url -> state)

function setBadge(tabId, n){ try{chrome.action.setBadgeBackgroundColor({tabId,color:n?'#0b8457':'#777'}); chrome.action.setBadgeText({tabId,text:n?String(n):''});}catch{} }

// ============== Clasificación y claves canónicas ==============
function classify(url, ct) {
  const u = String(url||'');
  if (/\.(mp4|m4v|webm|mov|mkv|flv|avi)(\?|#|$)/i.test(u) || (ct && /^video\//i.test(ct))) return 'direct';
  if (/\.(m3u8)(\?|#|$)/i.test(u) || (ct && /application\/(vnd\.apple\.mpegurl|x-mpegURL)/i.test(ct))) return 'hls';
  if (/\.(mpd)(\?|#|$)/i.test(u) || (ct && /application\/dash\+xml/i.test(ct))) return 'dash';
  if (/^https?:\/\/((www|m|music)\.)?youtube\.com\/(embed|watch|shorts)/i.test(u)) return 'embed-youtube';
  if (/^https?:\/\/player\.vimeo\.com\/video\//i.test(u)) return 'embed-vimeo';
  if (/^https?:\/\/www\.dailymotion\.com\/embed\/video\//i.test(u)) return 'embed-dailymotion';
  if (/\.(m4s|ts|frag|cmfv|cmfa)(\?|#|$)/i.test(u)) return 'segment';
  if (u.startsWith('blob:')) return 'mse-blob';
  return 'unknown';
}

function ytId(s) {
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
      if (u.pathname === '/watch') return u.searchParams.get('v');
    }
  } catch {}
  return null;
}
function vimeoId(s) {
  try {
    const u = new URL(s);
    if (u.hostname === 'player.vimeo.com' && u.pathname.startsWith('/video/')) {
      const id = u.pathname.split('/')[2]; return id || null;
    }
  } catch {}
  return null;
}
function dailymotionId(s) {
  try {
    const u = new URL(s);
    if (u.hostname === 'www.dailymotion.com' && u.pathname.startsWith('/embed/video/')) {
      return u.pathname.split('/')[3] || null;
    }
  } catch {}
  return null;
}

function providerKeyFrom(entry) {
  const url = String(entry.url||'');
  const frame = String(entry.frameUrl||'');
  const meta = entry.meta || {};

  // 0) Si hay meta explícita, úsala SIEMPRE (viene desde content.js)
  if (meta.provider && meta.providerId) return `${meta.provider}:${meta.providerId}`;

  // 1) Inferencias por URL o frame
  const y1 = ytId(urlFromMaybeString(url)); if (y1) return `yt:${y1}`;
  const y2 = ytId(urlFromMaybeString(frame)); if (y2) return `yt:${y2}`;

  const v1 = vimeoId(urlFromMaybeString(url)); if (v1) return `vimeo:${v1}`;
  const v2 = vimeoId(urlFromMaybeString(frame)); if (v2) return `vimeo:${v2}`;

  const d1 = dailymotionId(urlFromMaybeString(url)); if (d1) return `dm:${d1}`;
  const d2 = dailymotionId(urlFromMaybeString(frame)); if (d2) return `dm:${d2}`;

  // 2) blob dentro de frame de YouTube y (por si acaso) meta.providerId
  if (url.startsWith('blob:') && /(^|\.)youtube\.com$/i.test(hostnameOf(frame)) && meta.providerId) {
    return `yt:${meta.providerId}`;
  }
  // 3) blob agrupado por origen de frame
  if (url.startsWith('blob:') && frame) return `frame:${new URL(frame).origin}`;

  return null;
}
function canonicalKey(entry) {
  return providerKeyFrom(entry) || String(entry.url||'');
}

// helpers locales
function urlFromMaybeString(s){ try{ return new URL(String(s)); }catch{ return null; } }
function hostnameOf(s){ try{ return new URL(String(s)).hostname; }catch{ return ''; } }
function ytId(u){ if(!u) return null; if(u.hostname.endsWith('youtube.com')){ const p=u.pathname; if(p.startsWith('/embed/')) return p.split('/')[2]||null; if(p.startsWith('/shorts/')) return p.split('/')[2]||null; if(p==='/watch') return u.searchParams.get('v'); } return null; }
function vimeoId(u){ if(!u) return null; if(u.hostname==='player.vimeo.com' && u.pathname.startsWith('/video/')) return u.pathname.split('/')[2]||null; return null; }
function dailymotionId(u){ if(!u) return null; if(u.hostname==='www.dailymotion.com' && u.pathname.startsWith('/embed/video/')) return u.pathname.split('/')[3]||null; return null; }

function canonicalKey(entry) {
  return providerKeyFrom(entry) || String(entry.url||'');
}

// ============== Alta / fusión de entradas ==============
function mergeState(tabId, entry) {
  const st = stateByTab.get(tabId)?.get(entry.url);
  return st ? { ...entry, state: st } : entry;
}
function upgradeEntry(base, incoming) {
  // Prefiere meta/thumb/kind “mejor”
  const bestUrl = (base.url.startsWith('blob:') && !incoming.url.startsWith('blob:')) ? incoming.url : base.url;
  const meta = { ...(base.meta||{}), ...(incoming.meta||{}) };
  const kind = base.kind === 'unknown' ? incoming.kind : base.kind;
  const via  = base.via || incoming.via;
  const frameUrl = base.frameUrl || incoming.frameUrl;
  return { ...base, url: bestUrl, via, kind, meta, frameUrl, ts: base.ts || incoming.ts || Date.now() };
}
function pushVideo(tabId, rawEntry) {
  if (tabId == null || tabId < 0) return;

  const entry = mergeState(tabId, { ...rawEntry });
  entry.kind = entry.kind || classify(entry.url, entry.meta?.ct);

  const key = canonicalKey(entry);
  let list = videosByTab.get(tabId) || [];
  let idxMap = indexByTab.get(tabId) || new Map();

  if (idxMap.has(key)) {
    const idx = idxMap.get(key);
    list[idx] = upgradeEntry(list[idx], entry);
  } else {
    list.push(entry);
    idxMap.set(key, list.length - 1);
  }
  videosByTab.set(tabId, list);
  indexByTab.set(tabId, idxMap);
  setBadge(tabId, list.length);
}

// ============== Inyección MAIN world del hook ==============
async function injectHook(tabId, frameId) {
  const k = `${tabId}:${frameId}`;
  if (injectedFrames.has(k)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', files: ['page_hook.js'] });
    injectedFrames.add(k);
  } catch(e) { L('HOOK inject error', e.message); }
}
chrome.webNavigation.onCommitted.addListener(d => { injectedFrames.delete(`${d.tabId}:${d.frameId}`); injectHook(d.tabId, d.frameId); });
chrome.webNavigation.onDOMContentLoaded.addListener(d => injectHook(d.tabId, d.frameId));
chrome.tabs.onRemoved.addListener(id => { videosByTab.delete(id); indexByTab.delete(id); stateByTab.delete(id); [...injectedFrames].forEach(k=>{ if(k.startsWith(`${id}:`)) injectedFrames.delete(k); }); });

// ============== Sniffer red (pasivo) ==============
function readCT(headers=[]){ const m=Object.create(null); headers.forEach(h=>m[String(h.name).toLowerCase()]=h.value||''); return m['content-type']||''; }
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId<0) return; const u=d.url||''; if (/\.(mp4|m4v|webm|mov|m3u8|mpd)(\?|#|$)/i.test(u)) pushVideo(d.tabId,{url:u,via:'onBeforeRequest',frameUrl:d.initiator||'(net)'}); },
  { urls: ["<all_urls>"] }, ["extraHeaders"]
);
chrome.webRequest.onResponseStarted.addListener(
  (d) => { if (d.tabId<0) return; const u=d.url||''; const ct=readCT(d.responseHeaders||[]); if (/\.(mp4|m4v|webm|mov|m3u8|mpd)(\?|#|$)/i.test(u) || /^video\//i.test(ct) || /application\/(vnd\.apple\.mpegurl|x-mpegURL|dash\+xml)/i.test(ct)) pushVideo(d.tabId,{url:u,via:'onResponseStarted',frameUrl:d.initiator||'(net)',meta:{ct}}); },
  { urls: ["<all_urls>"] }, ["responseHeaders","extraHeaders"]
);

// ============== Estado playing/paused + miniaturas ==============
function updateVideoState(tabId, st, metaExtra) {
  if (!st || !st.url) return;
  const map = stateByTab.get(tabId) || new Map();
  map.set(st.url, st);
  stateByTab.set(tabId, map);

  const entry = { url: st.url, frameUrl: st.frameUrl, via:'state', meta: {}, kind: classify(st.url) };
  // si llega thumb/provider desde content, añádelo
  if (metaExtra && typeof metaExtra === 'object') entry.meta = { ...entry.meta, ...metaExtra };
  pushVideo(tabId, entry);
}

// ============== Helpers descarga/API ==============
function suggestName(u){ try{ const url=new URL(u); const base=(url.pathname.split('/').pop()||'video').split('?')[0]; return base||'video.mp4'; }catch{ return 'video.mp4'; } }
function inferReferer(resourceUrl,pageUrl){ try{ new URL(resourceUrl); new URL(pageUrl); return pageUrl; }catch{ return pageUrl; } }
async function getUA(tabId,frameId=0){ try{ const [r]=await chrome.scripting.executeScript({target:{tabId,frameIds:[frameId]},world:'MAIN',func:()=>navigator.userAgent}); return String(r.result||''); }catch{ return ''; } }
async function buildCookieHeader(u){ try{ const cookies=await chrome.cookies.getAll({url:u}); if(!cookies?.length) return null; return cookies.map(c=>`${c.name}=${c.value}`).join('; ');}catch{ return null; } }
async function getApiUrl(){ const s=await chrome.storage.local.get('apiUrl'); return s.apiUrl || 'http://localhost:3001/ingest'; }
async function postToApi(payload, apiUrl){ const endpoint=apiUrl || (await getApiUrl()); try{ const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); return {ok:res.ok,status:res.status}; }catch(e){ return {ok:false,error:e.message}; } }

async function sendToApiDownload({ tabId, url }) {
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab.url;
  const referer = inferReferer(url, pageUrl);
  const ua = await getUA(tabId).catch(()=> '');
  const cookies = await buildCookieHeader(url);
  const apiUrl = await getApiUrl();
  const kind = classify(url);

  const payload = { url, kind, referer, userAgent: ua, pageUrl, cookies, filename: suggestName(url), ts: Date.now() };
  const r = await postToApi(payload, apiUrl);
  return r.ok ? { ok:true, mode:'api', status:r.status } : { ok:false, error:r.error || `status=${r.status}` };
}

// ============== Mensajería ==============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg?.type === 'ensureHook') {
      const tabId = sender?.tab?.id ?? msg.tabId ?? -1;
      const frameId = sender?.frameId ?? 0;
      injectHook(tabId, frameId).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:e.message}));
      return true;
    }
    if (msg?.type === 'videoFound') {
      const tabId = sender?.tab?.id ?? msg.tabId ?? -1;
      pushVideo(tabId, { url: msg.url, via: msg.via || 'content', frameUrl: msg.frameUrl || '(frame)', meta: msg.meta || null });
      return;
    }
    if (msg?.type === 'videoState') {
      const tabId = sender?.tab?.id ?? msg.tabId ?? -1;
      updateVideoState(tabId, msg.state, msg.meta || null);
      return;
    }
    if (msg?.type === 'getVideos') {
      const list = (videosByTab.get(msg.tabId) || []);
      sendResponse({ list });
      return true;
    }
    if (msg?.type === 'downloadViaApi') {
      sendToApiDownload(msg).then(sendResponse).catch(e=>sendResponse({ok:false,error:e.message}));
      return true;
    }
    if (msg?.type === 'clearVideos') {
      videosByTab.delete(msg.tabId); indexByTab.delete(msg.tabId); setBadge(msg.tabId,0);
      sendResponse({ ok:true }); return true;
    }
  } catch(e){ L('ERR onMessage', e.message); }
});

chrome.tabs.onActivated.addListener(({tabId}) => setBadge(tabId, (videosByTab.get(tabId)||[]).length));
