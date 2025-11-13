// wa_export_last30_playwright.js
// node wa_export_last30_playwright.js

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ================== CONFIG ==================
const CONFIG = {
  PROFILE_DIR: path.resolve(__dirname, ".wa-profile"), // sesión persistente (QR una vez)
  EXPORT_DIR: path.resolve(__dirname, "exports"),
  CONCURRENCY: 4,                 // nº de tabs en paralelo (ajústalo según RAM/CPU)
  HEADLESS: true,                 // true = mínimo consumo
  LIVE_MINUTES: 0,                // 0 = no escuchar en vivo; >0 = minutos escuchando nuevos mensajes
  DAYS_BACK: 30,                  // últimos N días
  DEBUG: false,                   // logs de depuración
  BLOCK_RESOURCES: ["image", "media", "font"], // reduce consumo
  NAV_TIMEOUT: 60000,
};

// ================ HELPERS ===================
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sanitizeFilename(name="whatsapp_chat"){
  let n = String(name).trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) n = "whatsapp_chat";
  if (n.length > 120) n = n.slice(0,120).trim();
  return n;
}
function nowISO() { return new Date().toISOString().replace(/[:.]/g,"-"); }
function daysAgoDate(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0,0,0,0);
  return d;
}
const THRESHOLD = daysAgoDate(CONFIG.DAYS_BACK).getTime();

// ================== MAIN ====================
(async () => {
  ensureDir(CONFIG.EXPORT_DIR);

  const context = await chromium.launchPersistentContext(CONFIG.PROFILE_DIR, {
    headless: CONFIG.HEADLESS,
    args: [
      "--disable-dev-shm-usage",
      "--no-default-browser-check",
      "--no-first-run",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-extensions",
    ],
    viewport: { width: 980, height: 720 },
    locale: "es-ES",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  });

  // Pestaña “maestra” para listar chats
  const page = await context.newPage();
  await hardenPage(page);
  await gotoWhatsApp(page);

  // obtén todos los títulos de chats (pane principal; no archivados)
  const chatTitles = await listAllChatTitles(page);
  if (!chatTitles.length) {
    console.warn("⚠️ No se detectaron chats en la bandeja. ¿Estás logueado?");
    await context.close(); process.exit(1);
  }
  console.log(`📋 Chats detectados: ${chatTitles.length}`);

  // Reparte en lotes por concurrencia
  const batches = shard(chatTitles, CONFIG.CONCURRENCY);

  // Ejecuta “workers” (tabs)
  await Promise.all(
    batches.map(async (titles, idx) => {
      const p = await context.newPage();
      await hardenPage(p);
      await gotoWhatsApp(p);
      for (const title of titles) {
        try {
          console.log(`▶️ [W${idx+1}] ${title}`);
          await openChatBySearch(p, title);
          const file = path.join(CONFIG.EXPORT_DIR, sanitizeFilename(title) + ".txt");
          await exportLast30AndLive(p, file, title);
        } catch (e) {
          console.error(`❌ [${title}]`, e.message);
        }
      }
      await p.close();
    })
  );

  console.log("✅ Terminado.");
  await context.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});

// ============== CORE FUNCTIONS ==============
async function hardenPage(page) {
  // Reducir consumo: bloquear tipos de recurso
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (CONFIG.BLOCK_RESOURCES.includes(type)) return route.abort();
    route.continue();
  });

  // Quitar animaciones para que el DOM sea más estable y barato
  await page.addInitScript(() => {
    const st = document.createElement("style");
    st.textContent = `
      * { animation: none !important; transition: none !important; }
      html, body { scroll-behavior: auto !important; }
    `;
    document.documentElement.appendChild(st);
  });

  page.setDefaultTimeout(CONFIG.NAV_TIMEOUT);
}

