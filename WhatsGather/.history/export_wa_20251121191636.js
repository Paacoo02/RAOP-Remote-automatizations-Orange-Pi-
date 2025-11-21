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
//  SCRAPER: TU CÓDIGO EXACTO (Inyectado)
// -------------------------------------------------------------
async function exportCurrentChatFromPage(page) {
  // Timeout 0 para permitir scrolls largos
  return await page.evaluate(async () => {
    console.log("[Browser] Iniciando scraper con detección de Muro de Sincronización...");

    if (window.__waCounterAuto) { try { window.__waCounterAuto.stop(); } catch(e){} }

    const seen = new Set();
    const messagesMap = new Map();
    let scroller = null, running = true;
    let syncWallHit = false; // Bandera de muro detectado

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const getCopyables = () => document.querySelectorAll("div.message-in, div.message-out, div.copyable-text");

    // TEXTOS EXACTOS QUE INDICAN EL MURO (Los que tú pasaste)
    const WALL_TEXTS = [
      "Haz clic aquí para obtener mensajes anteriores de tu teléfono",
      "No se pudieron obtener mensajes anteriores",
      "Abre WhatsApp en tu teléfono y haz clic aquí",
      "Se están sincronizando mensajes más antiguos",
      "mensajes anteriores de tu teléfono" // versión corta por si acaso
    ];

    function parseInfo(node){
      const pre = node.getAttribute?.("data-pre-plain-text") || "";
      const textEl = node.querySelector?.("span.selectable-text") || node.querySelector?.("div.selectable-text");
      const text = textEl ? textEl.innerText : (node.innerText || "");
      
      if (!pre && !text) return null;
      
      // UID: Usamos timestamp + autor + inicio del texto para evitar duplicados
      const uid = pre + "|" + text.substring(0, 30);
      let ts = "", author = "";
      const m = pre.match(/\[(.*?)\]\s*(.*?):\s?$/);
      if (m){ ts = m[1]; author = m[2]; }
      
      return { uid, ts, author, text: text.replace(/\r?\n/g, " "), pre };
    }

    function scan(){
      let added = 0;
      const nodes = getCopyables();
      nodes.forEach(node=>{
        const info = parseInfo(node);
        if (!info) return;
        if (!seen.has(info.uid)){
          seen.add(info.uid);
          messagesMap.set(info.uid, info);
          added++;
        }
      });
      return added;
    }

    function checkForSyncWall() {
      // Buscamos en todo el contenedor principal si aparecen los textos malditos
      const main = document.querySelector("#main");
      if (!main) return false;
      const htmlContent = main.innerText; // Usamos innerText para ver lo visible
      
      for (const phrase of WALL_TEXTS) {
        if (htmlContent.includes(phrase)) {
          return phrase; // Retornamos la frase encontrada
        }
      }
      return false;
    }

    // Buscar contenedor de scroll
    function findScrollContainer(){
      const candidates = [
        '[data-testid="conversation-panel-body"]',
        '[data-testid="conversation-panel-messages"]',
        '#main [tabindex="-1"]'
      ].map(sel => document.querySelector(sel)).filter(Boolean);

      for (const el of candidates) {
         if (el.scrollHeight > el.clientHeight) return el;
      }
      return null;
    }

    // Obtener el texto del mensaje MÁS ANTIGUO visualmente (el primero del DOM)
    function getOldestMessageText() {
        const msgs = getCopyables();
        if (msgs.length > 0) {
            // El primer mensaje en el DOM suele ser el más antiguo
            const firstMsg = msgs[0];
            const info = parseInfo(firstMsg);
            if (info && info.text && info.text.length > 5) {
                // Devolvemos un trozo significativo para buscarlo luego
                return info.text.substring(0, 50); 
            }
        }
        return null;
    }

    async function run(){
      scroller = findScrollContainer();
      if (!scroller){ scan(); return; }

      const target = document.querySelector("#main");
      const obs = new MutationObserver(()=> scan());
      obs.observe(target, {subtree:true, childList:true});

      scan();
      
      let stagnation = 0;
      const maxStagnation = 10;

      while (running) {
        // 1. Verificar Muro ANTES de hacer scroll
        const wallDetected = checkForSyncWall();
        if (wallDetected) {
            console.log(`[Browser] 🧱 MURO DETECTADO: "${wallDetected}". Deteniendo scroll.`);
            syncWallHit = true;
            break; // Rompemos el bucle para no perder tiempo
        }

        const before = seen.size;
        scroller.scrollTop = 0;
        await sleep(800);
        const added = scan();
        const after = seen.size;

        stagnation = (added === 0 && after === before) ? (stagnation+1) : 0;
        if (stagnation >= maxStagnation) break;
      }

      try { obs.disconnect(); } catch(e){}
      running = false;
    }

    await run();

    // Preparar salida
    const lines = [];
    for (const info of messagesMap.values()){
      const author = info.author || "Yo";
      const ts = info.ts || "";
      lines.push(`[${ts}] ${author}: ${info.text}`);
    }

    return {
        title: document.querySelector("header span[title]")?.getAttribute("title") || "chat",
        count: messagesMap.size,
        fullText: lines.join("\n"),
        // DATOS CLAVE PARA EL "JUMP":
        syncRequired: syncWallHit, 
        oldestMessageQuery: getOldestMessageText() 
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
async function openChatByTitle(page, chatTitle) {
  const searchBox = await getChatSearchBox(page);
  if (!searchBox) throw new Error("Buscador no encontrado.");

  // Normalización
  const cleanTitle = chatTitle.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

  console.log(`[FASE 2] Buscando: "${cleanTitle}"`);

  // 1. Escribir Búsqueda
  await searchBox.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await page.keyboard.type(cleanTitle, { delay: 70 });
  await page.waitForTimeout(2000); // Espera vital para resultados

  // 2. ESTRATEGIA HÍBRIDA: Locator + Tab
  console.log(`[FASE 2] Intentando localizar fila que contenga "${cleanTitle}"...`);

  // Buscamos una fila en el panel lateral que contenga el texto (case-insensitive aproximado)
  // El regex 'i' hace que no importen mayúsculas/minúsculas
  const rowLocator = page.locator('#pane-side [role="row"]')
    .filter({ hasText: new RegExp(cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
    .first();

  if (await rowLocator.count() > 0) {
      console.log("[FASE 2] ✅ Fila encontrada. Haciendo clic nativo...");
      // force: true salta validaciones de si el elemento está tapado por un tooltip
      await rowLocator.click({ force: true, timeout: 3000 });
  } else {
      console.warn("[FASE 2] ⚠️ No se encontró la fila por texto exacto. Usando PLAN B (Tab + Enter).");
      // Si el texto no coincide (ej. por tildes raras), usamos navegación de teclado
      await page.keyboard.press('Tab'); // Mover foco fuera del input
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
  }

  // 3. LIMPIEZA
  // A veces la búsqueda se queda abierta. Si vemos el botón "X" de cancelar búsqueda, lo pulsamos 
  // PERO solo si ya detectamos que el chat parece estar cargando, para no cerrarlo antes de tiempo.
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

// -------------------------------------------------------------
//  FUNCIÓN DE SALTO TEMPORAL (SEARCH JUMP)
// -------------------------------------------------------------
async function performSearchJump(page, chat) {
  if (!chat.jumpQuery) {
      console.warn(`[JUMP] ⚠️ No hay texto para saltar en "${chat.title}".`);
      return false;
  }

  console.log(`[JUMP] 🚀 Iniciando Salto Temporal en "${chat.title}"...`);
  console.log(`[JUMP]    Buscando ancla: "${chat.jumpQuery.substring(0, 30)}..."`);

  try {
      // 1. Asegurar que el chat está abierto (ya debería estarlo, pero por si acaso)
      // (Asumimos que ya estás dentro del chat tras openChatByTitle)

      // 2. Abrir la Lupa del CHAT (Lupa derecha, no la de la izquierda)
      // Selector para la lupa dentro del chat activo
      const chatSearchBtn = page.locator('#main header span[data-testid="search-alt"]');
      await chatSearchBtn.click();
      await page.waitForTimeout(500);

      // 3. Escribir la frase del mensaje antiguo
      const searchInput = page.locator('#app [contenteditable="true"][role="textbox"]').first(); // Suele abrirse un panel lateral
      await searchInput.fill(chat.jumpQuery);
      await page.waitForTimeout(2000); // Esperar resultados

      // 4. Buscar resultados en el panel lateral derecho
      // WhatsApp pone los resultados en un div con role="grid" o similar en el panel lateral
      const results = page.locator('div[aria-label*="Resultados"] [role="button"], div[aria-label*="Search results"] [role="button"]');
      
      if (await results.count() > 0) {
          console.log(`[JUMP] ✅ Resultados encontrados. Saltando al más antiguo...`);
          
          // Hacemos clic en el ÚLTIMO resultado (que suele ser el más antiguo en contexto de búsqueda)
          // O en el primero si es muy específico.
          await results.last().click();
          
          // 5. ESPERA MÁGICA
          // Al hacer clic, WhatsApp hace scroll y carga el contexto.
          // Aquí es donde se produce la sincronización con el móvil.
          console.log(`[JUMP] ⏳ Esperando carga de contexto y sincronización (10s)...`);
          await page.waitForTimeout(10000);
          
          // Cerramos la búsqueda para limpiar la vista
          const closeSearch = page.locator('div[aria-label="Cerrar"], span[data-testid="x-alt"]');
          await closeSearch.click().catch(()=>{});
          
          return true;
      } else {
          console.warn(`[JUMP] ❌ No se encontraron resultados para el salto.`);
      }

  } catch (e) {
      console.error(`[JUMP] Error ejecutando el salto: ${e.message}`);
  }
  return false;
}

async function processSingleChatOnPage(page, chat, db, retryList, incompleteMap, index, total) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`\n[${nowTs()}] [FASE 2] Procesando chat ${index}/${total}: "${chat.title}" (intento ${attempt}/${maxAttempts})`);

      // 1. Abrir Chat
      await openChatByTitle(page, chat.title);
      
      // 2. Verificar Éxito (Esperamos el footer)
      try {
        // Buscamos la barra de escritura O el mensaje de "escribe un mensaje"
        await page.waitForSelector('footer, [data-testid="box-chat-footer"], div[contenteditable="true"][role="textbox"]', { timeout: 8000 });
        console.log("[FASE 2] ✅ Interfaz de chat cargada correctamente.");
      } catch (e) {
        throw new Error("Timeout: No apareció la barra de escritura tras el clic.");
      }

      // 3. Extraer
      console.log(`[FASE 2] 📤 Ejecutando TU script original en "${chat.title}"...`);
      // ¡Importante! Aumentar timeout de Node porque tu script tarda
      // Lo hacemos pasando { timeout: 0 } al evaluate, que ya está puesto arriba.
      
      const exportResult = await exportCurrentChatFromPage(page);

      // --- LÓGICA DE GUARDADO ---
      if (exportResult && exportResult.count > 0) {
          // (Tu código de guardado de archivo .txt aquí...)
          const filePath = path.join(EXPORT_DIR, `${sanitizeFilename(exportResult.title)}.txt`);
          fs.writeFileSync(filePath, exportResult.fullText, "utf8");
          console.log(`[FASE 2] ✅ Guardado temporal (${exportResult.count} mensajes).`);
      }

      // --- DETECCIÓN DEL SALTO (JUMP) ---
      if (exportResult.syncRequired) {
          console.warn(`[FASE 2] 🧱 Muro de sincronización detectado en "${chat.title}".`);
          console.warn(`[FASE 2]    Se requiere RE-SINCRONIZACIÓN (Jump).`);
          
          // Guardamos en retryList con la "llave" para el salto
          retryList.push({
              ...chat,
              jumpQuery: exportResult.oldestMessageQuery, // <--- LA LLAVE DEL TIEMPO
              reason: "sync-wall-detected"
          });
      } else {
          console.log(`[FASE 2] 🟢 Chat completado sin muros de sincronización.`);
      }

      return true;

    } catch (e) {
      console.warn(`[FASE 2] ⚠️ Intento ${attempt}/${maxAttempts} fallido: ${e.message}`);
      
      // 📸 CAPTURA DE PANTALLA DE DEBUG
      // Esto guardará una imagen 'debug_error_chat_X.png' en tu carpeta sessions
      const shotPath = path.join(SESSION_PATH, `debug_error_${sanitizeFilename(chat.title)}.png`);
      try {
        await page.screenshot({ path: shotPath });
        console.log(`[DEBUG] 📸 Captura del error guardada en: ${shotPath}`);
      } catch(err) {}

      // Recuperación
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      
      if (attempt === 3) {
         console.log("[FASE 2] 🔄 Recargando página por persistencia de fallos...");
         await page.reload({ waitUntil: "domcontentloaded" });
         await page.waitForTimeout(8000); // Espera larga para reconexión
      }
    }
  }
  
  markChatIncomplete(incompleteMap, chat, "max-attempts-reached");
  return false;
}

// -------------------------------------------------------------
//  FASE 2: EXTRACCIÓN SECUENCIAL
// -------------------------------------------------------------

async function phase2_extractChats_Sequential(page, chatList, incompleteMap) {
  console.log(
    `\n[${nowTs()}] [FASE 2] Iniciando extracción SECUENCIAL de ${chatList.length} chats (una sola pestaña)...`
  );

  const db = await dbPromise;
  const retryList = [];
  const totalChats = chatList.length;
  let globalProcessed = 0;

  for (const chat of chatList) {
    const myIndex = ++globalProcessed;
    await processSingleChatOnPage(
      page,
      chat,
      db,
      retryList,
      incompleteMap,
      myIndex,
      totalChats
    );
  }

  console.log(`\n[${nowTs()}] [FASE 2] Extracción secuencial completada.`);
  return retryList;
}

// -------------------------------------------------------------
//  FASE 3: REINTENTOS (BANNERS)
// -------------------------------------------------------------

async function phase3_retrySyncChats(page, retryList, incompleteMap) {
  if (retryList.length === 0) {
    console.log(
      `\n[${nowTs()}] [FASE 3] No hay chats pendientes de sincronización.`
    );
    return;
  }

  console.log("\n------------------------------------------------------");
  console.log(
    `>>> [DEBUG] 🚀 INICIANDO "HILO" DE RE-ANÁLISIS (FASE 3, secuencial) <<<`
  );
  console.log(
    `>>> [DEBUG] Se van a revisar ${retryList.length} chats marcados con banner de sincronización.`
  );
  console.log("------------------------------------------------------\n");

  const db = await dbPromise;

  for (const [index, chat] of retryList.entries()) {
    console.log(
      `\n[${nowTs()}] [FASE 3] (Hilo) Procesando reintento ${index + 1}/${
        retryList.length
      }: "${chat.title}"`
    );

    try {
      await openChatByTitle(page, chat.title);
      await page.waitForTimeout(1000);

      const isSyncing = await hasSyncInProgressBanner(page);
      const isHistorySync = await hasPhoneHistoryBanner(page);

      if (isSyncing) {
        console.log(
          `[FASE 3] ℹ️ Se detecta banner de sincronización global en "${chat.title}". Intentando hacer clic y esperando máx 30s...`
        );
        const clicked = await clickSyncInProgressBanner(page);
        if (!clicked) {
          console.warn(
            `[FASE 3] ⚠️ No se pudo hacer clic programáticamente en el banner. Se esperará igualmente a que desaparezca.`
          );
        }

        const start = Date.now();
        while (Date.now() - start < 30000) {
          const still = await hasSyncInProgressBanner(page);
          if (!still) break;
          await page.waitForTimeout(1000);
        }
        if (await hasSyncInProgressBanner(page)) {
          console.warn(
            `[FASE 3] ⚠️ El banner de sincronización sigue visible tras 30s en "${chat.title}".`
          );
        } else {
          console.log(
            `[FASE 3] ✅ El banner de sincronización ha desaparecido para "${chat.title}".`
          );
        }
      } else if (isHistorySync) {
        console.warn(
          `[FASE 3] ❌ El chat "${chat.title}" sigue requiriendo el teléfono (banner "usar teléfono para ver mensajes anteriores").`
        );
        console.warn(
          `[FASE 3]    Marcado como INCOMPLETO. No se puede exportar el historial completo ahora mismo.`
        );
        markChatIncomplete(incompleteMap, chat, "phone-required-fase3");
        continue;
      } else {
        console.log(
          `[FASE 3] ℹ️ El chat "${chat.title}" ya no muestra banners de sincronización ni teléfono.`
        );
      }

      console.log(
        `[FASE 3] 📤 Exportando mensajes de "${chat.title}"...`
      );
      const exportResult = await exportCurrentChatFromPage(page);

      if (!exportResult || exportResult.count === 0) {
        console.log(
          `[FASE 3] ℹ️ No se exportaron mensajes de "${chat.title}" (chat vacío).`
        );
      } else {
        const title = exportResult.title || chat.title || "whatsapp_chat";
        const sanitized = sanitizeFilename(title);
        const filePath = path.join(EXPORT_DIR, `${sanitized}.txt`);

        const lines = exportResult.messages.map((info) => {
          const author = info.author || "Yo";
          const ts = info.ts || "";
          const text = (info.text || "").replace(/\r?\n/g, " ");
          return `[${ts}] ${author}: ${text}`;
        });

        fs.writeFileSync(filePath, lines.join("\n"), "utf8");
        console.log(
          `[FASE 3] ✅ Guardado "${filePath}" (${exportResult.count} mensajes)`
        );

        try {
          await db.run(
            "INSERT INTO Exports(sessionId, chatTitle, filePath, exportedAt) VALUES(?,?,?,datetime('now'))",
            sessionId,
            title,
            filePath
          );
        } catch (e) {
          console.warn("[DB] Aviso al registrar export:", e.message);
        }
      }

      const hasHistoryBanner2 = await hasPhoneHistoryBanner(page);
      const hasSyncBanner2 = await hasSyncInProgressBanner(page);

      if (hasHistoryBanner2 || hasSyncBanner2) {
        console.warn(
          `[FASE 3] 🔴 Tras el reintento, el chat "${chat.title}" SIGUE mostrando algún diff de historial/sincronización.`
        );
        const reasons = [];
        if (hasHistoryBanner2)
          reasons.push("phone-history-diff-post-fase3");
        if (hasSyncBanner2) reasons.push("sync-in-progress-post-fase3");
        markChatIncomplete(incompleteMap, chat, reasons.join("+"));
      } else {
        console.log(
          `[FASE 3] 🟢 Tras el reintento y el scroll máximo, NO se detectan banners de historial ni sincronización en "${chat.title}".`
        );
        console.log(
          `[FASE 3] 🟢 Marcamos este chat como COMPLETO (a efectos de WhatsApp Web).`
        );
      }

      await page.waitForTimeout(500);
    } catch (e) {
      console.warn(
        `[FASE 3] ❌ Error final en reintento de "${chat.title}". Omitiendo. (Error: ${e.message})`
      );
      markChatIncomplete(incompleteMap, chat, "fase3-error");
      continue;
    }
  }
  console.log(`\n[${nowTs()}] [FASE 3] Reintentos finalizados.`);
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
