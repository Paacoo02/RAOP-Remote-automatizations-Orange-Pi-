// export_wa.js
// VERSIÓN: UN (1) NAVEGADOR, UNA (1) PESTAÑA. 100% SECUENCIAL.
//
// ARQUITECTURA SECUENCIAL (3 FASES)
// *** MODO BAJO CONSUMO (SIN IMÁGENES/MEDIA, A NIVEL DE CONTEXTO)
// *** FASE 1 MULTIPASS PARA FECHAS "CARGANDO..."
// *** FASE 2 SECUENCIAL: UNA SOLA PESTAÑA PROCESA TODOS LOS CHATS UNO POR UNO
// *** FASE 3 REINTENTOS PARA CHATS CON BANNERS (SINCRONIZACIÓN / TELÉFONO)

const { firefox } = require("playwright");
const path = require("path");
const fs = require("fs");
const { getDb } = require("./db.js");

const sessionId = process.argv[2];
const HEADLESS = false; // Puedes poner true si quieres ocultar ventanas
const MAX_DAYS = parseInt(process.env.WA_MAX_DAYS || "30", 10);
const MAX_FASE1_PASSES = 3; // máximo nº de pasadas de Fase 1

if (!sessionId) {
  console.error("❌ Error fatal: No se proporcionó un ID de sesión a export_wa.js.");
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

/**
 * Parsea la etiqueta de fecha/hora del chat.
 * - null => fecha NO disponible todavía (vacío, "Cargando...", etc.).
 */
function parseChatDate(label, now = new Date()) {
  if (label == null) return null;

  const raw = String(label).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();

  // Estados de carga: no tenemos fecha fiable
  if (lower.includes("cargando") || lower.includes("loading")) {
    return null;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Formato hora: "10:39", "3:21 p. m.", etc.
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

  // Día de la semana
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

  // Fechas tipo "31/10/2025" o "31/10"
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

// Patrones para detectar el banner de "mensajes anteriores de tu teléfono"
const PHONE_HISTORY_TEXT_PATTERNS = [
  "haz clic aquí para obtener mensajes anteriores de tu teléfono",
  "usa whatsapp en tu teléfono para ver mensajes anteriores",
  "usar whatsapp en tu teléfono para ver mensajes anteriores",
  "mensajes anteriores de tu teléfono",
  "usar el teléfono para ver mensajes anteriores",
  "click here to get older messages from your phone",
  "use whatsapp on your phone to see older messages",
];

// Patrones para el banner global de sincronización
const SYNC_IN_PROGRESS_TEXT_PATTERNS = [
  "se están sincronizando mensajes más antiguos",
  "se estan sincronizando mensajes mas antiguos",
  "older messages are being synchronized",
  "older messages are being synced",
];

/**
 * Detección robusta del banner/diff "usar teléfono para ver mensajes anteriores".
 */
async function hasPhoneHistoryBanner(page) {
  try {
    const locator = page.locator('div[data-testid="chat-history-sync-banner"]');
    if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      return true;
    }
  } catch {
    // ignoramos y pasamos a detección por texto
  }

  try {
    const text = await page.evaluate(() => document.body.innerText || "");
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    return PHONE_HISTORY_TEXT_PATTERNS.some((p) => normalized.includes(p));
  } catch {
    return false;
  }
}

/**
 * Detección robusta del banner global:
 * "Se están sincronizando mensajes más antiguos. Haz clic para ver el progreso."
 */
async function hasSyncInProgressBanner(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText || "");
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    return SYNC_IN_PROGRESS_TEXT_PATTERNS.some((p) => normalized.includes(p));
  } catch {
    return false;
  }
}

/**
 * Intento genérico de hacer clic en el banner de sincronización global
 * buscando por texto (sin depender de data-testid).
 */
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

/**
 * Marca un chat como "incompleto" en el mapa global, con un motivo.
 */
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
//  EXPORTACIÓN DEL CHAT ACTUAL (EN CONTEXTO NAVEGADOR)
// -------------------------------------------------------------

