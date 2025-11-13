const ul = document.getElementById('list');
const btnRefresh = document.getElementById('refresh');
const ctxSpan = document.getElementById('ctx');

// --- INICIO DE CAMBIOS ---
// Variables del panel de depuración eliminadas
// --- FIN DE CAMBIOS ---

const ask = (payload) => new Promise(res => chrome.runtime.sendMessage(payload, res));
const activeTab = async () => (await chrome.tabs.query({ active:true, currentWindow:true }))[0];

try { chrome.runtime.sendMessage({ type: 'dbg.ping', from: 'popup-opened', ts: Date.now() }); } catch {}


// ===== utils =====
function prettyName(entry) {
  try {
    const u = new URL(entry.url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last).slice(0, 120);
  } catch { return String(entry.url).slice(0, 120); }
}
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts)/1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60); if (m < 60) return `${m}m`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h`;
  const d = Math.floor(h/24); return `${d}d`;
}
function clearList() { ul.innerHTML = ''; }
function showLoading() {
  clearList();
  const li = document.createElement('li'); li.className = 'item'; li.textContent = 'Cargando…';
  ul.appendChild(li);
}
function pill(text) { const s=document.createElement('span'); s.className='pill'; s.textContent=text; return s; }

// ===== render vídeos =====
function render(list) {
  clearList();
  if (!list || !list.length) {
    const li = document.createElement('li'); li.className='item'; li.textContent='No hay vídeos detectados en esta página.'; ul.appendChild(li); return;
  }
  list.forEach(it => {
    const li = document.createElement('li'); li.className='item';

    const thumb = document.createElement('div'); thumb.className='thumb';
    const t = it?.meta?.thumb;
    if (t) { const img=document.createElement('img'); img.src=t; img.alt='thumb'; thumb.appendChild(img); }
    else { thumb.textContent = 'sin miniatura'; }

    const metaBox = document.createElement('div'); metaBox.className='meta';
    const title = document.createElement('div'); title.className='title'; title.textContent = prettyName(it);
    const sub = document.createElement('div'); sub.className='sub';
    const host = (it.frameUrl || it.url || '').replace(/^[a-z]+:\/\//,'').split('/')[0] || '';
    sub.textContent = `${host} · ${timeAgo(it.ts)} · ${it.via || ''}`;

    const pills = document.createElement('div'); pills.className='pills';
    if (it?.meta?.provider) pills.appendChild(pill(it.meta.provider));
    if (it?.meta?.kind)      pills.appendChild(pill(it.meta.kind));
    if (it?.meta?.quality)   pills.appendChild(pill(it.meta.quality));
    if (it?.meta?.codec)     pills.appendChild(pill(it.meta.codec));

    const row = document.createElement('div'); row.className='row';
    const btn = document.createElement('button'); btn.textContent = 'Descargar';
    
    // --- INICIO DE CAMBIOS ---
    // Añadimos un div para los mensajes de estado
    const statusBox = document.createElement('div');
    statusBox.className = 'status-message';

    btn.addEventListener('click', async () => {
      // Limpiar estado anterior
      statusBox.textContent = '';
      statusBox.className = 'status-message';
      
      const tab = await activeTab();
      btn.disabled = true; const old=btn.textContent; btn.textContent='Enviando…';
      
      let r;
      try {
        r = await ask({ type: 'downloadViaApi', tabId: tab.id, url: it.url });
        if (!r) throw new Error('Respuesta nula del background');
      } catch (e) {
        // Capturar error de comunicación si el background script falla
        r = { ok: false, error: e?.message || 'Error de comunicación' };
      }

      btn.disabled = false; btn.textContent = old;

      // Mostrar estado en el div, no con alert()
      if (r.ok) {
        statusBox.textContent = 'Enviado a la API correctamente.';
        statusBox.classList.add('success');
      } else {
        statusBox.textContent = 'Error al enviar: ' + (r.error || 'desconocido');
        statusBox.classList.add('error');
      }

      // Limpiar el mensaje después de 4 segundos
      setTimeout(() => {
        if (statusBox) {
          statusBox.textContent = '';
          statusBox.className = 'status-message';
        }
      }, 4000);
    });
    // --- FIN DE CAMBIOS ---

    row.appendChild(btn);

    metaBox.appendChild(title);
    metaBox.appendChild(sub);
    metaBox.appendChild(pills);
    metaBox.appendChild(row);
    metaBox.appendChild(statusBox); // Añadimos el statusBox al DOM

    li.appendChild(thumb);
    li.appendChild(metaBox);
    ul.appendChild(li);
  });
}

// ===== auto-refresco vídeos =====
let __req = 0;
// let __lastExplain = []; // Eliminado

async function refreshSafe() {
  showLoading();
  const tab = await activeTab(); if (!tab) { render([]); return; }
  ctxSpan.textContent = tab.url || '';
  const my = ++__req;
  const r = await ask({ type: 'getVideos', tabId: tab.id });
  if (my !== __req) return;
  // __lastExplain = r?.explain || []; // Eliminado
  render(r?.list || []);
  // refresca debug con la explicación
  // await updateDebug(); // Eliminado
}
async function refresh(){ return refreshSafe(); }

chrome.tabs.onActivated.addListener(() => { refreshSafe(); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    refreshSafe();
  }
});
chrome.webNavigation.onCommitted.addListener(d => {
  if (d.frameId === 0) { activeTab().then(t => { if (t && t.id === d.tabId) refreshSafe(); }); }
});
btnRefresh.onclick = refreshSafe;

// ===== debug panel =====
// --- INICIO DE CAMBIOS ---
// Todo el panel de depuración (variables, funciones, listeners) ha sido eliminado.
// --- FIN DE CAMBIOS ---

// init
refreshSafe();
// updateDebug(); // Eliminado