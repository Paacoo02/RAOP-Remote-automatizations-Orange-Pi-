// auth.js - Autenticación con Playwright + QR en terminal
// node auth.js <sessionId>
// MOTOR: FIREFOX (perfil persistente pw_user_data)

const { firefox } = require("playwright");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const { getDb } = require("./db.js");

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("❌ Error fatal: No se proporcionó un ID de sesión a auth.js.");
  process.exit(1);
}

// HEADLESS: por defecto TRUE (ideal para servidor / contenedor).
// Si quieres ver la ventana, exporta PW_HEADLESS=false
const HEADLESS = process.env.PW_HEADLESS === "false" ? false : true;

// User-Agent coherente para Firefox
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0";

// Directorio de sesión Playwright (perfil completo de Firefox)
const SESSION_PATH = path.resolve(__dirname, "sessions", sessionId);
const USER_DATA_DIR = path.join(SESSION_PATH, "pw_user_data");

// Aseguramos que exista el directorio de sesión
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const dbPromise = getDb();

(async () => {
  console.log(`[Auth-PW] Iniciando Playwright (Headless: ${HEADLESS})`);
  console.log(`[Auth-PW] Ruta de sesión (userDataDir): ${USER_DATA_DIR}`);

  // Lanzamos FIREFOX con contexto persistente
  const context = await firefox.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: { width: 1100, height: 900 },
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

  // Anti-detención a nivel de contexto
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();

  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "domcontentloaded",
  });

  // ------- DETECCIÓN DE PERFIL OBSOLETO / CORRUPTO --------
  const isObsoleteSession = await page
    .locator('text="WhatsApp funciona con Google Chrome 85"')
    .or(page.locator('text="Para usar WhatsApp en tu computadora"'))
    .or(page.locator('text="ERR_PROFILE_LOAD_FAILED"'))
    .isVisible({ timeout: 5000 })
    .catch(() => false);

  if (isObsoleteSession) {
    console.error(`\n❌ [Auth-PW] ¡SESIÓN OBSOLETA O CORRUPTA DETECTADA!`);
    console.error(
      `[Auth-PW] El perfil en ${SESSION_PATH} puede ser inválido o de un navegador diferente (ej. Chrome).`
    );

    await context.close();

    try {
      console.log(
        `[Auth-PW] Intentando eliminar la carpeta de sesión corrupta...`
      );
      fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      console.log(`[Auth-PW] Carpeta de sesión eliminada: ${SESSION_PATH}`);
      console.log(`\n✅ Tarea completada. Vuelve a ejecutar:`);
      console.log(`   node auth.js ${sessionId}`);
    } catch (e) {
      console.error(
        `[Auth-PW] Error al borrar ${SESSION_PATH}: ${e.message}`
      );
      console.error("[Auth-PW] Por favor, bórrala manualmente.");
    }

    process.exit(1);
  }
  // -------------------------------------------------------

  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});

  console.log("... Esperando QR o inicio de sesión ...");

  let qrStringAnterior = "";
  let qrRetries = 0;
  const MAX_RETRIES = 5;
  const MAX_TOTAL_MS = 5 * 60 * 1000; // 5 min
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < MAX_TOTAL_MS) {
      // 1) ¿Ya estamos logueados?
      if (await isLoggedIn(page)) {
        console.log(
          "✅ [Auth-PW] La sesión ya está iniciada (lista de chats visible)."
        );
        await updateProfileName(page, sessionId);

        // Pausa para asegurar que Firefox vuelca todo a disco
        console.log(
          "[Auth-PW] Sesión validada. Cerrando Firefox en 5 segundos para asegurar guardado..."
        );
        await page.waitForTimeout(5000);

        await context.close();
        process.exit(0);
      }

      // 2) Intentar leer el QR actual (si está visible)
      const qrString = await getQrStringFromPage(page);

      if (qrString) {
        if (qrString !== qrStringAnterior) {
          qrStringAnterior = qrString;
          qrRetries++;

          console.log(
            `\n📲 Generando QR (Intento ${qrRetries}/${MAX_RETRIES}). Escanéalo con tu móvil:`
          );
          qrcode.generate(qrString, { small: true });

          if (qrRetries >= MAX_RETRIES) {
            console.log(
              "ℹ️ Máximo de regeneraciones de QR alcanzado, pero puedes seguir escaneando el último mostrado."
            );
          }
        }
      } else {
        // No vemos QR ni chats: puede ser overlay de cookies, etc.
        await tryDismissSimpleOverlays(page);
      }

      await page.waitForTimeout(1000);
    }

    throw new Error("Timeout general esperando QR o sesión iniciada.");
  } catch (err) {
    console.error(`❌ Error fatal durante la autenticación: ${err.message}`);

    // Guardamos HTML + captura para debug
    try {
      const debugHtmlPath = path.join(SESSION_PATH, "auth_debug.html");
      const debugPngPath = path.join(SESSION_PATH, "auth_debug.png");
      const url = page.url();

      console.error(`[Auth-PW] URL actual al fallar: ${url}`);
      const html = await page.content();
      fs.writeFileSync(debugHtmlPath, html);
      await page.screenshot({ path: debugPngPath, fullPage: true });
      console.error(`[Auth-PW] HTML guardado en: ${debugHtmlPath}`);
      console.error(`[Auth-PW] Captura guardada en: ${debugPngPath}`);
    } catch (e2) {
      console.error(
        "[Auth-PW] Error adicional intentando guardar debug:",
        e2.message
      );
    }

    await context.close();
    process.exit(1);
  }
})();