async function exportCurrentChatFromPage(page) {
  return await page.evaluate(async () => {
    const seen = new Set();
    const messages = [];
    let scroller = null;
    let running = true;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const getCopyables = () =>
      document.querySelectorAll("div.copyable-text,[data-pre-plain-text]");

    function parseInfo(node) {
      const pre = node.getAttribute?.("data-pre-plain-text") || "";
      const textEl =
        node.querySelector?.("span.selectable-text") ||
        node.querySelector?.("div.selectable-text");
      const text = textEl ? textEl.innerText : "";
      if (!pre && !text) return null;
      const uid = pre + "|" + text;
      let ts = "";
      let author = "";
      const m = pre.match(/\[(.*?)\]\s*(.*?):\s?$/);
      if (m) {
        ts = m[1];
        author = m[2];
      }
      return { uid, ts, author, text, pre };
    }

    function scan() {
      let added = 0;
      getCopyables().forEach((node) => {
        const info = parseInfo(node);
        if (!info) return;
        if (!seen.has(info.uid)) {
          seen.add(info.uid);
          messages.push(info);
          added++;
        }
      });
      return added;
    }

    function getChatTitle() {
      const header = document.querySelector(
        "#main header, [data-testid='conversation-header']"
      );
      if (header) {
        const selectors = [
          '[data-testid="conversation-info-header-chat-title"]',
          "span[title]",
          "[title]",
        ];
        for (const sel of selectors) {
          const el = header.querySelector(sel);
          if (el) {
            const t =
              (el.getAttribute("title") || el.textContent || "").trim();
            if (t) return t;
          }
        }
      }
      return null;
    }

    function findScrollContainer() {
      const candidates = [
        "[data-testid='conversation-panel-body']",
        "[data-testid='conversation-panel-messages']",
        "#main [tabindex='-1']",
        "#main",
      ]
        .map((sel) => document.querySelector(sel))
        .filter(Boolean);

      const anyMsg = getCopyables()[0];
      if (anyMsg) {
        let p = anyMsg.parentElement;
        while (p) {
          const st = getComputedStyle(p);
          if (
            (st.overflowY === "auto" || st.overflowY === "scroll") &&
            p.scrollHeight > p.clientHeight + 20
          ) {
            candidates.push(p);
          }
          p = p.parentElement;
        }
      }

      const uniq = Array.from(new Set(candidates));
      uniq.sort(
        (a, b) =>
          b.scrollHeight -
          b.clientHeight -
          (a.scrollHeight - a.clientHeight)
      );
      return (
        uniq.find((el) => el && el.scrollHeight > el.clientHeight + 20) ||
        null
      );
    }

    async function run() {
      scroller = findScrollContainer();
      if (!scroller) {
        scan();
        if (messages.length === 0) {
          console.warn(
            "⚠️ No se encontró contenedor de scroll ni mensajes visibles."
          );
        }
        return;
      }

      const target = document.querySelector("#main") || document.body;
      const obs = new MutationObserver(() => scan());
      obs.observe(target, { subtree: true, childList: true });
      scan();
      const timer = setInterval(scan, 600);

      let stagnation = 0,
        rounds = 0,
        maxStagnation = 10;

      while (running) {
        rounds++;
        const before = seen.size;
        try {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll"));
        } catch (e) {}
        await sleep(600);
        const added = scan();
        const after = seen.size;
        stagnation =
          added === 0 && after === before ? stagnation + 1 : 0;

        if (added > 0 || stagnation === 0 || stagnation >= maxStagnation) {
          console.log(
            `↑ Ronda ${rounds} | total: ${after} | nuevas: ${added} | estancamiento: ${stagnation}/${maxStagnation}`
          );
        }

        if (stagnation >= maxStagnation) break;
      }

      try {
        obs.disconnect();
      } catch (e) {}
      try {
        clearInterval(timer);
      } catch (e) {}
      running = false;
    }

    await run();
    const title = getChatTitle();
    return { title, count: messages.length, messages, error: null };
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
  console.log("[Debug] Scrolleando la lista de chats al inicio...");
  await page.evaluate(() => {
    const scrollPane = document.querySelector("#pane-side");
    if (scrollPane) {
      scrollPane.scrollTop = 0;
    }
  });
  await page.waitForTimeout(1000);
}

// -------------------------------------------------------------
//  FASE 1: DISCOVERY (SINGLE PASS + MULTIPASS)
// -------------------------------------------------------------

async function phase1_discoverChats_singlePass(page) {
  console.log(`\n[FASE 1] (Pasada interna) Explorando lista de chats...`);
  const chatsToProcess = [];
  const processedKeys = new Set();
  const now = new Date();
  let stopByOldChat = false;
  let chatScanCount = 0;
  const lastRowTimeSelector = `#pane-side [role="row"]:last-child div._ak8i`;

  const pendingUnknownMap = new Map();
  let lastValidChat = null;
  let lastValidChatDate = null;

  while (!stopByOldChat) {
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

      // ******************************************************
      // ** INICIO DE LA CORRECCIÓN **
      // Ignorar el chat oficial de "WhatsApp" que no es un chat real
      if (chat.title === "WhatsApp") {
        console.log(`[FASE 1] Omitiendo chat oficial del sistema: "${chat.title}"`);
        continue; // Saltar al siguiente chat
      }
      // ** FIN DE LA CORRECCIÓN **
      // ******************************************************

      const lastDate = parseChatDate(chat.timeLabel, now);
      const pendKey = (chat.title || "").trim();

      if (!lastDate) {
        if (!pendingUnknownMap.has(pendKey)) {
          pendingUnknownMap.set(pendKey, chat);
        }
        console.log(
          `[FASE 1] Aviso: fecha/hora aún NO disponible para "${chat.title}" ` +
            `(timeLabel="${chat.timeLabel || "(vacío)"}", snippet="${
              chat.snippet || ""
            }"). Se omite en este análisis para NO asumir que es de hoy.`
        );
        continue;
      }

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

    if (stopByOldChat) break;

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
  };
}

async function phase1_discoverChats(page) {
  console.log(
    `\n[FASE 1] Iniciando análisis de chats con MULTIPASS (límite: ${MAX_DAYS} días, max pasadas: ${MAX_FASE1_PASSES}).`
  );

  const globalChats = [];
  const globalKeys = new Set();
  let totalScannedAcrossPasses = 0;

  let lastValidChat = null;
  let lastValidChatDate = null;
  let pendingUnknown = [];
  let stopByOldChat = false;

  for (let pass = 1; pass <= MAX_FASE1_PASSES; pass++) {
    console.log(
      `\n[FASE 1] ===== PASADA ${pass} / ${MAX_FASE1_PASSES} =====`
    );

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

    if (!stopByOldChat) {
      console.log(
        "[FASE 1] Fin de la lista alcanzado en esta pasada (no se encontró chat fuera de rango)."
      );
      break;
    }

    if (!pendingUnknown.length) {
      console.log(
        "[FASE 1] No quedan chats con fecha/hora no disponible dentro del rango. No son necesarias más pasadas."
      );
      break;
    }

    console.log(
      `[FASE 1] Aún hay ${pendingUnknown.length} chats con fecha/hora NO disponible dentro del rango actual.\n` +
        "        Reintentando Fase 1 desde arriba para dar tiempo a que WhatsApp cargue las fechas..."
    );

    await scrollChatListToTop(page);
    await page.waitForTimeout(3000);
  }

  if (pendingUnknown.length) {
    console.log(
      `\n[FASE 1] ⚠️ Tras ${MAX_FASE1_PASSES} pasadas siguen quedando ${pendingUnknown.length} chats ` +
        "con fecha/hora no disponible. Se omiten en este run (posible limitación de WhatsApp Web)."
    );
  }

  console.log(`\n[FASE 1] Análisis completado (multipass).`);
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
//  UTILIDADES FASE 2: BÚSQUEDA Y APERTURA DE CHATS POR TÍTULO
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
      if ((await loc.count()) > 0) {
        return loc.first();
      }
    } catch {
      // ignoramos y probamos siguiente
    }
  }
  return null;
}

