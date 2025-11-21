// export_wa.js
// VERSIÓN: UN (1) NAVEGADOR, UNA (1) PESTAÑA. 100% SECUENCIAL.
//
// ARQUITECTURA (3 FASES)
// *** MODO BAJO CONSUMO (SIN IMÁGENES/MEDIA, A NIVEL DE CONTEXTO)
// *** FASE 1 MULTIPASS PARA FECHAS "CARGANDO..."
// *** FASE 2 SECUENCIAL: UNA SOLA PESTAÑA PROCESA TODOS LOS CHATS UNO POR UNO
// *** FASE 3 REINTENTOS PARA CHATS CON BANNERS (SINCRONIZACIÓN / TELÉFONO)

const { firefox } = require("playwright");
const path = require("path");
const fs = require("fs");
const { getDb } = require("./db.js");

// -------------------------------------------------------------
//  CONFIG / ENV
// -------------------------------------------------------------

const sessionId = process.argv[2];
const HEADLESS = process.env.PW_HEADLESS === "false" ? false : true;
const MAX_DAYS = parseInt(process.env.WA_MAX_DAYS || "30", 10);

// --- Parámetros FASE 1 (multipass "cargando...") ---
const FASE1_UNKNOWN_LIMIT = parseInt(
  process.env.WA_FASE1_UNKNOWN_LIMIT || "5",
  10
);
const FASE1_RELOAD_BASE_WAIT_SEC = parseInt(
  process.env.WA_FASE1_BASE_WAIT_SEC || "240",
  10
);
const FASE1_RELOAD_STEP_WAIT_SEC = parseInt(
  process.env.WA_FASE1_STEP_WAIT_SEC || "60",
  10
);

if (!sessionId) {
  console.error(
    "❌ Error fatal: No se proporcionó un ID de sesión a export_wa.js."
  );
  process.exit(1);
}

const SESSION_PATH = path.resolve(__dirname, "sessions", sessionId);
const USER_DATA_DIR = path.join(SESSION_PATH, "pw_user_data");
const EXPORT_DIR = path.resolve(__dirname, "exports", sessionId);
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const dbPromise = getDb();

// -------------------------------------------------------------
//  UTILIDADES GENERALES
// -------------------------------------------------------------

function nowTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sanitizeFilename(name = "whatsapp_chat") {
  let n = String(name)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) n = "whatsapp_chat";
  if (n.length > 120) n = n.slice(0, 120).trim();
  return n;
}

function parseChatDate(label, now = new Date()) {
  if (label == null) return null;
  const raw = String(label).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (lower.includes("cargando") || lower.includes("loading")) {
    return null;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const timeMatch = lower.match(/^(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const timeStr = raw.replace(/\./g, "").toLowerCase();
    const isPM = timeStr.includes("p") || timeStr.includes("pm");
    let h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    if (isPM && h < 12) h += 12;
    if ((timeStr.includes("a") || timeStr.includes("am")) && h === 12) h = 0;
    const d = new Date(today);
    d.setHours(h, m, 0, 0);
    return d;
  }

  if (lower === "hoy") return today;
  if (lower === "ayer") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }

  const canonicalWeek = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];
  const altMap = { miercoles: "miércoles", sabado: "sábado" };
  let wd = lower;
  if (altMap[wd]) wd = altMap[wd];
  let idx = canonicalWeek.indexOf(wd);
  if (idx !== -1) {
    const todayIdx = today.getDay();
    let diff = todayIdx - idx;
    if (diff < 0) diff += 7;
    if (diff === 0) diff = 7;
    const d = new Date(today);
    d.setDate(d.getDate() - diff);
    return d;
  }

  const dateMatch = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (dateMatch) {
    let day = parseInt(dateMatch[1], 10);
    let month = parseInt(dateMatch[2], 10);
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, month - 1, day);
  }

  console.warn(
    `[ParseDate] Etiqueta desconocida: "${label}", se considera fecha no disponible.`
  );
  return null;
}

// Banners de historial/sincronización
const PHONE_HISTORY_TEXT_PATTERNS = [
  "haz clic aquí para obtener mensajes anteriores de tu teléfono",
  "usa whatsapp en tu teléfono para ver mensajes anteriores",
  "usar whatsapp en tu teléfono para ver mensajes anteriores",
  "mensajes anteriores de tu teléfono",
  "usar el teléfono para ver mensajes anteriores",
  "click here to get older messages from your phone",
  "use whatsapp on your phone to see older messages",
];

const SYNC_IN_PROGRESS_TEXT_PATTERNS = [
  "se están sincronizando mensajes más antiguos",
  "se estan sincronizando mensajes mas antiguos",
  "older messages are being synchronized",
  "older messages are being synced",
];

async function hasPhoneHistoryBanner(page) {
  try {
    const locator = page.locator('div[data-testid="chat-history-sync-banner"]');
    if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  } catch {}

  try {
    const text = await page.evaluate(() => document.body.innerText || "");
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    return PHONE_HISTORY_TEXT_PATTERNS.some((p) => normalized.includes(p));
  } catch {
    return false;
  }
}

async function hasSyncInProgressBanner(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText || "");
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    return SYNC_IN_PROGRESS_TEXT_PATTERNS.some((p) => normalized.includes(p));
  } catch {
    return false;
  }
}

