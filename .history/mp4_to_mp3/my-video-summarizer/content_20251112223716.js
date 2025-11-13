/***********************
 * CONFIG & DEBUG
 ***********************/
const DEBUG = true;
const DEBUG_DROPS = false; // Ajustado para reducir ruido
const TTL_MS = 0;

const DEVLOG_ENABLED = true; // Asegurarse de que esté activado
const DEVLOG_URL = 'http://127.0.0.1:8765/log';

/***********************
 * DEVLOG (envía a tu terminal)
 ***********************/
async function devlog(tag, msg, extra) {
  if (!DEVLOG_ENABLED) return;
  try {
    await fetch(DEVLOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, msg, extra })
    });
  } catch (e) {
    // ¡NUEVO! Imprimir en la consola interna si el logger falla
    console.warn(`[DEVLOG_FAILED] Tag: ${tag}, Msg: ${msg}, Err: ${e?.message}`);
  }
}

/***********************
 * LOG HELPERS
 ***********************/
const LOG = [];
const MAX_LOGS = 1000;
function safeStr(x){ try{ if(typeof x==='string') return x; return JSON.stringify(x,(k,v)=>(v instanceof Map?{__map:[...v]}:v)); }catch{ return String(x);} }
function addLogLine(prefix,...args){
  const line = `[BG ${new Date().toISOString()}] ${prefix} ${args.map(safeStr).join(' ')}`;
  console.log(line);
  LOG.push(line); if (LOG.length>MAX_LOGS) LOG.shift();
  devlog('BG', line);
}
function log(...a){ if (DEBUG) addLogLine('', ...a); }
function logDrop(reason,item,ctx={}){ if(!DEBUG||!DEBUG_DROPS) return; const payload={reason,url:item?.url,frameUrl:item?.frameUrl,ctx}; addLogLine('[DROP]', safeStr(payload)); devlog('DROP', reason, payload); }

/***********************
 * STATE (por pestaña/documento)
 ***********************/
const byTab=new Map();              // tabId -> { currentDoc, docs: Map(docKey -> {list, index, startTs}) }
const injectedFrame=new Set();      // `${tabId}:${frameId}`
const pageThumbByTab=new Map();     // tabId -> dataURL

function normalizeDoc(url){ try{ const u=new URL(String(url)); return `${u.origin}${u.pathname}${u.search}`; }catch{ return ''; } }
function originOfUrl(s){ try{ const str=String(s||''); if(str.startsWith('blob:')||str.startsWith('data:')) return 'blob-data://'; try{ return new URL(str).origin; }catch{ return ''; } } };
function originRaw(s){ try{ return new URL(String(s)).origin; }catch{ return ''; } }

function tabState(tabId){ if(!byTab.has(tabId)){ byTab.set(tabId,{currentDoc:'',docs:new Map()}); devlog('STATE','tabState:init',{tabId}); } return byTab.get(tabId); }
function docBucket(tabId,docKey){ const st=tabState(tabId); if(!st.docs.has(docKey)){ st.docs.set(docKey,{list:[],index:new Map(),startTs:Date.now()}); devlog('STATE','docBucket:init',{tabId,docKey}); } return st.docs.get(docKey); }
function setCurrentDoc(tabId,url){ const st=tabState(tabId); const key=normalizeDoc(url); if(!key) return; if(st.currentDoc!==key){ st.currentDoc=key; const b=docBucket(tabId,key); b.startTs=Date.now(); setBadge(tabId,0); devlog('NAV','setCurrentDoc',{tabId,key,startTs:b.startTs}); } }
function currentDocKey(tabId){ const st=tabState(tabId); return st.currentDoc||''; }
function setBadge(tabId,n){ if(!tabId) return; try{ chrome.action.setBadgeText({tabId,text:n?String(n):''}); }catch{} }
function dumpStateObj(tabId=null){ const obj={}; for(const [tId,st] of byTab.entries()){ if(tabId!==null && tId!==tabId) continue; obj[tId]={currentDoc:st.currentDoc,docs:[...st.docs.entries()].map(([k,v])=>({key:k,startTs:v.startTs,count:v.list.length,urls:v.list.slice(0,50).map(e=>e.url)}))}; } return obj; }

/***********************
 * INJECTION
 ***********************/