function escapeTitleForSelector(title) {
  return String(title || "").replace(/"/g, '\\"');
}

/**
 * Abre un chat en la pestaña usando la barra de búsqueda y el título del chat.
 */
async function openChatByTitle(page, chatTitle) {
  const searchBox = await getChatSearchBox(page);
  if (!searchBox) {
    throw new Error("No se encontró el cuadro de búsqueda de chats (#side).");
  }

  await searchBox.click({ timeout: 5000 });
  // limpiamos cualquier búsqueda anterior
  try {
    await searchBox.fill("");
  } catch {
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
  }

  await page.keyboard.type(chatTitle, { delay: 40 });

  const escapedTitle = escapeTitleForSelector(chatTitle);
  const resultSpanSelector = `#pane-side [role="row"] span[title="${escapedTitle}"]`;
  const span = page.locator(resultSpanSelector).first();

  await span.waitFor({ timeout: 10000 });
  await span.click({ timeout: 5000 });
}

// -------------------------------------------------------------
//  FASE 2: PROCESO DE UN SOLO CHAT (FUNCIÓN DE TRABAJO)
// -------------------------------------------------------------

async function processSingleChatOnPage(
  page,
  chat,
  db,
  retryList,
  incompleteMap,
  index,
  total
) {
  const maxAttempts = 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `\n[FASE 2] Procesando chat ${index}/${total}: "${chat.title}" (intento ${attempt}/${maxAttempts})`
      );

      await openChatByTitle(page, chat.title);
      await page.waitForTimeout(1000);

      // Spinner de "cargando mensajes"
      const spinnerLocator = page.locator(
        'div[data-testid="message-list-loading-spinner"]'
      );

      if (
        await spinnerLocator
          .isVisible({ timeout: 1000 })
          .catch(() => false)
      ) {
        console.log("------------------------------------------------------");
        console.warn(
          `[DEBUG] 🔄 CARGANDO MENSAJES... (Spinner detectado) en "${chat.title}"`
        );
        console.warn(`[DEBUG]   Esperando a que finalice la carga...`);
        console.log("------------------------------------------------------");

        await spinnerLocator.waitFor({
          state: "detached",
          timeout: 15000,
        });
        console.log(
          `[DEBUG] ✅ Carga de mensajes para "${chat.title}" completada.`
        );
      }

      console.log(
        `[FASE 2] 📤 Exportando mensajes de "${chat.title}"...`
      );
      const exportResult = await exportCurrentChatFromPage(page);

      if (!exportResult || exportResult.count === 0) {
        console.log(
          `[FASE 2] ℹ️ No se exportaron mensajes de "${chat.title}" (chat vacío).`
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
          `[FASE 2] ✅ Guardado "${filePath}" (${exportResult.count} mensajes)`
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

      // Comprobamos explícitamente AMBOS tipos de diff tras el scroll máximo
      const hasHistoryBanner = await hasPhoneHistoryBanner(page);
      const hasSyncBanner = await hasSyncInProgressBanner(page);

      if (hasHistoryBanner || hasSyncBanner) {
        console.log("------------------------------------------------------");
        if (hasHistoryBanner) {
          console.warn(
            `[FASE 2] 🔴 DIF "USA EL TELÉFONO / OBTENER MENSAJES ANTERIORES" DETECTADO EN "${chat.title}".`
          );
        }
        if (hasSyncBanner) {
          console.warn(
            `[FASE 2] 🟡 BANNER GLOBAL "SE ESTÁN SINCRONIZANDO MENSAJES MÁS ANTIGUOS" DETECTADO EN "${chat.title}".`
          );
        }
        console.warn(
          `[FASE 2]     Esto indica que el historial de este chat NO está completo todavía.`
        );
        console.warn(
          `[FASE 2]     El chat se marca como INCOMPLETO y se tendrá en cuenta en THREAD/FASE 3.`
        );
        console.log("------------------------------------------------------");

        const reasons = [];
        if (hasHistoryBanner) reasons.push("phone-history-diff-post-export");
        if (hasSyncBanner) reasons.push("sync-in-progress-post-export");
        markChatIncomplete(incompleteMap, chat, reasons.join("+"));

        if (hasSyncBanner) {
          retryList.push(chat);
        }
      } else {
        console.log(
          `[FASE 2] 🟢 Tras llegar al inicio del chat "${chat.title}" NO se ha detectado NINGÚN banner de historial incompleto ni de sincronización.`
        );
        console.log(
          `[FASE 2] 🟢 Se asume que la exportación de este chat está COMPLETA hasta donde permite WhatsApp Web.`
        );
      }

      await page.waitForTimeout(500);
      return true;
    } catch (e) {
      lastError = e;
      console.warn(
        `[FASE 2] ⚠️ Intento ${attempt}/${maxAttempts} fallido al procesar "${chat.title}": ${e.message}`
      );
      await page.waitForTimeout(1000);
    }
  }

  console.warn(
    `[FASE 2] ❌ No se pudo procesar "${chat.title}" tras ${maxAttempts} intentos. Se omite en este run.` +
      (lastError ? ` (Último error: ${lastError.message})` : "")
  );
  markChatIncomplete(incompleteMap, chat, "click-timeout");
  return false;
}