async function clickSyncInProgressBanner(page) {
  try {
    const clicked = await page.evaluate((patterns) => {
      const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const pats = patterns.map(norm);

      const isBannerText = (t) => {
        const nt = norm(t || "");
        return pats.some((p) => nt.includes(p));
      };

      const els = Array.from(
        document.querySelectorAll("div, span, button, [role='button']")
      );

      for (const el of els) {
        if (!el.innerText) continue;
        if (!isBannerText(el.innerText)) continue;

        let target = el;
        for (let i = 0; i < 3; i++) {
          if (!target) break;
          const style = window.getComputedStyle(target);
          const isButtonish =
            target.tagName === "BUTTON" ||
            target.getAttribute("role") === "button";
          const hasPointer = style.cursor === "pointer";
          if (isButtonish || hasPointer) break;
          target = target.parentElement;
        }

        (target || el).dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
        return true;
      }
      return false;
    }, SYNC_IN_PROGRESS_TEXT_PATTERNS);
    return clicked;
  } catch {
    return false;
  }
}

function markChatIncomplete(incompleteMap, chat, reason) {
  const existing = incompleteMap.get(chat.key);
  if (!existing) {
    incompleteMap.set(chat.key, { ...chat, reason });
  } else {
    const prev = existing.reason || "";
    if (!prev.includes(reason)) {
      existing.reason = prev ? `${prev},${reason}` : reason;
    }
  }
}

