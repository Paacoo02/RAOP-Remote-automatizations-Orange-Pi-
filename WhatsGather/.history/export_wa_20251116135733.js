// export_wa.js
// node export_wa.js <sessionId> [concurrencia]
//
// Recorre los chats recientes y exporta cada conversación a TXT,
// reutilizando el perfil persistente de Playwright en pw_user_data.

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { getDb } = require("./db.js");

const sessionId = process.argv[2];
const CONCURRENCY = parseInt(process.argv[3] || "1", 10);
const HEADLESS = process.env.PW_HEADLESS === "false" ? false : true;
const MAX_DAYS = parseInt(process.env.WA_MAX_DAYS || "60", 10); // umbral de días

if (!sessionId) {
  console.error("❌ Error fatal: No se proporcionó un ID de sesión a export_wa.js.");
  process.exit(1);
}

const SESSION_PATH = path.resolve(__dirname, "sessions", sessionId);
const USER_DATA_DIR = path.join(SESSION_PATH, "pw_user_data");
const EXPORT_DIR = path.resolve(__dirname, "exports", sessionId);
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const dbPromise = getDb();

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

// Parsear etiqueta de fecha/hora del panel lateral ("11:50", "Ayer", "miércoles", "14/9/2025", ...)
function parseChatDate(label, now = new Date()) {
  if (!label) return now;
  const raw = label.trim();
  const lower = raw.toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // hh:mm
  const timeMatch = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const d = new Date(today);
    d.setHours(h, m, 0, 0);
    return d;
  }

  // "ayer"
  if (lower === "ayer") {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // días de semana
  const canonicalWeek = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const altMap = { miercoles: "miércoles", sabado: "sábado" };
  let wd = lower;
  if (altMap[wd]) wd = altMap[wd];

  let idx = canonicalWeek.indexOf(wd);
  if (idx !== -1) {
    const todayIdx = today.getDay(); // 0=domingo
    let diff = todayIdx - idx;
    if (diff < 0) diff += 7; // último día de esa semana hacia atrás
    const d = new Date(today);
    d.setDate(d.getDate() - diff);
    return d;
  }

  // fecha dd/mm[/yy|yyyy]
  const dateMatch = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (dateMatch) {
    let day = parseInt(dateMatch[1], 10);
    let month = parseInt(dateMatch[2], 10);
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, month - 1, day);
  }

  // fallback
  return today;
}