// -------------------------------------------------------------
//  FASE 2: EXTRACCIÓN SECUENCIAL (UNA SOLA PESTAÑA)
// -------------------------------------------------------------

async function phase2_extractChats_Sequential(
  page, // Recibimos la PÁGINA principal
  chatList,
  incompleteMap
) {
  console.log(
    `\n[FASE 2] Iniciando extracción SECUENCIAL de ${chatList.length} chats (una sola pestaña)...`
  );

  const db = await dbPromise;
  const retryList = []; // Lista para chats que necesiten Fase 3
  const totalChats = chatList.length;
  let globalProcessed = 0;

  // Bucle FOR...OF secuencial. No procesará el siguiente chat
  // hasta que el anterior haya terminado.
  for (const chat of chatList) {
    const myIndex = ++globalProcessed;
    
    // Usamos la misma función de trabajo 'processSingleChatOnPage'
    // pero siempre en la misma 'page'
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

  console.log(`\n[FASE 2] Extracción secuencial completada.`);
  return retryList; // Devolvemos la lista de reintentos para la Fase 3
}


// -------------------------------------------------------------
//  FASE 3: REINTENTOS (BANNERS)
// -------------------------------------------------------------

async function phase3_retrySyncChats(page, retryList, incompleteMap) {
  if (retryList.length === 0) {
    console.log("\n[FASE 3] No hay chats pendientes de sincronización.");
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
      `\n[FASE 3] (Hilo) Procesando reintento ${index + 1}/${
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
        if (hasHistoryBanner2) reasons.push("phone-history-diff-post-fase3");
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
  console.log(`\n[FASE 3] Reintentos finalizados.`);
}

// -------------------------------------------------------------
//  MAIN
// -------------------------------------------------------------

(async () => {
  console.log(
    `[Playwright] Usando USER_DATA_DIR persistente (Firefox): ${USER_DATA_DIR}`
  );

  // UN SOLO NAVEGADOR (UN SOLO CONTEXTO PERSISTENTE) EN FIREFOX
  const context = await firefox.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
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

  // Modo bajo consumo a nivel de CONTEXTO (todas las páginas/pestañas)
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

  // Script anti-detección
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // PESTAÑA/PÁGINA PRINCIPAL
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
    // FASE 1: descubrir chats hasta MAX_DAYS
    const chatList = await phase1_discoverChats(page);

    // FASE 2: extracción SECUENCIAL (UNA SOLA PESTAÑA)
    // Llamamos a la nueva función secuencial
    const retryList = await phase2_extractChats_Sequential(
      page, // Pasamos la página principal
      chatList,
      incompleteMap
    );

    // FASE 3: reintentos para chats con banner de sincronización / diffs
    await phase3_retrySyncChats(page, retryList, incompleteMap);

    // Resumen de chats incompletos
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

  console.log("\n🏁 Exportación de chats finalizada.");
  await context.close();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Error en export_wa.js:", err);
  process.exit(1);
});