// -------------------------------------------------------------
//  SCRAPER INTEGRADO (TU CÓDIGO ADAPTADO A NODE)
// -------------------------------------------------------------
// -------------------------------------------------------------
//  SCRAPER: TU CÓDIGO EXACTO + DETECCIÓN DE SINCRONIZACIÓN
// -------------------------------------------------------------
// -------------------------------------------------------------
//  SCRAPER: TU CÓDIGO EXACTO + SENSOR DE MURO CON RETARDO (3s)
// -------------------------------------------------------------
// -------------------------------------------------------------
//  SCRAPER TURBO: CSS HACK + SENSOR DE MURO
// -------------------------------------------------------------
async function exportCurrentChatFromPage(page) {
  return await page.evaluate(async () => {
    // ⚡ HACK DE RENDIMIENTO: Ocultar media y anular animaciones
    // Esto reduce drásticamente el uso de CPU/GPU al hacer scroll
    const styleId = 'wa-turbo-mode-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            * { transition: none !important; animation: none !important; }
            img, video, canvas { display: none !important; } 
            div[role="button"] img { display: none !important; }
            /* Mantener solo texto visible */
        `;
        document.head.appendChild(style);
        console.log("[Browser] ⚡ Turbo Mode CSS inyectado (Imágenes ocultas).");
    }

    if (window.__waCounterAuto) { try { window.__waCounterAuto.stop(); } catch(e){} }

    const seen = new Set();
    const messagesMap = new Map();
    let scroller = null, running = true;
    let syncWallHit = false;
    let jumpAnchor = null;

    // Reducimos tiempo de espera entre scrolls (de 600 a 400ms)
    // Al no haber imágenes, carga más rápido.
    const SCROLL_DELAY = 400; 
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    
    const getCopyables = () => document.querySelectorAll("div.copyable-text,[data-pre-plain-text], div.message-in, div.message-out");

    const WALL_TEXTS = [
      "Haz clic aquí para obtener mensajes anteriores",
      "No se pudieron obtener mensajes anteriores",
      "Abre WhatsApp en tu teléfono",
      "Se están sincronizando mensajes más antiguos",
      "mensajes anteriores de tu teléfono"
    ];

    function parseInfo(node){
      const pre = node.getAttribute?.("data-pre-plain-text") || "";
      // Selectores optimizados
      const textEl = node.querySelector("span.selectable-text") || node.querySelector("div.selectable-text");
      const text = textEl ? textEl.innerText : (node.innerText || "");
      
      if (!pre && !text) return null;
      
      const uid = pre + "|" + text.substring(0, 40);
      let ts = "", author = "";
      const m = pre.match(/\[(.*?)\]\s*(.*?):\s?$/);
      if (m){ ts = m[1]; author = m[2]; }
      return { uid, ts, author, text: text.replace(/\r?\n/g, " "), pre };
    }

    function scan(){
      let added = 0;
      const nodes = getCopyables();
      // Bucle for clásico es ligeramente más rápido que forEach en V8 antiguo, pero aquí da igual
      for (const node of nodes) {
        const info = parseInfo(node);
        if (!info) continue;
        if (!seen.has(info.uid)){
          seen.add(info.uid);
          messagesMap.set(info.uid, info);
          added++;
        }
      }
      return added;
    }

    function checkForSyncWall() {
       const main = document.querySelector("#main");
       if (!main) return false;
       // Usamos textContent que es más barato que innerText (no calcula estilos)
       const txt = main.textContent; 
       for (const w of WALL_TEXTS) {
           if (txt.includes(w)) return true;
       }
       return false;
    }

    function getOldestVisibleText() {
        const nodes = getCopyables();
        if (nodes.length > 0) {
            const info = parseInfo(nodes[0]); 
            if (info && info.text && info.text.length > 5) return info.text.substring(0, 50);
        }
        return null;
    }

    function getChatTitle(){
        // Lógica simplificada de título
        const h = document.querySelector("#main header span[title]");
        return h ? (h.getAttribute("title") || h.innerText) : "chat";
    }

    function findScrollContainer(){
      // Buscamos el panel de mensajes directamente
      // El ID "main" suele contener un div con tabindex="-1" que es el scroller
      const main = document.getElementById('main');
      if (!main) return null;
      
      // Estrategia rápida: buscar el div más grande con overflow
      const divs = main.querySelectorAll('div[tabindex="-1"]');
      for (const d of divs) {
          if (d.scrollHeight > d.clientHeight) return d;
      }
      return null;
    }

    async function run(){
      scroller = findScrollContainer();
      if (!scroller){ scan(); return; }

      // MutationObserver es caro en CPU si hay muchos cambios.
      // En modo Turbo, confiamos más en el intervalo y el scroll.
      // const obs = new MutationObserver(()=> scan()); ... (Desactivado para ahorrar CPU)

      scan();
      
      // Polling más rápido
      const timer = setInterval(scan, 500);

      let stagnation = 0, rounds = 0, maxStagnation = 8; // Bajamos estancamiento a 8
      
      while (running) {
        if (checkForSyncWall()) {
            // Check rápido
            console.log("[Browser] 🧱 Muro detectado. Confirmando...");
            await sleep(2500);
            if (checkForSyncWall()) {
                syncWallHit = true;
                jumpAnchor = getOldestVisibleText();
                break; 
            }
        }

        rounds++;
        const before = seen.size;
        
        // Scroll agresivo
        try { scroller.scrollTop = 0; } catch(e){}
        
        await sleep(SCROLL_DELAY);
        const added = scan();
        const after = seen.size;
        
        stagnation = (added === 0 && after === before) ? (stagnation+1) : 0;
        if (stagnation >= maxStagnation) break;
      }

      try { clearInterval(timer); } catch(e){}
      running = false;
    }

    await run();

    // Retorno optimizado
    const lines = [];
    for (const info of messagesMap.values()){
       // Concatenación directa es rápida
       lines.push(`[${info.ts||""}] ${info.author||"Yo"}: ${info.text}`);
    }

    return {
        title: getChatTitle(),
        count: messagesMap.size,
        fullText: lines.join("\n"),
        syncRequired: syncWallHit,
        jumpQuery: jumpAnchor
    };
  });
}

// -------------------------------------------------------------
//  UTILIDADES LISTA DE CHATS (FASE 1)
// -------------------------------------------------------------

async function getVisibleChats(page) {
  return await page.evaluate(() => {
    const res = [];
    const grid = document.querySelector(
      '#pane-side [aria-label="Lista de chats"][role="grid"]'
    );
    if (!grid) return res;

    const rows = grid.querySelectorAll('[role="row"]');
    rows.forEach((row, index) => {
      const titleSpan = row.querySelector('span[title][dir="auto"]');
      const title =
        (titleSpan &&
          (titleSpan.getAttribute("title") || titleSpan.textContent)) ||
        "";
      if (!title) return;

      const timeContainer = row.querySelector("div._ak8i");
      const timeLabel =
        (timeContainer && timeContainer.textContent.trim()) || "";

      const snippetSpan = row.querySelector(
        'span[data-testid="last-message-preview"]'
      );
      const snippet = (snippetSpan && snippetSpan.textContent.trim()) || "";

      const rect = row.getBoundingClientRect();
      const top = rect.top;

      const snLower = snippet.toLowerCase();
      const snippetForKey =
        snLower.includes("cargando") || snLower.includes("loading")
          ? ""
          : snippet;

      const key = `${title}|${timeLabel}|${snippetForKey}`;
      const rowLocatorSelector = `div[role="row"]:has(span[title="${title.replace(
        /"/g,
        '\\"'
      )}"])`;
      res.push({
        key,
        title,
        timeLabel,
        snippet,
        index,
        top,
        rowLocatorSelector,
      });
    });

    res.sort((a, b) => a.top - b.top);
    return res;
  });
}

async function scrollChatListDown(page) {
  return await page.evaluate(() => {
    const scrollPane = document.querySelector("#pane-side");
    if (!scrollPane) return false;
    const before = scrollPane.scrollTop;
    scrollPane.scrollTop = before + scrollPane.clientHeight * 0.9;
    return scrollPane.scrollTop > before;
  });
}

async function scrollChatListToTop(page) {
  console.log(
    `[${nowTs()}] [Debug] Scrolleando la lista de chats al inicio...`
  );
  await page.evaluate(() => {
    const scrollPane = document.querySelector("#pane-side");
    if (scrollPane) {
      scrollPane.scrollTop = 0;
    }
  });
}

// -------------------------------------------------------------
//  FASE 1: PASADA INTERNA
// -------------------------------------------------------------