async function gotoWhatsApp(page){
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  // Espera a que aparezca el panel de chats o el QR
  await page.waitForTimeout(800); // pequeño margen
  const pane = await waitForSelectors(page, [
    "#pane-side",
    '[data-testid="chat-list"]',
    '[aria-label*="Lista de chats"], [aria-label*="Chats"]'
  ], 60000);

  if (!pane) {
    // Si no hay panel, quizá hay QR. Dejamos que el usuario escanee.
    console.log("💡 Si ves el QR, inicia sesión. Reintentando espera del panel…");
    await page.waitForSelector("#pane-side, [data-testid='chat-list']", { timeout: 120000 });
  }
}

async function listAllChatTitles(page){
  // Scrollea la lista hasta estancamiento y recoge títulos
  const pane = await waitForSelectors(page, [
    "#pane-side",
    '[data-testid="chat-list"]'
  ], 30000);
  if (!pane) return [];

  let prev = -1, stagn = 0;
  while (stagn < 4) {
    await page.evaluate(() => {
      const el = document.querySelector("#pane-side,[data-testid='chat-list']");
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(900);
    const count = await page.$$eval(
      "#pane-side [title], [data-testid='chat-list'] [title]",
      els => els.length
    );
    if (count === prev) stagn++; else { prev = count; stagn = 0; }
  }

  const titles = await page.$$eval(
    "#pane-side [title], [data-testid='chat-list'] [title]",
    els => Array.from(new Set(els.map(e => e.getAttribute("title") || e.textContent || ""))).filter(Boolean)
  );

  return titles;
}

async function openChatBySearch(page, title){
  // Intenta abrir el chat usando la búsqueda (más fiable que scroll)
  const searchEl = await waitForSelectors(page, [
    '[data-testid="chatlist-search"] [contenteditable="true"]',
    '#side [contenteditable="true"][role="textbox"]',
    '#side [contenteditable="true"]',
  ], 5000);

  if (!searchEl) {
    // Fallback: limpiar y hacer click por visibilidad en pane-side
    await scrollToAndClickTitle(page, title);
    return;
  }

  await typeInSearch(page, title);
  // Clic en primer resultado que case el texto
  const ok = await page.waitForFunction((t) => {
    const cands = document.querySelectorAll('[role="row"], [data-testid="cell-frame-container"], [role="listitem"]');
    for (const el of cands) {
      const tx = (el.innerText || "").trim();
      if (tx && tx.toLowerCase().includes(t.toLowerCase())) {
        el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
        el.click();
        return true;
      }
    }
    return false;
  }, title, { timeout: 8000 }).catch(()=>false);

  // Limpia búsqueda
  await clearSearch(page).catch(()=>{});
  if (!ok) await scrollToAndClickTitle(page, title); // último recurso
}

async function typeInSearch(page, text){
  // Foco y escribir
  await page.keyboard.press("Control+K").catch(()=>{});
  await page.waitForTimeout(150);
  const el = await waitForSelectors(page, [
    '[data-testid="chatlist-search"] [contenteditable="true"]',
    '#side [contenteditable="true"][role="textbox"]',
    '#side [contenteditable="true"]',
  ], 4000);
  if (!el) return;
  await page.focus('[data-testid="chatlist-search"] [contenteditable="true"], #side [contenteditable="true"][role="textbox"], #side [contenteditable="true"]');
  await page.keyboard.down("Control").catch(()=>{});
  await page.keyboard.press("A").catch(()=>{});
  await page.keyboard.up("Control").catch(()=>{});
  await page.keyboard.type(text, { delay: 20 });
  await page.waitForTimeout(300);
}

async function clearSearch(page){
  await page.keyboard.down("Control").catch(()=>{});
  await page.keyboard.press("A").catch(()=>{});
  await page.keyboard.up("Control").catch(()=>{});
  await page.keyboard.press("Backspace").catch(()=>{});
  await page.waitForTimeout(120);
}

async function scrollToAndClickTitle(page, title){
  // Recorre el pane hasta hallar y clicar el título
  const paneSel = "#pane-side,[data-testid='chat-list']";
  for (let i=0; i<30; i++){
    const found = await page.evaluate((t, paneSel)=>{
      const pane = document.querySelector(paneSel);
      if (!pane) return false;
      const els = pane.querySelectorAll("[title]");
      for (const e of els) {
        const v = e.getAttribute("title") || e.textContent || "";
        if (v.toLowerCase().includes(t.toLowerCase())) {
          let clickable = e.closest('[role="row"], [data-testid="cell-frame-container"], [role="listitem"]') || e;
          clickable.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
          clickable.click();
          return true;
        }
      }
      pane.scrollTop += Math.max(300, pane.clientHeight - 60);
      return false;
    }, title, paneSel);
    if (found) return;
    await page.waitForTimeout(400);
  }
  throw new Error("No pude abrir el chat: " + title);
}

function shard(arr, k){
  const out = Array.from({length:k}, ()=>[]);
  arr.forEach((v,i)=> out[i%k].push(v));
  return out;
}

async function exportLast30AndLive(page, filePath, chatTitle){
  ensureDir(path.dirname(filePath));
  const ws = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  const seen = new Set(); // uid = pre|text

  const scroller = await getMessageScroller(page);
  if (!scroller) throw new Error("No encuentro el contenedor de mensajes");

  // 1) Backfill: subir hasta <=THRESHOLD con estancamiento
  let stagn = 0;
  for (let round=0; round<120 && stagn<8; round++){
    const before = seen.size;
    await collectVisible(page, seen, ws);
    // condición de parada: si ya vemos mensajes <= threshold y no entran nuevos
    const hasOlderOrEq = await page.evaluate((thr)=>{
      const nodes = document.querySelectorAll('[data-pre-plain-text]');
      let oldest = Infinity;
      for (const n of nodes){
        const pre = n.getAttribute('data-pre-plain-text') || "";
        const d = parsePreDate(pre);
        if (d) oldest = Math.min(oldest, d.getTime());
      }
      return oldest !== Infinity && oldest <= thr;

      function parsePreDate(pre){
        const m = pre.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
        if (!m) return null;
        let [ , hh, mm, dd, MM, yy ] = m.map(Number);
        if (yy < 100) yy += 2000;
        const dt = new Date(yy, MM-1, dd, hh, mm, 0, 0);
        return dt;
      }
    }, THRESHOLD);

    if (hasOlderOrEq && seen.size === before) stagn++; else stagn = 0;

    // scroll arriba
    await page.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); }, scroller);
    await page.waitForTimeout(700);
  }

  // una pasada final por si quedó algo nuevo visible
  await collectVisible(page, seen, ws);

  // 2) Live (opcional): escuchar nuevos mensajes en tiempo real
  if (CONFIG.LIVE_MINUTES > 0){
    await setupLiveObserver(page, THRESHOLD);
    const until = Date.now() + CONFIG.LIVE_MINUTES * 60_000;
    while (Date.now() < until){
      const lines = await page.evaluate(() => {
        const out = window.__waLiveBuffer || [];
        window.__waLiveBuffer = [];
        return out;
      });
      if (lines?.length){
        for (const L of lines) if (!seen.has(L.uid)) {
          seen.add(L.uid);
          ws.write(L.line + "\n");
        }
      }
      await page.waitForTimeout(800);
    }
  }

  ws.end();
}