async function injectHook(tabId,frameId=0){
  const k=`${tabId}:${frameId}`; if(injectedFrame.has(k)) return;
  try{
    await chrome.scripting.executeScript({ target:{tabId,frameIds:[frameId]}, world:'MAIN', files:['page_hook.js'] });
    injectedFrame.add(k); devlog('INJECT','ok',{tabId,frameId});
  }catch(e){ devlog('INJECT','error',{tabId,frameId,err:e?.message||String(e)}); }
}

/***********************
 * ADD / UPDATE ITEMS
 ***********************/
function pushVideoToDoc(tabId,docKey,entry){
  const bucket=docBucket(tabId,docKey); const key=`${entry.url}@@${entry.frameUrl||''}`;
  if(bucket.index.has(key)){
    const i=bucket.index.get(key); const prev=bucket.list[i];
    const newMeta = {...(prev.meta || {}), ...(entry.meta || {})}; // *** THUMBNAIL FIX ***
    bucket.list[i]={...prev,...entry, ts:prev.ts||Date.now(), meta:newMeta}; // Combinar, no sobrescribir
    devlog('VIDEO','update',{tabId,docKey,key,url:entry.url});
  }
  else {
    bucket.list.push({...entry,ts:Date.now()}); bucket.index.set(key,bucket.list.length-1);
    devlog('VIDEO','new',{tabId,docKey,key,url:entry.url,frameUrl:entry.frameUrl});
  }
  if(currentDocKey(tabId)===docKey) setBadge(tabId,bucket.list.length);
}
function removeTab(tabId){ byTab.delete(tabId); pageThumbByTab.delete(tabId); for(const k of [...injectedFrame]) if(k.startsWith(`${tabId}:`)) injectedFrame.delete(k); devlog('STATE','removeTab',{tabId}); }

/***********************
 * RUNTIME MESSAGES
 ***********************/
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  try{
    devlog('MSG','onMessage',{type:msg?.type,fromTab:sender?.tab?.id,frameId:sender?.frameId});

    if(msg?.type==='dbg.ping'){ devlog('DBG','PING',{from:msg.from||'unknown'}); sendResponse?.({ok:true}); return true; }

    if(msg?.type==='ensureHook'){ const tabId=sender?.tab?.id ?? msg.tabId ?? -1; const frameId=sender?.frameId ?? 0; injectHook(tabId,frameId).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:e?.message||String(e)})); return true; }

    if(msg?.type==='videoFound'){ const tabId=sender?.tab?.id ?? msg.tabId ?? -1; const frameUrl=msg.frameUrl || sender?.url || ''; const docKey=normalizeDoc(frameUrl) || currentDocKey(tabId);
      pushVideoToDoc(tabId,docKey,{ url:msg.url, via:msg.via||'content', frameId:sender?.frameId ?? 0, frameUrl, meta:msg.meta||null }); return; }

    if(msg?.type==='videoState'){ const tabId=sender?.tab?.id ?? msg.tabId ?? -1; const frameUrl=msg.frameUrl || sender?.url || ''; const docKey=normalizeDoc(frameUrl) || currentDocKey(tabId);
      try{ const b=docBucket(tabId,docKey); for(let i=0;i<b.list.length;i++){ if(b.list[i].url===msg.url){ b.list[i]={...b.list[i], meta:{...(b.list[i].meta||{}), ...(msg.meta||{})} }; } } }catch{} return; }

    if(msg?.type==='getVideos'){
      (async ()=>{
        let tab, currentUrl=''; try{ tab=await chrome.tabs.get(msg.tabId); currentUrl=tab?.url||''; }catch{}
        if(!currentUrl) currentUrl=currentDocKey(msg.tabId);
        setCurrentDoc(msg.tabId,currentUrl);

        const docKey=normalizeDoc(currentUrl);
        const bucket=docBucket(msg.tabId,docKey);
        const curOrigin=originOfUrl(currentUrl);

        devlog('GET','context',{ tabId:msg.tabId, currentUrl, docKey, curOrigin, bucketCount:bucket.list.length, startTs:bucket.startTs, TTL_MS });

        const explain=[]; const kept=[];
        for(const e of bucket.list){
          const videoOrigin=originOfUrl(e.url);
          const frameOrigin=originRaw(e.frameUrl||'');
          const withinTTL=!TTL_MS || (e.ts>=bucket.startTs && (Date.now()-e.ts)<=TTL_MS);
          
          // *** FILTRO CORREGIDO *** Aceptar cualquier origen de vídeo
          const originOK = (videoOrigin === 'blob-data://') || videoOrigin.startsWith('http');
          
          const reasons=[];
          reasons.push(`origenVideo=${videoOrigin} vs origenPagina=${curOrigin}`);
          reasons.push(withinTTL ? 'TTL=OK' : 'TTL=EXPIRED');
          if(frameOrigin) reasons.push(`origenFrame=${frameOrigin}`);

          const keep = originOK && withinTTL;
          explain.push({ keep, url:e.url, frameUrl:e.frameUrl||null, via:e.via||null, ts:e.ts, originVideo:videoOrigin, originFrame:frameOrigin||null, originPage:curOrigin, reasons });
          if(keep){ const meta={...(e.meta||{})}; kept.push({...e, meta}); }
          else { logDrop('kept=false', e, { reasons }); }
        }

        devlog('GET','result',{ tabId:msg.tabId, kept:kept.length, sample:explain.slice(0,5) });
        sendResponse({ list: kept, explain });
      })();
      return true;
    }
    
    // Oyente para el botón "Descargar"
    if (msg?.type === 'downloadViaApi') {
      (async () => {
        const url = msg.url;
        devlog('API','downloadViaApi: Recibido', { url });
        try {
          const res = await fetch('http://127.0.0.1:8765/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url, tabId: msg.tabId })
          });
          if (!res.ok) throw new Error(`El servidor respondió ${res.status}`);
          devlog('API','downloadViaApi: Éxito', { url });
          sendResponse({ ok: true });
        } catch (e) {
          devlog('API','downloadViaApi: Error', { url, err: e?.message || String(e) });
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    // Panel debug opcional
    if(msg?.type==='dbg.logs'){ const lim=Math.max(1,Math.min(2000,Number(msg.limit)||500)); sendResponse({ok:true,logs:LOG.slice(-lim)}); return true; }
    if(msg?.type==='dbg.dump'){ sendResponse({ok:true,state:dumpStateObj(msg.tabId ?? null)}); return true; }
    if(msg?.type==='dbg.clearAll'){ byTab.clear(); pageThumbByTab.clear(); sendResponse({ok:true}); devlog('STATE','clearAll'); return true; }

    // *** NUEVO *** Oyente para el DOM FILTRADO
    if (msg?.type === 'dbg.logFilteredDOM') {
      devlog('DOM', `FILTRO (Frame ${msg.frameId || 0}):\n${msg.html}`, { frameUrl: msg.frameUrl });
      sendResponse({ ok: true });
      return true;
    }

  }catch(e){ devlog('ERR','onMessage:exception',{info:e?.message||String(e)}); }
});