async function phase1_discoverChats_singlePass(page) {
  console.log(
    `\n[${nowTs()}] [FASE 1] (Pasada interna) Explorando lista de chats...`
  );

  const chatsToProcess = [];
  const processedKeys = new Set();
  const now = new Date();
  let stopByOldChat = false;
  let chatScanCount = 0;
  const lastRowTimeSelector = `#pane-side [role="row"]:last-child div._ak8i`;

  const pendingUnknownMap = new Map();
  let lastValidChat = null;
  let lastValidChatDate = null;

  let consecutiveUnknown = 0;
  let hitUnknownLimit = false;

  while (!stopByOldChat && !hitUnknownLimit) {
    await page
      .waitForSelector(lastRowTimeSelector, { timeout: 10000 })
      .catch(() =>
        console.log(
          "[Debug] La etiqueta de la última hora tardó en cargar o no apareció. Leyendo vista actual."
        )
      );

    const chats = await getVisibleChats(page);

    if (!chats.length && processedKeys.size === 0) {
      console.log(
        "⚠️ No se han encontrado filas de chat visibles (Lista vacía)."
      );
      break;
    }

    let foundNewChatInView = false;

    for (const chat of chats) {
      if (processedKeys.has(chat.key)) continue;

      processedKeys.add(chat.key);
      foundNewChatInView = true;
      chatScanCount++;

      if (chat.title === "WhatsApp") {
        console.log(
          `[FASE 1] Omitiendo chat oficial del sistema: "${chat.title}"`
        );
        continue;
      }

      const lastDate = parseChatDate(chat.timeLabel, now);
      const pendKey = (chat.title || "").trim();

      if (!lastDate) {
        consecutiveUnknown++;

        if (!pendingUnknownMap.has(pendKey)) {
          pendingUnknownMap.set(pendKey, chat);
        }

        console.log(
          `[FASE 1] Aviso: fecha/hora aún NO disponible para "${chat.title}" ` +
            `(timeLabel="${chat.timeLabel || "(vacío)"}", snippet="${
              chat.snippet || ""
            }"). Se omite en este análisis para NO asumir que es de hoy.`
        );

        if (consecutiveUnknown >= FASE1_UNKNOWN_LIMIT) {
          console.log(
            `[FASE 1] ⚠️ Se han detectado ${FASE1_UNKNOWN_LIMIT} chats CONSECUTIVOS con fecha/hora no disponible (vacío / "cargando"). ` +
              "Probable carga diferida de WhatsApp. Cortando esta pasada para forzar recarga de la página antes de seguir."
          );
          hitUnknownLimit = true;
          break;
        }
        continue;
      }

      consecutiveUnknown = 0;

      if (pendingUnknownMap.has(pendKey)) {
        pendingUnknownMap.delete(pendKey);
      }

      const diffDays = (now - lastDate) / (1000 * 60 * 60 * 24);
      const parsedDateStr = lastDate.toLocaleDateString("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      console.log(
        `[FASE 1] Analizando chat #${chatScanCount}: "${chat.title}" ` +
          `(etiqueta: "${chat.timeLabel}" -> parseado: ${parsedDateStr} ≈ ${diffDays.toFixed(
            1
          )} días)`
      );

      if (diffDays > MAX_DAYS) {
        console.log(
          `⏹️  Parando análisis: Chat "${chat.title}" está fuera de rango (> ${MAX_DAYS} días).`
        );
        stopByOldChat = true;
        break;
      }

      chatsToProcess.push(chat);
      lastValidChat = chat;
      lastValidChatDate = lastDate;
    }

    if (stopByOldChat || hitUnknownLimit) break;

    if (!foundNewChatInView) {
      console.log("[FASE 1] Scrolleando para buscar más chats...");
      const couldScroll = await scrollChatListDown(page);

      if (!couldScroll) {
        console.log(
          "ℹ️ [FASE 1] Fin de la lista de chats (no se pudo scrollear más)."
        );
        break;
      }
      await page.waitForTimeout(1500);
    }
  }

  const pendingUnknown = Array.from(pendingUnknownMap.values());

  return {
    chatsToProcess,
    pendingUnknown,
    stopByOldChat,
    lastValidChat,
    lastValidChatDate,
    chatScanCount,
    hitUnknownLimit,
  };
}

// -------------------------------------------------------------
//  FASE 1: BUCLE MULTIPASS
// -------------------------------------------------------------