/**
 * Devuelve true si se ve la lista de chats.
 */
async function isLoggedIn(page) {
  const el = await page.$("#pane-side, [data-testid='chat-list']");
  return !!el;
}

/**
 * Extrae la cadena que codifica el QR desde el DOM.
 */
async function getQrStringFromPage(page) {
  return await page.evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label*="QR"]');
    if (!canvas) return null;

    let el = canvas;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute("data-ref")) {
        return el.getAttribute("data-ref");
      }
      el = el.parentElement;
    }
    return null;
  });
}

/**
 * Intenta cerrar overlays/banners típicos (cookies, etc.)
 */
async function tryDismissSimpleOverlays(page) {
  const textos = [
    "Aceptar todo",
    "Aceptar todos",
    "Aceptar cookies",
    "Aceptar",
    "Accept all",
    "Accept cookies",
    "Agree",
    "Allow all",
  ];

  for (const t of textos) {
    try {
      const btn = page.locator(`text=${t}`).first();
      if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
        console.log(`[Auth-PW] Clic en posible banner: "${t}"`);
        await btn.click({ delay: 20 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // ignoramos
    }
  }
}

/**
 * Actualiza el nombre del perfil en la DB.
 */
async function updateProfileName(page, sessionId) {
  const db = await dbPromise;
  let profileName = "Perfil Desconocido";

  try {
    console.log("[Auth-PW] Intentando abrir el panel de perfil...");

    const clicked = await page.evaluate(() => {
      const candidates = [
        'header img[draggable="false"]',
        '#side header img[draggable="false"]',
        'header img.x1n2onr6[draggable="false"]',
      ];

      let img = null;
      for (const sel of candidates) {
        img = document.querySelector(sel);
        if (img) break;
      }
      if (!img) return false;

      let el = img;
      while (el && el !== document.body) {
        const role = el.getAttribute && el.getAttribute("role");
        const isButton = role === "button" || el.tagName === "BUTTON";
        const tabbable = el.hasAttribute && el.hasAttribute("tabindex");

        if (isButton || tabbable || typeof el.onclick === "function") {
          el.click();
          return true;
        }
        el = el.parentElement;
      }

      img.click();
      return true;
    });

    if (!clicked) {
      throw new Error("No se encontró el avatar/botón de perfil en el header.");
    }

    await page.waitForTimeout(800);
    await page
      .waitForSelector(
        "div._alcd span.selectable-text span, [data-testid='contact-info-name'], span.selectable-text.copyable-text",
        { timeout: 5000 }
      )
      .catch(() => {});

    profileName = await page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim()) {
          return el.textContent.trim();
        }
        return null;
      };

      let name =
        getText("div._alcd span.selectable-text span") ||
        getText("div._alcd span.selectable-text") ||
        null;

      if (!name) {
        name =
          getText('[data-testid="contact-info-name"]') ||
          getText('[data-testid="miami-profile-name"]') ||
          null;
      }

      if (!name) {
        const candidates = Array.from(
          document.querySelectorAll(
            "div._alcd span.selectable-text span, span.selectable-text span, span.selectable-text"
          )
        )
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean);

        if (candidates.length > 0) {
          name = candidates[0];
        }
      }

      return name || "Perfil Desconocido";
    });

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    console.warn("[Auth-PW] No se pudo leer el nombre del perfil:", e.message);
  }

  await db.run(
    "UPDATE Sessions SET description = ? WHERE sessionId = ?",
    profileName,
    sessionId
  );
  console.log(
    `[DB] Sesión ${sessionId} actualizada con el nombre: ${profileName}`
  );
}
