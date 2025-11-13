const ul = document.getElementById('list');
const btnRefresh = document.getElementById('refresh');

const ask = (payload) => new Promise(res => chrome.runtime.sendMessage(payload, res));
const activeTab = async () => (await chrome.tabs.query({ active:true, currentWindow:true }))[0];

// ======= utils =======
function prettyName(entry) {
  try {
    const u = new URL(entry.url);
    const base = u.pathname.split('/').pop();
    if (base) return decodeURIComponent(base.split('?')[0]);
    return u.hostname;
  } catch {
    return entry.url.slice(0, 80);
  }
}
function niceHost(str){ try{ return new URL(str).hostname; }catch{ return ''; } }
function stateLabel(entry){ const st=entry.state; return st ? (st.playing ? 'playing' : 'paused') : '—'; }
function isDirect(entry){ return entry.kind === 'direct'; }
function ytThumbFromMeta(meta){ if (meta?.provider==='yt' && meta.providerId) return `https://img.youtube.com/vi/${meta.providerId}/hqdefault.jpg`; return null; }

function render(items) {
  ul.innerHTML = '';
  if (!items.length) { ul.innerHTML = '<li>No se detectaron vídeos. Pulsa “Actualizar”.</li>'; return; }

  items.forEach((it, idx) => {
    const li = document.createElement('li');

    // --- Miniatura ---
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const meta = it.meta || {};

    const explicitThumb = meta.thumb || ytThumbFromMeta(meta);
    if (explicitThumb) {
      const img = document.createElement('img');
      img.src = explicitThumb;
      img.alt = 'thumb';
      thumb.appendChild(img);
    } else if (isDirect(it)) {
      const v = document.createElement('video');
      v.src = it.url + '#t=0.5';
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      thumb.appendChild(v);
    } else {
      thumb.textContent = it.kind || 'vídeo';
    }

    // --- Meta + acciones ---
    const metaBox = document.createElement('div');
    metaBox.className = 'meta';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `Video ${idx + 1} — "${prettyName(it)}"`;

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = niceHost(it.frameUrl || '') || niceHost(it.url) || '';

    const pills = document.createElement('div');
    pills.className = 'pills';
    const pill1 = document.createElement('span'); pill1.className='pill'; pill1.textContent = it.kind || it.via || '—';
    const pill2 = document.createElement('span'); pill2.className='pill'; pill2.textContent = stateLabel(it);
    pills.appendChild(pill1); pills.appendChild(pill2);

    const row = document.createElement('div');
    row.className = 'row';
    const btn = document.createElement('button');
    btn.textContent = 'Descargar';
    btn.addEventListener('click', async () => {
      const tab = await activeTab();
      btn.disabled = true; btn.textContent = 'Enviando…';
      const r = await ask({ type: 'downloadViaApi', tabId: tab.id, url: it.url });
      btn.disabled = false; btn.textContent = 'Descargar';
      alert(r.ok ? 'Enviado a la API correctamente.' : ('Error al enviar: ' + (r.error || 'desconocido')));
    });
    row.appendChild(btn);

    metaBox.appendChild(title);
    metaBox.appendChild(sub);
    metaBox.appendChild(pills);
    metaBox.appendChild(row);

    li.appendChild(thumb);
    li.appendChild(metaBox);
    ul.appendChild(li);
  });
}

// ======= acciones =======
async function refresh() {
  const tab = await activeTab();
  const r = await ask({ type: 'getVideos', tabId: tab.id });
  render(r?.list || []);
}
btnRefresh.onclick = refresh;
refresh();