async function phase1_discoverChats(page) {
  console.log(
    `\n[${nowTs()}] [FASE 1] Iniciando análisis de chats con MULTIPASS (límite: ${MAX_DAYS} días, pasadas ilimitadas hasta detectar el "límite" de WhatsApp).`
  );

  const globalChats = [];
  const globalKeys = new Set();
  let totalScannedAcrossPasses = 0;

  let lastValidChat = null;
  let lastValidChatDate = null;
  let pendingUnknown = [];
  let stopByOldChat = false;

  let pass = 0;
  let reloadCount = 0;

  while (true) {
    pass++;
    console.log(`\n[FASE 1] ===== PASADA ${pass} =====\n`);

    await scrollChatListToTop(page);
    await page.waitForTimeout(1000);

    const result = await phase1_discoverChats_singlePass(page);

    totalScannedAcrossPasses += result.chatScanCount;

    for (const chat of result.chatsToProcess) {
      if (!globalKeys.has(chat.key)) {
        globalKeys.add(chat.key);
        globalChats.push(chat);
      }
    }

    if (result.lastValidChat && result.lastValidChatDate) {
      if (!lastValidChatDate || result.lastValidChatDate > lastValidChatDate) {
        lastValidChat = result.lastValidChat;
        lastValidChatDate = result.lastValidChatDate;
      }
    }

    pendingUnknown = result.pendingUnknown;
    stopByOldChat = result.stopByOldChat;

    console.log(
      `[${nowTs()}] [FASE 1] Fin de PASADA ${pass} → ${result.chatScanCount} chats analizados en esta pasada.`
    );

    if (!stopByOldChat && !pendingUnknown.length && !result.hitUnknownLimit) {
      console.log(
        "[FASE 1] Fin de la lista alcanzado en esta pasada (no se encontró chat fuera de rango ni chats con fecha/hora pendiente)."
      );
      break;
    }

    if (stopByOldChat && !pendingUnknown.length) {
      console.log(
        "[FASE 1] No quedan chats con fecha/hora no disponible dentro del rango. No son necesarias más pasadas."
      );
      break;
    }

    if (pendingUnknown.length && !result.hitUnknownLimit) {
      console.log(
        `[FASE 1] Hay ${pendingUnknown.length} chats con fecha/hora no disponible, ` +
          "pero no se alcanzó el límite consecutivo en esta pasada. No se fuerza recarga adicional para evitar bucles infinitos."
      );
      break;
    }

    if (pendingUnknown.length && result.hitUnknownLimit) {
      reloadCount++;
      const waitSec =
        FASE1_RELOAD_BASE_WAIT_SEC +
        FASE1_RELOAD_STEP_WAIT_SEC * (reloadCount - 1);

      console.log(
        `[FASE 1] Aún hay ${pendingUnknown.length} chats con fecha/hora NO disponible dentro del rango actual.\n` +
          "        Reintentando Fase 1 tras recargar la página para dar tiempo a que WhatsApp cargue las fechas..."
      );
      console.log(
        `\n[FASE 1] 🔁 Se alcanzó el límite de ${FASE1_UNKNOWN_LIMIT} chats con fecha/hora no disponible en la pasada ${pass}.`
      );
      console.log(
        `[FASE 1]     Recargando la página (recarga #${reloadCount}) y esperando ${waitSec}s para que WhatsApp complete la carga de fechas antes de la siguiente pasada...`
      );

      try {
        await page.reload({ waitUntil: "domcontentloaded" });
      } catch (e) {
        console.warn(
          "[FASE 1] ⚠️ Error al recargar la página:",
          e && e.message
        );
      }

      await page.waitForTimeout(waitSec * 1000);
      continue;
    }

    break;
  }

  if (pendingUnknown.length) {
    console.log(
      `\n[FASE 1] ⚠️ Tras todas las pasadas siguen quedando ${pendingUnknown.length} chats ` +
        "con fecha/hora no disponible. Se omiten en este run (posible limitación de WhatsApp Web)."
    );
  }

  console.log(`\n[${nowTs()}] [FASE 1] Análisis completado (multipass).`);
  console.log(
    `   > Se escanearon secuencialmente ${totalScannedAcrossPasses} chats en total.`
  );
  console.log(
    `   > Se encontraron ${globalChats.length} chats que cumplen el requisito de ${MAX_DAYS} días.`
  );
  if (lastValidChat && lastValidChatDate) {
    const parsedDateStr = lastValidChatDate.toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    console.log(
      `   > El último chat válido es "${lastValidChat.title}" (fecha: ${parsedDateStr}).`
    );
  }

  return globalChats;
}

// -------------------------------------------------------------
//  FASE 2: BÚSQUEDA Y APERTURA
// -------------------------------------------------------------

async function getChatSearchBox(page) {
  const selectors = [
    '#side [contenteditable="true"][data-tab="3"]',
    'div[role="textbox"][contenteditable="true"][data-tab="3"]',
    '#side [contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    try {
      if ((await loc.count()) > 0) return loc.first();
    } catch {}
  }
  return null;
}

// ✅ NORMALIZACIÓN CORREGIDA: conservamos "/" para no convertir "25/10" en "2510"
function normalizeChatTitleForSearch(chatTitle) {
  if (!chatTitle) return "";
  try {
    const cleaned = chatTitle
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // quitar acentos
      // Permitimos letras, números, espacios y "/" (quitamos emojis, etc.)
      .replace(/[^\p{Letter}\p{Number}\s\/]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned;
  } catch {
    // fallback sin Unicode properties
    return chatTitle.replace(/[^\w\s\/]/g, "").trim();
  }
}

// -------------------------------------------------------------
//  FUNCIÓN DE APERTURA: FUERZA BRUTA (COORDENADAS FÍSICAS)
// -------------------------------------------------------------
// -------------------------------------------------------------
//  FUNCIÓN DE APERTURA: TECLADO PURO (Flecha Abajo + Enter)
// -------------------------------------------------------------
// -------------------------------------------------------------
//  APERTURA RÁPIDA (TIEMPOS AJUSTADOS)
// -------------------------------------------------------------
async function openChatByTitle(page, chatTitle) {
  const searchBox = await getChatSearchBox(page);
  if (!searchBox) throw new Error("Buscador no encontrado.");

  const cleanTitle = chatTitle.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

  console.log(`[FASE 2] Buscando: "${cleanTitle}"`);

  await searchBox.click();
  
  // Limpieza rápida (Triple clic selecciona todo el texto habitualmente)
  await searchBox.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  
  // Escritura rápida (30ms delay es suficiente para WA)
  await page.keyboard.type(cleanTitle, { delay: 30 });
  
  // Espera reducida (1.2s suele bastar para que filtre localmente)
  await page.waitForTimeout(1200);

  // Selección Teclado
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100); // Mínima espera
  await page.keyboard.press("Enter");

  // Limpieza UI
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape"); 
  await page.waitForTimeout(1000);
}

