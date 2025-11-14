// inspect_dom.js - Inspección y comparación del DOM de una sesión activa
// node inspect_dom.js <sessionId>

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// --- Configuración ---
const sessionId = process.argv[2];
if (!sessionId) {
  console.error("❌ Error fatal: No se proporcionó un ID de sesión a inspect_dom.js.");
  console.error("Uso: node inspect_dom.js mi-sesion");
  process.exit(1);
}

const HEADLESS = process.env.PW_HEADLESS === "false" ? false : true;
const SESSION_PATH = path.resolve(__dirname, "sessions", sessionId);
const USER_DATA_DIR = path.join(SESSION_PATH, "pw_user_data");

// Rutas de guardado para la comparación
const debugHtmlPath1 = path.join(SESSION_PATH, "dom_state_1_initial.html");
const debugHtmlPath2 = path.join(SESSION_PATH, "dom_state_2_5s_later.html");


(async () => {
  console.log(`[DOM-Inspect] Cargando sesión existente desde: ${USER_DATA_DIR}`);

  // 1. Cargar la sesión persistente
  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS,
      viewport: { width: 1000, height: 900 },
      // Es crucial NO cambiar el userAgent aquí para mantener la sesión
    });
  } catch (e) {
    console.error("❌ Error al cargar la sesión. Asegúrate de que el ID es correcto y la carpeta existe.");
    console.error(e.message);
    process.exit(1);
  }

  const page = await context.newPage();
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
  
  // Asegurarse de que el login fue exitoso y estamos viendo chats
  await page.waitForSelector("#pane-side, [data-testid='chat-list']", { timeout: 60000 })
    .catch(() => {
      console.error("❌ Error: No se pudo cargar la lista de chats. La sesión puede haber caducado. Ejecuta auth.js de nuevo.");
      context.close();
      process.exit(1);
    });

  console.log("✅ Sesión activa cargada correctamente. Iniciando inspección del DOM.");

  // --- 2. Imprimir el estado inicial (Conectado) ---
  const html1 = await page.content();
  fs.writeFileSync(debugHtmlPath1, html1);
  console.log(`[DOM-Inspect] HTML (Paso 1 - Inicial) guardado en: ${debugHtmlPath1}`);

  // --- 3. Esperar 5 segundos y sugerir acción ---
  console.log("\n[DOM-Inspect] Esperando 5 segundos. Ahora es el momento de desconectar tu móvil de la red (WiFi/Datos) para forzar un cambio de estado.");
  console.log("⏳ Esperando...");
  await page.waitForTimeout(5000); 

  // --- 4. Imprimir el estado después de la espera ---
  const html2 = await page.content();
  fs.writeFileSync(debugHtmlPath2, html2);
  console.log(`[DOM-Inspect] HTML (Paso 2 - Final) guardado en: ${debugHtmlPath2}`);

  console.log("\n[DOM-Inspect] Proceso completado. Los archivos HTML están listos para la comparación.");
  console.log(`[DOM-Inspect] Archivos: ${debugHtmlPath1} y ${debugHtmlPath2}`);

  await context.close();
  process.exit(0);

})();