// Exporta el chat actualmente abierto en #main usando una versión adaptada
// de tu WhatsAppCounterAuto. Devuelve { title, count, messages[] }.
async function exportCurrentChatFromPage(page) {
  return await page.evaluate(async () => {
    const seen = new Set();
    const messages = [];
    let scroller = null;
    let running = true;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
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
      getCopyables().forEach(node => {
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
      const header = document.querySelector("#main header");
      if (header) {
        const selectors = [
          'span.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft.x1rg5ohu._ao3e',
          '[data-testid="conversation-info-header-chat-title"]',
          "span[title]",
          "[title]"
        ];
        for (const sel of selectors) {
          const el = header.querySelector(sel);
          if (el) {
            const t = (el.getAttribute("title") || el.textContent || "").trim();
            if (t) return t;
          }
        }
      }
      const altHeader = document.querySelector('[data-testid="conversation-header"]');
      if (altHeader) {
        const el = altHeader.querySelector(
          '[data-testid="conversation-info-header-chat-title"], span[title], [title]'
        );
        if (el) {
          const t = (el.getAttribute("title") || el.textContent || "").trim();
          if (t) return t;
        }
      }
      return "whatsapp_chat";
    }

    function findScrollContainer() {
      const candidates = [
        '[data-testid="conversation-panel-body"]',
        '[data-testid="conversation-panel-messages"]',
        "#main [tabindex='-1']",
        "#main"
      ]
        .map(sel => document.querySelector(sel))
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
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
      );
      return uniq.find(el => el && el.scrollHeight > el.clientHeight + 20) || null;
    }

    async function run() {
      scroller = findScrollContainer();
      if (!scroller) {
        console.warn(
          "⚠️ No se encontró contenedor de scroll en la conversación. Exportando lo visible."
        );
        scan();
        return;
      }

      const target = document.querySelector("#main") || document.body;
      const obs = new MutationObserver(() => scan());
      obs.observe(target, { subtree: true, childList: true });

      scan();
      const timer = setInterval(scan, 600);
      let stagnation = 0;
      let rounds = 0;
      const maxStagnation = 10;

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
        console.log(
          `↑ Ronda ${rounds} | total: ${after} | nuevas: ${added} | estancamiento: ${stagnation}/${maxStagnation}`
        );
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
    return { title, count: messages.length, messages };
  });
}

// lee todos los chats actualmente visibles en el panel lateral
async function getVisibleChats(page) {
  return await page.evaluate(() => {
    const res = [];
    const grid =
      document.querySelector('#pane-side [aria-label="Lista de chats"][role="grid"]') ||
      document.querySelector('[aria-label="Lista de chats"][role="grid"]');
    if (!grid) return res;

    const rows = grid.querySelectorAll('[role="row"]');
    rows.forEach((row, index) => {
      const titleSpan = row.querySelector("span[title]");
      const title =
        (titleSpan && (titleSpan.getAttribute("title") || titleSpan.textContent)) ||
        "";
      if (!title) return;

      const timeDiv = row.querySelector("div._ak8i");
      const timeLabel = (timeDiv && timeDiv.textContent && timeDiv.textContent.trim()) || "";

      const snippetSpan =
        row.querySelector('span[dir="ltr"]') ||
        row.querySelector('span[dir="auto"]');
      const snippet =
        (snippetSpan && snippetSpan.textContent && snippetSpan.textContent.trim()) || "";

      const rect = row.getBoundingClientRect();
      const top = rect.top;

      const key = `${title}|${timeLabel}|${snippet}`;
      res.push({ key, title, timeLabel, snippet, index, top });
    });

    res.sort((a, b) => a.top - b.top);
    return res;
  });
}

// hace scroll hacia abajo en el panel de chats
async function scrollChatListDown(page) {
  return await page.evaluate(() => {
    const grid =
      document.querySelector('#pane-side [aria-label="Lista de chats"][role="grid"]') ||
      document.querySelector('[aria-label="Lista de chats"][role="grid"]');
    if (!grid) return false;
    const before = grid.scrollTop;
    grid.scrollTop = before + grid.clientHeight * 0.9;
    return grid.scrollTop !== before;
  });
}

(async () => {
  console.log(
    `[Playwright] Usando USER_DATA_DIR persistente de whatsapp-web.js: ${USER_DATA_DIR}`
  );
  console.log(
    `[Playwright] Concurrencia solicitada: ${CONCURRENCY} (de momento se usará 1 por simplicidad)`
  );

  const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// ...
// aquí arriba tendrás cosas como: const { chromium } = require("playwright");
// const sessionId = process.argv[2]; const USER_DATA_DIR = ...

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: HEADLESS,
  viewport: { width: 1000, height: 900 },
  locale: "es-ES",

  userAgent: UA,
  extraHTTPHeaders: {
    "User-Agent": UA,
  },

  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--mute-audio",
  ],
});

  const page = await context.newPage();
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });

  console.log("[Playwright] Navegando a web.whatsapp.com (perfil persistente)...");
  await page
    .waitForSelector("#pane-side [role='row'], [data-testid='chat-list']", {
      timeout: 60000
    })
    .catch(() => {});

  const loggedIn = await page.$("#pane-side, [data-testid='chat-list']");
  if (!loggedIn) {
    console.error("❌ No se detectó la lista de chats. ¿Sesión expirada?");
    await context.close();
    process.exit(1);
  }

  console.log(
    "[Playwright] ✅ Sesión cargada correctamente (sin QR). Comenzando exportación de chats..."
  );

  const processedKeys = new Set();
  const now = new Date();
  let stopByOldChat = false;
  let iteration = 0;

  const db = await dbPromise;

  while (!stopByOldChat) {
    iteration++;
    console.log(`\n[Playwright] Iteración de panel #${iteration}`);

    const chats = await getVisibleChats(page);
    if (!chats.length) {
      console.log("⚠️ No se han encontrado filas de chat visibles.");
      break;
    }

    let processedSomethingThisRound = false;

    for (const chat of chats) {
      if (processedKeys.has(chat.key)) continue;
      processedKeys.add(chat.key);

      const lastDate = parseChatDate(chat.timeLabel, now);
      const diffDays = (now - lastDate) / (1000 * 60 * 60 * 24);

      console.log(
        `→ Detectado chat "${chat.title}" (último: "${chat.timeLabel}" ≈ ${diffDays.toFixed(
          1
        )} días)`
      );

      if (diffDays > MAX_DAYS) {
        console.log(
          `⏹️  Parando aquí: el último mensaje de "${chat.title}" está fuera de rango (> ${MAX_DAYS} días).`
        );
        stopByOldChat = true;
        break;
      }

      processedSomethingThisRound = true;

      // Entrar en el chat
      console.log(`📂 Abriendo chat "${chat.title}"...`);
      const rowLocator = page.locator('#pane-side [role="row"]').nth(chat.index);
      await rowLocator.click();
      await page.waitForTimeout(800);
      await page
        .waitForSelector("#main", { timeout: 15000 })
        .catch(() => {});

      // Exportar mensajes usando el extractor interno
      console.log(`📤 Exportando mensajes de "${chat.title}"...`);
      const exportResult = await exportCurrentChatFromPage(page);
      const title = exportResult.title || chat.title || "whatsapp_chat";
      const sanitized = sanitizeFilename(title);
      const filePath = path.join(EXPORT_DIR, `${sanitized}.txt`);

      const lines = exportResult.messages.map(info => {
        const author = info.author || "Yo";
        const ts = info.ts || "";
        const text = (info.text || "").replace(/\r?\n/g, " ");
        return `[${ts}] ${author}: ${text}`;
      });

      fs.writeFileSync(filePath, lines.join("\n"), "utf8");
      console.log(
        `✅ Guardado "${filePath}" (${exportResult.count} mensajes, clave: ${sanitized})`
      );

      // (opcional) registrar en BD que hemos exportado este chat
      try {
        await db.run(
          "INSERT INTO Exports(sessionId, chatTitle, filePath, exportedAt) VALUES(?,?,?,datetime('now'))",
          sessionId,
          title,
          filePath
        );
      } catch (e) {
        // si la tabla no existe o hay error, simplemente lo logueamos
        console.warn("[DB] Aviso al registrar export:", e.message);
      }

      // pequeña pausa entre chats
      await page.waitForTimeout(500);
    }

    if (stopByOldChat) break;

    if (!processedSomethingThisRound) {
      const couldScroll = await scrollChatListDown(page);
      if (!couldScroll) {
        console.log("ℹ️ No se puede seguir haciendo scroll; fin de la lista de chats.");
        break;
      }
      await page.waitForTimeout(1000);
    }
  }

  console.log("\n🏁 Exportación de chats finalizada.");
  await context.close();
  process.exit(0);
})().catch(err => {
  console.error("❌ Error en export_wa.js:", err);
  process.exit(1);
});