// -------------------------------------------------------------
//  FASE 2: PROCESO DE UN SOLO CHAT
// -------------------------------------------------------------

// -------------------------------------------------------------
//  NUEVA FUNCIÓN: ESPERAR A QUE EL HEADER COINCIDA
// -------------------------------------------------------------
async function waitForCurrentChatToLoad(page, targetTitle) {
  // Función de normalización (Ejecutada en Node.js, fuera del navegador)
  const normalize = (s) => {
    if (!s) return "";
    try {
      return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{Letter}\p{Number}\s\/]/gu, "")
        .replace(/\s+/g, " ").trim().toLowerCase();
    } catch {
      return s.replace(/[^\w\s\/]/g, "").trim().toLowerCase();
    }
  };

  const targetNorm = normalize(targetTitle);
  const maxWaitMs = 10000; // 10 segundos máximo
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      // SOLO extraemos el texto. No ejecutamos lógica compleja dentro.
      const currentTitleRaw = await page.evaluate(() => {
        const headerEl = document.querySelector('#main header span[title]');
        if (!headerEl) return "";
        return headerEl.getAttribute('title') || headerEl.innerText || "";
      });

      const currentNorm = normalize(currentTitleRaw);

      // Comparamos aquí, en la terminal (Node.js), donde WhatsApp no puede bloquearnos
      if (currentNorm && (currentNorm.includes(targetNorm) || targetNorm.includes(currentNorm))) {
        return true;
      }
    } catch (e) {
      // Ignoramos errores momentáneos de contexto
    }

    // Esperamos medio segundo antes de volver a preguntar
    await page.waitForTimeout(500);
  }

  console.warn(`[WaitHeader] Timeout: El header actual es distinto a "${targetTitle}" tras 10s.`);
  return false;
}