/***********************
 * NAVIGATION EVENTS
 ***********************/
function onMainDocChange(tabId,url,source){ setCurrentDoc(tabId,url); setBadge(tabId,0); injectHook(tabId,0); devlog('NAV','main-change',{tabId,url,source}); }
chrome.webNavigation.onCommitted.addListener(d=>{ try{ if(d.frameId===0) onMainDocChange(d.tabId,d.url||'','onCommitted'); }catch{} });
chrome.webNavigation.onHistoryStateUpdated.addListener(d=>{ try{ if(d.frameId===0) onMainDocChange(d.tabId,d.url||'','onHistoryStateUpdated'); }catch{} });
chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{ try{ if(tab?.active && (changeInfo.url || changeInfo.status==='loading' || changeInfo.status==='complete')) onMainDocChange(tabId,tab.url||'','tabs.onUpdated'); }catch{} });
chrome.tabs.onActivated.addListener(async ({tabId})=>{ try{ const t=await chrome.tabs.get(tabId); onMainDocChange(tabId,t?.url||'','tabs.onActivated'); const key=currentDocKey(tabId); const b=docBucket(tabId,key); setBadge(tabId,b.list.length); }catch{} });
chrome.tabs.onRemoved.addListener(tabId=>removeTab(tabId));

/***********************
 * LIFECYCLE + BOOT PINGS
 ***********************/
(async ()=>{
  devlog('BOOT', 'service-worker loaded', { version: chrome.runtime.getManifest?.().version });
})();
chrome.runtime.onInstalled.addListener(info => devlog('LIFE','onInstalled', info));
chrome.runtime.onStartup.addListener(()=> devlog('LIFE','onStartup',{}));

/***********************
 * GLOBAL ERROR HOOKS
 ***********************/
self.addEventListener('unhandledrejection', ev => { devlog('ERR','unhandledrejection',{reason:safeStr(ev.reason)}); });
self.addEventListener('error', ev => { devlog('ERR','error',{message:safeStr(ev.message || ev.error || ev)}); });