async function getMessageScroller(page){
  // busca el contenedor scroll principal de mensajes
  const handle = await waitForSelectors(page, [
    '[data-testid="conversation-panel-body"]',
    '[data-testid="conversation-panel-messages"]',
    '#main [tabindex="-1"]',
    '#main'
  ], 10000);
  return handle;
}

async function collectVisible(page, seen, ws){
  const lines = await page.evaluate((thr) => {
    const nodes = document.querySelectorAll('[data-pre-plain-text]');
    const out = [];
    for (const n of nodes){
      const pre = n.getAttribute('data-pre-plain-text') || "";
      const textEl = n.querySelector("span.selectable-text, div.selectable-text");
      const text = textEl ? textEl.innerText : "";
      if (!pre && !text) continue;

      const uid = pre + "|" + text;
      const d = parsePreDate(pre);
      if (!d) continue;
      if (d.getTime() < thr) continue; // solo últimos N días

      const meta = parsePreAuthor(pre);
      const line = `[${fmtDate(d)}] ${meta.author || "Yo"}: ${(text||"").replace(/\r?\n/g," ")}`;
      out.push({ uid, line });
    }
    return out;

    function parsePreDate(pre){
      const m = pre.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
      if (!m) return null;
      let [ , hh, mm, dd, MM, yy ] = m.map(Number);
      if (yy < 100) yy += 2000; // 24 => 2024
      return new Date(yy, MM-1, dd, hh, mm, 0, 0);
    }
    function parsePreAuthor(pre){
      const m = pre.match(/\[.*?\]\s*(.*?):\s?$/);
      return { author: m ? m[1] : "" };
    }
    function pad(n){ return String(n).padStart(2,"0"); }
    function fmtDate(d){
      return `${pad(d.getHours())}:${pad(d.getMinutes())}, ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
    }
  }, THRESHOLD);

  for (const L of lines) {
    if (!seen.has(L.uid)){
      seen.add(L.uid);
      ws.write(L.line + "\n");
    }
  }
}

async function setupLiveObserver(page, thr){
  await page.addInitScript((thr) => {
    if (window.__waLiveSetup) return;
    window.__waLiveSetup = true;
    window.__waLiveBuffer = [];

    const seen = new Set();
    const parsePreDate = (pre)=>{
      const m = pre.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
      if (!m) return null;
      let [ , hh, mm, dd, MM, yy ] = m.map(Number);
      if (yy < 100) yy += 2000;
      return new Date(yy, MM-1, dd, hh, mm, 0, 0);
    };
    const parsePreAuthor = (pre)=>{
      const m = pre.match(/\[.*?\]\s*(.*?):\s?$/);
      return { author: m ? m[1] : "" };
    };
    const pad = n => String(n).padStart(2,"0");
    const fmtDate = d => `${pad(d.getHours())}:${pad(d.getMinutes())}, ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;

    const pushNode = (n)=>{
      const pre = n.getAttribute?.('data-pre-plain-text') || "";
      const textEl = n.querySelector?.("span.selectable-text, div.selectable-text");
      const text = textEl ? textEl.innerText : "";
      if (!pre && !text) return;

      const d = parsePreDate(pre);
      if (!d || d.getTime() < thr) return;

      const uid = pre + "|" + text;
      if (seen.has(uid)) return;
      seen.add(uid);

      const author = parsePreAuthor(pre).author || "Yo";
      const line = `[${fmtDate(d)}] ${author}: ${(text||"").replace(/\r?\n/g," ")}`;
      window.__waLiveBuffer.push({ uid, line });
    };

    // seed con lo visible
    document.querySelectorAll('[data-pre-plain-text]').forEach(pushNode);

    const obs = new MutationObserver(muts=>{
      for (const m of muts){
        m.addedNodes && m.addedNodes.forEach(n=>{
          if (n.nodeType !== 1) return;
          if (n.matches?.('[data-pre-plain-text]')) pushNode(n);
          n.querySelectorAll?.('[data-pre-plain-text]').forEach(pushNode);
        });
      }
    });
    obs.observe(document.body, { subtree:true, childList:true });
    window.__waLiveObserver = obs;
  }, thr);
}

// Utilidad para esperar cualquiera de varios selectores
async function waitForSelectors(page, selectors, timeout=10000){
  const t0 = Date.now();
  for (;;){
    for (const sel of selectors){
      const h = await page.$(sel);
      if (h) return h;
    }
    if (Date.now()-t0 > timeout) return null;
    await page.waitForTimeout(150);
  }
}