// -------------------------------------------------------------
//  FASE 2: PROCESO DE UN SOLO CHAT (CORREGIDO)
// -------------------------------------------------------------
async function performSearchJump(page, chat) {
  if (!chat.jumpQuery) {
      console.warn(`[JUMP] ⚠️ No hay texto para saltar en "${chat.title}".`);
      return false;
  }
  console.log(`[JUMP] 🚀 Saltando en "${chat.title}" a: "${chat.jumpQuery.substring(0, 20)}..."`);

  try {
      // 1. Abrir Lupa del CHAT (la de dentro del chat, no la lateral)
      // A veces está escondida en el menú de 3 puntos, pero suele estar visible
      const chatSearchBtn = page.locator('#main header span[data-testid="search-alt"]');
      if (await chatSearchBtn.isVisible()) {
           await chatSearchBtn.click();
      } else {
           console.warn("[JUMP] No veo el botón de lupa en el chat.");
           return false;
      }
      await page.waitForTimeout(500);

      // 2. Escribir frase
      const searchInput = page.locator('#app [contenteditable="true"][role="textbox"]').first();
      await searchInput.fill(chat.jumpQuery);
      await page.waitForTimeout(2000);

      // 3. Clic en resultado
      const results = page.locator('div[aria-label*="Resultados"] [role="button"], div[aria-label*="Search results"] [role="button"]');
      if (await results.count() > 0) {
          await results.last().click(); // El último suele ser el más viejo
          console.log(`[JUMP] ⏳ Esperando sincronización (15s)...`);
          await page.waitForTimeout(15000); // Dar tiempo a cargar
          
          // Cerrar búsqueda
          const closeSearch = page.locator('div[aria-label="Cerrar"], span[data-testid="x-alt"]');
          await closeSearch.click().catch(()=>{});
          return true;
      }
  } catch (e) {
      console.error(`[JUMP] Error: ${e.message}`);
  }
  return false;
}
async function processSingleChatOnPage(page, chat, db, retryList, incompleteMap, index, total) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`\n[${nowTs()}] [FASE 2] Procesando chat ${index}/${total}: "${chat.title}" (intento ${attempt}/${maxAttempts})`);

      // 1. Abrir
      await openChatByTitle(page, chat.title);
      
      // 2. Verificar carga (Footer)
      try {
        await page.waitForSelector('footer, [data-testid="box-chat-footer"], [role="application"]', { timeout: 10000 });
        console.log("[FASE 2] ✅ Interfaz de chat cargada.");
      } catch (e) {
        throw new Error("No se cargó la interfaz del chat (footer no visible).");
      }

      // 3. Extraer
      console.log(`[FASE 2] 📤 Extrayendo mensajes...`);
      const exportResult = await exportCurrentChatFromPage(page);

      // 4. Guardar
      if (exportResult && exportResult.count > 0) {
        const title = exportResult.title || chat.title || "whatsapp_chat";
        const sanitized = sanitizeFilename(title);
        const filePath = path.join(EXPORT_DIR, `${sanitized}.txt`);

        // Guardamos el texto completo devuelto por el navegador
        fs.writeFileSync(filePath, exportResult.fullText, "utf8");
        console.log(`[FASE 2] ✅ Guardado "${filePath}" (${exportResult.count} mensajes)`);
        
        try { await db.run("INSERT INTO Exports(sessionId, chatTitle, filePath, exportedAt) VALUES(?,?,?,datetime('now'))", sessionId, title, filePath); } catch(e){}
      }

      // 🔴 LÓGICA DE REINTENTO (JUMP)
      if (exportResult.syncRequired) {
          console.log(`[FASE 2] 🧱 Muro de sincronización detectado. Se programará SALTO.`);
          retryList.push({
             ...chat,
             jumpQuery: exportResult.jumpQuery, // Guardamos la frase clave
             reason: "sync-wall"
          });
      } else {
          console.log(`[FASE 2] 🟢 Chat completado sin muros.`);
      }

      return true; 

    } catch (e) {
      console.warn(`[FASE 2] ⚠️ Intento ${attempt} fallido: ${e.message}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      if (attempt >= 3) await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
  
  markChatIncomplete(incompleteMap, chat, "max-attempts-reached");
  return false;
}

// -------------------------------------------------------------
//  FASE 2: EXTRACCIÓN SECUENCIAL
// -------------------------------------------------------------

// -------------------------------------------------------------
//  FASE 2: EXTRACCIÓN TURBO (CON GESTIÓN DE MEMORIA)
// -------------------------------------------------------------
async function phase2_extractChats_Sequential(initialPage, chatList, incompleteMap) {
  console.log(`\n[${nowTs()}] [FASE 2] 🚀 Iniciando TURBO MODE secuencial...`);

  const db = await dbPromise;
  const retryList = [];
  const totalChats = chatList.length;
  
  // CONFIGURACIÓN TURBO
  const CHATS_PER_CYCLE = 15; // Reiniciar navegador cada 15 chats (ajustable)
  const MAX_RAM_MB = 900;     // Si Node usa más de 900MB, forzar limpieza
  
  let page = initialPage; // Puntero a la página activa
  let chatsSinceRestart = 0;

  for (let i = 0; i < totalChats; i++) {
    const chat = chatList[i];
    const myIndex = i + 1;
    
    // 1. MONITORIZACIÓN
    const mem = getMemoryUsage();
    chatsSinceRestart++;
    
    // console.log(`[MONITOR] RAM: ${mem.rss}MB | Ciclo: ${chatsSinceRestart}/${CHATS_PER_CYCLE}`);

    // 2. REINICIO PREVENTIVO (La clave del rendimiento constante)
    if (chatsSinceRestart > CHATS_PER_CYCLE || mem.rss > MAX_RAM_MB) {
        console.log(`\n[GOBERNADOR] 🧹 Limpiando memoria (Ciclo ${chatsSinceRestart} chats / ${mem.rss} MB)...`);
        
        try {
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.waitForTimeout(4000); // Esperar reconexión de socket
            // Esperar a que cargue la lista lateral
            await page.waitForSelector('#pane-side', { timeout: 60000 });
            console.log("[GOBERNADOR] ✅ Navegador fresco y listo.");
        } catch (e) {
            console.warn("[GOBERNADOR] ⚠️ Error en recarga:", e.message);
        }
        
        chatsSinceRestart = 0;
    }

    // 3. PROCESAR (Pasamos la página actual, que puede haber cambiado)
    await processSingleChatOnPage(
      page, // IMPORTANTE: Usar la variable actualizada
      chat,
      db,
      retryList,
      incompleteMap,
      myIndex,
      totalChats
    );
    
    // Pequeña pausa para dejar respirar al garbage collector
    if (i < totalChats - 1) await page.waitForTimeout(500);
  }

  console.log(`\n[${nowTs()}] [FASE 2] Extracción completada.`);
  return retryList;
}

// -------------------------------------------------------------
//  FASE 3: REINTENTOS (BANNERS)
// -------------------------------------------------------------

async function phase3_retrySyncChats(page, retryList, incompleteMap) {
  if (retryList.length === 0) {
    console.log(`\n[${nowTs()}] [FASE 3] No hay chats pendientes.`);
    return;
  }

  console.log(`\n>>> [FASE 3] Re-procesando ${retryList.length} chats con SALTO TEMPORAL <<<`);
  const db = await dbPromise;

  for (const chat of retryList) {
    console.log(`\n[FASE 3] Procesando: "${chat.title}"`);
    try {
      await openChatByTitle(page, chat.title);
      
      // INTENTAR SALTO
      if (chat.jumpQuery) {
          await performSearchJump(page, chat);
      }

      // EXTRACCIÓN FINAL (Bajará lo que se haya desbloqueado)
      console.log(`[FASE 3] 📤 Extrayendo tras el salto...`);
      const exportResult = await exportCurrentChatFromPage(page);

      if (exportResult && exportResult.count > 0) {
        const title = exportResult.title || chat.title;
        const filePath = path.join(EXPORT_DIR, `${sanitizeFilename(title)}_FULL.txt`);
        fs.writeFileSync(filePath, exportResult.fullText, "utf8");
        console.log(`[FASE 3] ✅ Guardado FINAL "${filePath}" (${exportResult.count} mensajes)`);
        
        try { await db.run("INSERT INTO Exports(sessionId, chatTitle, filePath, exportedAt) VALUES(?,?,?,datetime('now'))", sessionId, title, filePath); } catch(e){}
      }

    } catch (e) {
      console.warn(`[FASE 3] Error: ${e.message}`);
    }
  }
}

// -------------------------------------------------------------
//  DETECCIÓN DE PANTALLA DE QR
// -------------------------------------------------------------

async function isQrLoginScreen(page) {
  const canvas = await page.$('canvas[aria-label*="QR"]');
  if (canvas) return true;

  try {
    const bodyText = await page.evaluate(
      () => document.body.innerText || ""
    );
    const lower = bodyText.toLowerCase();
    if (lower.includes("pasos para iniciar sesión")) return true;
    if (lower.includes("iniciar sesión con número de teléfono")) return true;
  } catch {}
  return false;
}

// -------------------------------------------------------------
//  MAIN
// -------------------------------------------------------------

(async () => {
  console.log(
    `[${nowTs()}] 🕒 Inicio de export_wa.js para sesión ${sessionId}`
  );
  console.log(
    `[Playwright] Usando USER_DATA_DIR persistente (Firefox): ${USER_DATA_DIR}`
  );

  const context = await firefox.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1000, height: 900 },
    locale: "es-ES",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--mute-audio",
    ],
  });

  await context.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    if (["image", "media"].includes(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });
  console.log(
    "[Playwright] ⚡ MODO BAJO CONSUMO ACTIVADO (imágenes y media bloqueados) en TODO el contexto Firefox"
  );

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  let page;
  if (context.pages().length > 0) {
    page = context.pages()[0];
    console.log(
      "[Playwright] Reutilizando la página existente (Página Principal)."
    );
  } else {
    page = await context.newPage();
    console.log("[Playwright] Creando nueva página (Página Principal).");
  }

  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();

    if (text.includes("Cross-Origin Request Blocked")) return;

    if (type === "error" || type === "warn" || text.includes("[WA]")) {
      console.log(
        `[Consola Navegador MAIN] ${type.toUpperCase()}: ${text}`
      );
    }
  });

  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "domcontentloaded",
  });

  console.log(
    "[Playwright] Navegando a web.whatsapp.com (perfil persistente Firefox) en Página Principal..."
  );

  await page.waitForTimeout(3000);
  if (await isQrLoginScreen(page)) {
    console.error(
      `\n❌ La sesión "${sessionId}" NO está autenticada para este USER_DATA_DIR:\n` +
        `   ${USER_DATA_DIR}\n\n` +
        `   Ejecuta primero:\n` +
        `     node auth.js ${sessionId}\n`
    );
    await page.screenshot({
      path: path.join(SESSION_PATH, "error_login_qr.png"),
      fullPage: true,
    });
    console.log("Se guardó una captura en 'error_login_qr.png'");
    await context.close();
    process.exit(1);
  }

  try {
    await page.waitForSelector(
      "#pane-side [role='row'], [data-testid='chat-list']",
      { timeout: 60000 }
    );
  } catch (e) {
    console.error(
      "❌ No se detectó la lista de chats. ¿Sesión expirada o distinta entre auth.js y export_wa.js en Firefox?"
    );
    await page.screenshot({
      path: path.join(SESSION_PATH, "error_login.png"),
      fullPage: true,
    });
    console.log("Se guardó una captura en 'error_login.png'");
    await context.close();
    process.exit(1);
  }

  console.log(
    "[Playwright] ✅ Sesión cargada correctamente (sin QR). Comenzando exportación..."
  );

  const incompleteMap = new Map();

  try {
    const chatList = await phase1_discoverChats(page);
    const retryList = await phase2_extractChats_Sequential(
      page,
      chatList,
      incompleteMap
    );
    await phase3_retrySyncChats(page, retryList, incompleteMap);

    const incompleteChats = Array.from(incompleteMap.values());
    if (incompleteChats.length > 0) {
      console.log("\n======================================================");
      console.log(
        `🧵 [THREAD PLANIFICADO] Se han detectado ${incompleteChats.length} chats INCOMPLETOS.`
      );
      console.log(
        "🧵  Estos chats requieren un thread de bajo consumo (páginas dedicadas)"
      );
      console.log(
        "🧵  para seguir pulsando el banner de sincronización / el diff de historial / esperando al teléfono."
      );
      console.log("🧵  Lista de chats pendientes de thread:");
      incompleteChats.forEach((c) =>
        console.log(`   - ${c.title} [motivo(s): ${c.reason || "desconocido"}]`)
      );
      console.log(
        "🧵  (En este script se dejan marcados y registrados; el siguiente paso es lanzar una FASE 4 con páginas ultraligeras que refresquen cada X segundos)."
      );
      console.log("======================================================\n");
    } else {
      console.log(
        "\n[THREAD] No se han detectado chats incompletos. No es necesario lanzar threads adicionales."
      );
    }
  } catch (err) {
    console.error("❌ Error fatal durante la ejecución de las fases:", err);
  }

  console.log(
    `\n[${nowTs()}] 🏁 Exportación de chats finalizada para sesión ${sessionId}.`
  );
  await context.close();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Error en export_wa.js:", err);
  process.exit(1);
});
