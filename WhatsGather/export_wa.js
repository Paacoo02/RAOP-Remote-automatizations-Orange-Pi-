const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { getDb, upsertContact } = require('./db.js'); // <-- ¡IMPORTAMOS LA DB!

// --- 1. LEER ARGUMENTOS ---
const sessionId = process.argv[2];
const keepLive = process.argv[3] === 'true';
const CONCURRENCY = parseInt(process.argv[4] || '1', 10);
const DAYS_BACK = 30;
const NAV_TIMEOUT = 60000;
const BLOCK_RESOURCES = ["image", "media", "font"];
const THRESHOLD_MS = daysAgoDate(DAYS_BACK).getTime();
const HEADLESS = process.env.PW_HEADLESS === "false" ? false : true;

if (!sessionId) {
  console.error('❌ Error fatal: No se proporcionó un ID de sesión.');
  process.exit(1);
}

// --- 2. CONFIGURACIÓN DINÁMICA ---
const dbPromise = getDb();
// ¡Asegurarnos de que apunta a la MISMA carpeta que auth.js!
const PROFILE_DIR = path.resolve(__dirname, 'sessions', sessionId); 

// ================ HELPERS ===================
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function daysAgoDate(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0,0,0,0);
  return d;
}
function shard(arr, k){
  const out = Array.from({length:k}, ()=>[]);
  arr.forEach((v,i)=> out[i%k].push(v));
  return out;
}
const logMem = (label = "") => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(2);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[CONSUMO] ${label} Script RAM (RSS): ${rss} MB | Heap JS: ${heap} MB`);
};

// ================== MAIN ====================
(async () => {
  ensureDir(PROFILE_DIR); // Asegura que la carpeta de sesión exista
  logMem("(Inicio Script)");

  console.log(`🎬 [Playwright] Lanzando Chromium para sesión: ${sessionId} - HEADLESS: ${HEADLESS}`);
  
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    args: [
      "--disable-dev-shm-usage",
      "--no-default-browser-check",
      "--no-first-run",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-extensions",
      "--disable-gpu", // Requerido para Xvfb
      "--no-sandbox",  // Requerido para Xvfb
      '--disable-images',
      '--disable-media-source',
      '--mute-audio',
    ],
    viewport: { width: 1200, height: 900 },
    locale: "es-ES",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  });

  // Pestaña maestra (para listar chats)
  const page = await context.newPage();
  await hardenPage(page);
  
  // ¡El QR se maneja aquí!
  await gotoWhatsApp(page); 

  // Guardar nuestro propio perfil
  await saveOwnProfile(page);

  // ¡NUEVA LÓGICA DE 30 DÍAS!
  // Obtén todos los chats que han tenido actividad en los últimos 30 días
  const chatsToScrape = await listAllChatsToScrape(page, THRESHOLD_MS);
  
  if (!chatsToScrape.length) {
    console.warn("⚠️ [Playwright] No se detectaron chats con actividad en los últimos 30 días.");
  } else {
    console.log(`📋 [Playwright] ${chatsToScrape.length} chats encontrados con actividad en los últimos 30 días.`);
  }

  // --- PROCESAMIENTO EN PARALELO (Tu lógica) ---
  const batches = shard(chatsToScrape, CONCURRENCY);
  console.log(`[Playwright] Iniciando ${CONCURRENCY} workers (tabs) en paralelo...`);
  logMem("(Inicio Paralelo)");

  await Promise.all(
    batches.map(async (chatTitles, idx) => {
      const p = await context.newPage(); // Una "tab" por worker
      await hardenPage(p);
      await gotoWhatsApp(p); // Asegura que la tab esté en WA (ya no pide QR)
      
      console.log(`[Worker ${idx+1}] Tiene ${chatTitles.length} chats asignados.`);
      for (const title of chatTitles) {
        try {
          console.log(`▶️ [Worker ${idx+1}] Procesando chat: ${title}`);
          await openChatBySearch(p, title);
          
          // ¡Aquí inyectamos tu scraper 'WhatsAppCounterAuto'!
          await exportChatToDb(p, title);

        } catch (e) {
          console.error(`❌ [Worker ${idx+1}] Error en chat ${title}:`, e.message);
        }
      }
      console.log(`[Worker ${idx+1}] Trabajo terminado. Cerrando tab.`);
      await p.close();
    })
  );

  logMem("(Fin Paralelo)");
  console.log("✅ [Playwright] Exportación completada.");
  
  if (keepLive) {
    console.log(`\n🎧 Modo "keepLive" activo. El navegador seguirá abierto.`);
    // (Nota: este script de Playwright no tiene 'setupLiveListener'.
    // Para eso, necesitaríamos inyectar un MutationObserver,
    // pero por ahora solo mantiene la sesión abierta)
  } else {
    console.log("Cerrando navegador.");
    await context.close();
    process.exit(0);
  }

})().catch(err => {
  console.error("❌ Error fatal en bot_playwright.js:", err);
  process.exit(1);
});

// ============== CORE FUNCTIONS (Playwright) ==============

async function hardenPage(page) {
  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (BLOCK_RESOURCES.includes(type)) return route.abort();
    route.continue();
  });
  page.setDefaultTimeout(NAV_TIMEOUT);
}

/**
 * Va a WhatsApp y maneja el QR (SOLO si es necesario)
 */
async function gotoWhatsApp(page){
  // --- ¡AQUÍ ESTÁ LA CORRECCIÓN! ---
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500); // Darle tiempo a cargar la sesión
  
  // Intentamos encontrar la lista de chats (sesión ya iniciada)
  // ¡ESTA ES LA PARTE CLAVE! Playwright buscará la sesión que 'auth.js' creó
  const pane = await page.locator("#pane-side, [data-testid='chat-list']").first().isVisible({ timeout: 10000 }).catch(() => false); // 10s

  if (!pane) {
    // Si no hay sesión (auth.js falló o el perfil se corrompió)
    console.log("💡 [Playwright] Sesión no encontrada. Mostrando QR en VNC (http://localhost:6081)");
    console.log("Esta es la autenticación de Playwright (Modo 'Crear Sesión' falló).");
    console.log("Escanea el QR (tienes 2 minutos)...");
    try {
      await page.waitForSelector("#pane-side, [data-testid='chat-list']", { timeout: 120000 }); // 2 minutos
      console.log("✅ [Playwright] ¡QR Escaneado! Sesión iniciada.");
    } catch (e) {
      console.error("❌ Error esperando el QR o la sesión:", e.message);
      throw new Error("Timeout esperando el escaneo del QR.");
    }
  } else {
    console.log("[Playwright] ✅ Sesión (de auth.js) cargada desde el perfil.");
  }
}

/**
 * ¡NUEVA FUNCIÓN!
 * Raspa la lista de chats Y sus timestamps, parando a los 30 días.
 */
async function listAllChatsToScrape(page, thresholdMs) {
  console.log("[Playwright] Leyendo lista de chats (haciendo scroll) hasta 30 días atrás...");
  const pane = await waitForSelectors(page, ["#pane-side", '[data-testid="chat-list"]'], 30000);
  if (!pane) return [];

  const chatsToScrape = new Set();
  let stagnation = 0;
  let hit30DayLimit = false;
  let prevCount = 0; // Para estancamiento
  let staticCount = 0; // Para estancamiento

  while (stagnation < 5 && !hit30DayLimit) {
    
    // page.evaluate se ejecuta en el navegador
    const result = await page.evaluate((localThresholdMs) => {
      const chatsFound = [];
      let foundOlder = false;
      const today = new Date();
      
      // Helper para parsear fechas relativas ("Ayer", "20:57", "12/11/2025")
      const parseTimestamp = (tsStr) => {
        if (!tsStr) return null;
        tsStr = tsStr.trim();
        const now = new Date();
        
        if (tsStr.includes(':')) { // Hoy (ej: "20:57")
          const [h, m] = tsStr.split(':').map(Number);
          return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
        }
        if (tsStr.toLowerCase() === 'ayer') {
          const yesterday = new Date(now);
          yesterday.setDate(now.getDate() - 1);
          return yesterday.setHours(12, 0, 0, 0); // Asumimos mediodía de ayer
        }
        if (tsStr.includes('/')) { // Fecha (ej: "12/11/2025")
          const [d, m, y] = tsStr.split('/').map(Number);
          // Ojo: Año puede ser 2025 o 25
          const fullYear = y < 100 ? y + 2000 : y;
          // Meses en JS son 0-11
          return new Date(fullYear, m - 1, d).getTime();
        }
        return null; // Formato no reconocido
      };

      // Tu HTML de <div role="row">
      const rows = document.querySelectorAll('#pane-side [role="row"], [data-testid="chat-list"] [role="row"]');
      
      for (const row of rows) {
        // Obtenemos el título (tu selector de span[title])
        const titleEl = row.querySelector('span[title]');
        if (!titleEl) continue;
        const title = titleEl.getAttribute('title');
        
        // Obtenemos la fecha (tu selector de _ak8i)
        const dateEl = row.querySelector('div[role="gridcell"][aria-colindex="2"] > div > div._ak8i');
        const dateStr = dateEl ? dateEl.textContent : null;
        
        const timestamp = parseTimestamp(dateStr);
        
        if (title && timestamp) {
          if (timestamp >= localThresholdMs) {
            chatsFound.push(title);
          } else {
            // ¡Hemos encontrado un chat demasiado antiguo!
            foundOlder = true;
          }
        } else if (title && !timestamp && dateStr) {
            // Caso raro: chat con fecha rara (ej: "Jueves")
            // Asumimos que es reciente si no podemos parsearlo
            chatsFound.push(title);
        }
      }
      return { chatsFound, foundOlder };

    }, thresholdMs); // Pasamos el límite al navegador

    // Añadimos los chats encontrados (Set maneja duplicados)
    result.chatsFound.forEach(title => chatsToScrape.add(title));

    if (result.foundOlder) {
      console.log("[Playwright] Límite de 30 días alcanzado en la lista de chats. Parando scroll.");
      hit30DayLimit = true;
    }

    // Scroll
    await page.evaluate(() => {
      const el = document.querySelector("#pane-side,[data-testid='chat-list']");
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(1000); // Más tiempo para cargar
    
    // (Lógica de estancamiento simple)
    const currentCount = chatsToScrape.size;
    staticCount = (currentCount === prevCount) ? (staticCount + 1) : 0;
    prevCount = currentCount;
    stagnation = staticCount;
  }

  return Array.from(chatsToScrape);
}


/**
 * Tu función 'openChatBySearch' (portada)
 */
async function openChatBySearch(page, title){
  // ... (idéntica a tu script original)
  const searchEl = await waitForSelectors(page, [
    '[data-testid="chatlist-search"] [contenteditable="true"]',
    '#side [contenteditable="true"][role="textbox"]',
    '#side [contenteditable="true"]',
  ], 5000);

  if (!searchEl) {
    await scrollToAndClickTitle(page, title);
    return;
  }

  await typeInSearch(page, title);

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

  await clearSearch(page).catch(()=>{});
  if (!ok) await scrollToAndClickTitle(page, title);
}

/**
 * Tu función 'typeInSearch' (portada)
 */
async function typeInSearch(page, text){
  // ... (idéntica a tu script original)
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

/**
 * Tu función 'clearSearch' (portada)
 */
async function clearSearch(page){
  // ... (idéntica a tu script original)
  await page.keyboard.down("Control").catch(()=>{});
  await page.keyboard.press("A").catch(()=>{});
  await page.keyboard.up("Control").catch(()=>{});
  await page.keyboard.press("Backspace").catch(()=>{});
  await page.waitForTimeout(120);
}

/**
 * Tu función 'scrollToAndClickTitle' (portada)
 */
async function scrollToAndClickTitle(page, title){
  // ... (idéntica a tu script original)
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
  throw new Error("No pude abrir el chat (scroll): " + title);
}

/**
 * Tu función 'waitForSelectors' (portada)
 */
async function waitForSelectors(page, selectors, timeout=10000){
  // ... (idéntica a tu script original)
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

// ===============================================
// --- ¡NUEVAS FUNCIONES (Playwright + DB)! ---
// ===============================================

/**
 * Guarda nuestro propio perfil ("Paco Ruiz") en la DB
 */
async function saveOwnProfile(page) {
  const db = await dbPromise;
  let profileName = "Perfil Desconocido";
  
  try {
    // 1. Abrir nuestro propio perfil
    await page.click('[data-testid="profile"]');
    await page.waitForTimeout(1000);
    
    // 2. Leer el nombre
    const nameHandle = await page.$('span[data-testid="contact-info-name"]');
    if (nameHandle) {
      profileName = await nameHandle.textContent();
    }
    
    // 3. Cerrar el panel
    await page.click('[data-testid="back"]');
    await page.waitForTimeout(500);

  } catch (e) {
    console.warn("[Playwright] No se pudo leer el nombre del perfil (quizás es un build antiguo):", e.message);
  }
  
  // 4. Guardar en la DB
  await db.run(
    'UPDATE Sessions SET description = ? WHERE sessionId = ?',
    profileName,
    sessionId
  );
  console.log(`[DB] Sesión ${sessionId} actualizada con el nombre: ${profileName}`);
}

/**
 * ¡NUEVA FUNCIÓN!
 * Inyecta y ejecuta tu 'WhatsAppCounterAuto' modificado.
 */
async function exportChatToDb(page, chatTitle){
  const db = await dbPromise;
  const THRESHOLD_MS_LOCAL = THRESHOLD_MS; // Límite de 30 días

  console.log(`[Scraper] Iniciando 'WhatsAppCounterAuto' para "${chatTitle}"...`);

  // page.evaluate ejecuta el código en el navegador
  const messagesFromBrowser = await page.evaluate(async (localThresholdMs) => {
    // --- INICIO DEL CÓDIGO INYECTADO (Tu WhatsAppCounterAuto) ---
    
    const seen = new Set();
    const messagesMap = new Map();
    let scroller = null;
    let running = true;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const getCopyables = () => document.querySelectorAll("div.copyable-text,[data-pre-plain-text]");

    // Función de parseo de fecha (¡crítica!)
    function parsePreDate(pre) {
      // Formato: [13:45, 13/09/2025]
      const m = pre.match(/\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\]/);
      if (m) {
        let [, hh, mm, dd, MM, yy] = m.map(Number);
        if (yy < 100) yy += 2000;
        return new Date(yy, MM - 1, dd, hh, mm);
      }
      // Formato: [13/09/2025, 13:45]
      const m2 = pre.match(/\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})\]/);
      if (m2) {
        let [, dd, MM, yy, hh, mm] = m2.map(Number);
        if (yy < 100) yy += 2000;
        return new Date(yy, MM - 1, dd, hh, mm);
      }
      return null;
    }

    // Tu función 'parseInfo' (modificada para usar el parser de fecha)
    function parseInfo(node) {
      const pre = node.getAttribute?.("data-pre-plain-text") || "";
      const textEl = node.querySelector?.("span.selectable-text") || node.querySelector?.("div.selectable-text");
      const text = textEl ? textEl.innerText : "";
      if (!pre && !text) return null;
      
      const uid = pre + "|" + text;
      let author = "";
      const m = pre.match(/\[.*?\]\s*(.*?):\s?$/);
      if (m) { author = m[1]; }
      
      const date = parsePreDate(pre);
      const timestamp = date ? date.getTime() : 0; // ms

      return { uid, ts: timestamp, author, text, pre };
    }

    // Tu función 'scan' (modificada para parar en el límite de 30 días)
    function scan() {
      let added = 0;
      let oldestFoundTimestamp = Infinity;
      
      getCopyables().forEach(node => {
        const info = parseInfo(node);
        if (!info) return;
        
        if (!seen.has(info.uid)) {
          seen.add(info.uid);
          
          if (info.ts >= localThresholdMs) {
            messagesMap.set(info.uid, info);
            added++;
          }
          
          if (info.ts > 0 && info.ts < oldestFoundTimestamp) {
            oldestFoundTimestamp = info.ts;
          }
        }
      });
      return { added, oldestFoundTimestamp };
    }

    // Tu función 'findScrollContainer' (sin cambios)
    function findScrollContainer(){
      const candidates = [
        '[data-testid="conversation-panel-body"]',
        '[data-testid="conversation-panel-messages"]',
        '#main [tabindex="-1"]',
        '#main'
      ].map(sel => document.querySelector(sel)).filter(Boolean);
      const anyMsg = getCopyables()[0];
      if (anyMsg){
        let p = anyMsg.parentElement;
        while (p){
          const st = getComputedStyle(p);
          if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 20) {
            candidates.push(p);
          }
          p = p.parentElement;
        }
      }
      const uniq = Array.from(new Set(candidates));
      uniq.sort((a,b)=> (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return uniq.find(el => el && el.scrollHeight > el.clientHeight + 20) || null;
    }

    // --- Tu función 'run' (el bucle principal) ---
    // (Modificada para la lógica de 30 días e interacción)
    
    scroller = findScrollContainer();
    if (!scroller) {
      console.warn("⚠️ [Scraper] No se encontró contenedor de scroll.");
      return Array.from(messagesMap.values());
    }

    const target = document.querySelector("#main") || document.body;
    const obs = new MutationObserver(() => scan());
    obs.observe(target, { subtree: true, childList: true });

    scan();
    const timer = setInterval(scan, 600);

    let stagnation = 0, rounds = 0, maxStagnation = 10;
    
    while (running) {
      rounds++;
      const before = seen.size;
      
      // --- LÓGICA DE INTERACCIÓN ---
      const clickToLoadButton = Array.from(document.querySelectorAll('div[role=button]'))
                                  .find(el => el.textContent.includes('Haz clic aquí para obtener mensajes anteriores'));
      if(clickToLoadButton) {
         console.log("[Scraper] 'Haz clic aquí' detectado, clickeando...");
         clickToLoadButton.click();
         await sleep(1500);
      }
      
      const failedButton = Array.from(document.querySelectorAll('div[role=button]'))
                                  .find(el => el.textContent.includes('No se pudieron obtener mensajes anteriores'));
      if(failedButton) {
         console.warn("[Scraper] 'No se pudieron obtener mensajes'. Parando scroll.");
         running = false;
      }

      if (!running) break;

      // Scroll
      try { scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll')); } catch(e) {}
      await sleep(600);
      
      const { added, oldestFoundTimestamp } = scan();
      const after = seen.size;
      
      stagnation = (added === 0 && after === before) ? (stagnation + 1) : 0;
      // console.log(`[Scraper] ↑ Ronda ${rounds} | total(vistos): ${after} | nuevas(validas): ${added} | estancamiento: ${stagnation}/${maxStagnation}`);
      
      if (stagnation >= maxStagnation) {
         console.log("[Scraper] Límite de estancamiento. Parando.");
         running = false;
      }
      
      // --- LÓGICA DE 30 DÍAS ---
      if (oldestFoundTimestamp < localThresholdMs) {
         console.log(`[Scraper] Límite de 30 días alcanzado. Parando.`);
         running = false;
      }
    }

    try { obs.disconnect(); } catch(e) {}
    try { clearInterval(timer); } catch(e) {}

    // ¡Devolvemos los datos!
    return Array.from(messagesMap.values());
    
    // --- FIN DEL CÓDIGO INYECTADO ---
  }, THRESHOLD_MS); // Pasamos el límite de 30 días a la función

  // --- DE VUELTA EN NODE.JS ---
  
  if (!messagesFromBrowser) {
    console.warn(`[Scraper] No se devolvieron mensajes de "${chatTitle}". (Scroller no encontrado?)`);
    return;
  }
  
  console.log(`[DB] Recibidos ${messagesFromBrowser.length} mensajes (últimos 30 días) del scraper para "${chatTitle}". Guardando...`);
  
  let messagesSavedCount = 0;
  
  // 1. Guardar el Contacto/Grupo
  await upsertContact({
    id: chatTitle, // Usamos el título como ID
    name: chatTitle,
    pushname: chatTitle,
    isGroup: false // Playwright no puede saber esto fácilmente
  });

  // 2. Guardar Mensajes
  for (const msg of messagesFromBrowser) {
    let senderId = 'YO@c.us'; // Asumimos 'Yo'
    if (msg.author) { // Author fue parseado por tu script
      senderId = msg.author; // Usamos el nombre como ID
      await upsertContact({
        id: senderId,
        name: msg.author,
        pushname: msg.author,
        isGroup: false
      });
    }
    
    try {
      await db.run(
        'INSERT OR IGNORE INTO Messages (messageId, chatId, senderId, body, timestamp) VALUES (?, ?, ?, ?, ?)',
        msg.uid, // El UID único de tu script
        chatTitle,
        senderId,
        msg.text,
        Math.floor(msg.ts / 1000) // Convertir ms a timestamp UNIX (segundos)
      );
      messagesSavedCount++;
    } catch (e) {
      if (!e.message.includes('UNIQUE constraint failed')) { // Ignorar duplicados
        console.error(`Error SQL guardando mensaje ${msg.uid}: ${e.message}`);
      }
    }
  }
  console.log(`[DB] Chat '${chatTitle}' procesado. ${messagesSavedCount} mensajes nuevos guardados.`);
}