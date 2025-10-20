const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
// Asegúrate de que tu archivo de login ('auto_log_in.js') esté en la misma carpeta.
// Usaremos la versión corregida de auto_log_in.js que espera correctamente
const { attemptGoogleLogin } = require("./auto_log_in.js"); // Devuelve { browser, context, page }

const stealth = StealthPlugin();
puppeteer.use(stealth);

// --- Constantes del Notebook ---
const COLAB_NOTEBOOK_URL =
  "https://colab.research.google.com/drive/14DoEu8zTb-CYiZYbWmzowDy-uhnspvtu?usp=sharing";
// const NOTEBOOK_ID = "14DoEu8zTb-CYiZYbWmzowDy-uhnspvtu"; // No usado
const SESSION_FILE = "google_session.json";

// --- Funciones Auxiliares ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Flujo Principal ---
async function enableGpuAndRun() {
  console.log("🚀 Iniciando GPU en Google Colab...");
  let browser, context, page;

  try {
      ({ browser, context, page } = await attemptGoogleLogin());
      if (!page || page.isClosed() || !page.url().includes("drive.google.com")) {
          throw new Error("Login process failed to land on Google Drive.");
      }
      console.log(`[Main] Confirmada página en Google Drive: ${page.url()}`);
  } catch (loginError) {
      console.error(`🔥 Fatal error during login process: ${loginError.message}`);
      if (browser) await browser.close().catch(e => console.error("Error closing browser on login failure:", e));
      throw loginError;
  }

  // Navegar a Colab
  // En la sección "Navegar a Colab"
try {
  console.log(`🌍 Navegando al notebook: ${COLAB_NOTEBOOK_URL}`);
  
  // --- LÍNEA CORREGIDA ---
  // Cambia 'networkidle' por 'domcontentloaded'
  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: "domcontentloaded", timeout: 180000 });
  // -------------------------

  console.log("✅ Navegación a Colab completada.");

  // Esperar a que la estructura principal de Colab esté lista
  console.log("⏳ Esperando a que el editor de Colab y las celdas carguen...");
  const firstCell = page.locator('.cell.code').first();
  await firstCell.waitFor({ state: 'visible', timeout: 120000 });
  console.log("✅ Notebook editor visible."); // Esta línea ahora sí debería aparecer

} catch (colabNavError) {
   console.error(`❌ Falló la navegación o carga del notebook Colab: ${colabNavError.message}`);
   await page.screenshot({ path: 'error_colab_navigation.png' });
   throw colabNavError;
}

// --- ¡NUEVO PASO: LIMPIEZA INICIAL DE SALIDAS! (MÉTODO ROBUSTO CORREGIDO) ---
try {
  console.log("🧹 Limpiando todas las salidas usando el menú principal...");
  
  // --- Bloque de popups (se mantiene igual) ---
  try {
      console.log("...Buscando popups de advertencia/bienvenida...");
      const warningButton = page.locator('colab-dialog button:has-text("Run anyway")').first();
      if (await warningButton.isVisible({ timeout: 3000 })) {
          await warningButton.click();
          console.log("...Popup 'Run anyway' cerrado.");
          await sleep(1000);
      }
      const welcomeClose = page.locator('colab-dialog[class*="welcome-dialog"] #close-icon').first();
      if (await welcomeClose.isVisible({ timeout: 1000 })) {
          await welcomeClose.click();
          console.log("...Popup 'Welcome' cerrado.");
          await sleep(500);
      }
  } catch (e) {
      console.log("...No se encontraron popups (o ya estaban cerrados).");
  }
  // --- Fin del bloque de popups ---

  // 1. Hacemos clic en el botón del menú "Edit" de la barra principal.
  await page.locator('#edit-menu-button').click();

  // 2. Esperamos a que el menú desplegable aparezca.
  await page.locator('#edit-menu .goog-menuitem').first().waitFor({ state: 'visible', timeout: 5000 });
  
  // 3. Hacemos clic en la opción "Clear all outputs".
  const clearAllButton = page.locator('.goog-menuitem:has-text("Clear all outputs")').first();
  await clearAllButton.click();

  // 4. (Opcional pero recomendado) Esperamos a que el menú se cierre para asegurar que el clic se procesó.
  await page.locator('#edit-menu').waitFor({ state: 'hidden', timeout: 5000 });
  
  console.log("✅ Todas las salidas han sido limpiadas.");
  await sleep(500); // Pequeña pausa para que la UI se actualice.

} catch (clearErr) {
    // Este error no es crítico. Si falla, es probable que no hubiera salidas que limpiar.
    console.warn(`⚠️ No se pudo limpiar las salidas usando el menú principal. Esto puede ser normal. Mensaje: ${clearErr.message}`);
}
// --- FIN DE LIMPIEZA INICIAL ---


  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // --- PASO 1: Ejecutar la primera celda (para activar entorno) ---
  // (Esta parte no necesita cambios significativos, usaremos localizador)
  try {
      console.log("1️⃣ Ejecutando la primera celda (activación)...");
      const firstCellRunButton = page.locator('.cell.code >> nth=0 >> colab-run-button').first();
      await firstCellRunButton.waitFor({ state: 'visible', timeout: 15000 });
      await firstCellRunButton.click();
      console.log("✅ Celda 1 ejecución iniciada.");
  } catch(e) {
       console.error(`❌ Falló al iniciar la ejecución de la primera celda: ${e.message}`);
       await page.screenshot({ path: 'error_run_cell_1_init.png' });
       throw e;
  }

  // Esperar conexión estable
  // (Esta parte no necesita cambios)
  console.log("⏳ Esperando conexión estable del entorno...");
  const connectTimeout = 180000;
  try {
      await page.waitForFunction(() => {
          const connectButton = document.querySelector('colab-connect-button');
          const icon = connectButton?.shadowRoot?.querySelector('#connect-icon');
          return icon?.classList.contains('notebook-connected-icon') ||
                 icon?.classList.contains('icon-filled') ||
                 icon?.classList.contains('icon-okay');
      }, { timeout: connectTimeout });
      console.log("✅ Entorno conectado.");
  } catch (e) {
      console.error(`❌ Timeout esperando conexión estable (${connectTimeout/1000}s).`);
      await page.screenshot({ path: 'error_connection_timeout.png' });
      throw new Error("Timeout esperando conexión del entorno Colab.");
  }

  // --- PASO 2: Desconectar y eliminar el entorno ---
  // (Esta parte no necesita cambios, ya usa localizadores)
  try {
    console.log("🔌 Reiniciando entorno...");
    console.log("🖱️ Clic en 'Runtime' menu...");
    await page.click('#runtime-menu-button');
    await page.waitForSelector('#runtime-menu .goog-menuitem', { visible: true, timeout: 5000 });
    console.log("✅ 'Runtime' menu abierto.");

    console.log("🖱️ Clic en 'Disconnect and delete runtime'...");
    const disconnectItem = page.locator('.goog-menuitem:has-text("Disconnect and delete runtime")');
    await disconnectItem.waitFor({ state: 'visible', timeout: 5000 });
    await disconnectItem.click();
    console.log("✅ Clickeado 'Disconnect and delete runtime'.");

    console.log("⏳ Manejando diálogo 'Yes/No'...");
    const dialogSelector = 'mwc-dialog.yes-no-dialog[open]';
    await page.waitForSelector(dialogSelector, { state: 'visible', timeout: 10000 });
    const yesButtonSelector = `${dialogSelector} md-text-button[slot="primaryAction"][dialogaction="ok"]`;
    console.log("🖱️ Clic en 'Yes'...");
    await page.locator(yesButtonSelector).click();
    console.log("👍 Clickeado 'Yes'.");
    await page.waitForSelector(dialogSelector, { state: 'hidden', timeout: 10000 });
    console.log("✅ Diálogo cerrado.");
    await sleep(1500);

  } catch (e) {
    console.error("❌ Error durante el reinicio del runtime:", e.message);
    await page.screenshot({ path: 'error_runtime_reset.png' });
    throw e;
  }

  // --- PASO 3: Ejecutar las 3 celdas principales ---
  console.log("▶️ Ejecutando flujo principal de 3 celdas...");
  let result = null;

  for (let i = 0; i < 3; i++) {
    const cellIndex = i;
    const cellSelector = `.cell.code >> nth=${cellIndex}`;
    console.log(`--- Procesando Celda ${cellIndex + 1} ---`);

    try {
        await page.waitForSelector(cellSelector, { timeout: 15000 });
        const cellHandle = page.locator(cellSelector);
        await cellHandle.scrollIntoViewIfNeeded();
        await sleep(200);

        const runButtonSelector = `${cellSelector} colab-run-button`;
        const runButton = page.locator(runButtonSelector).first();
        await runButton.waitFor({ state: 'visible', timeout: 10000 });

        // NO volvemos a limpiar la salida aquí, ya lo hicimos al principio.

        console.log(`▶️ Clickeando botón de ejecución para Celda ${cellIndex + 1}...`);
        await runButton.click();
        console.log(`✅ Ejecución de Celda ${cellIndex + 1} iniciada.`);

        // --- Lógica de Espera ---
        if (cellIndex < 2) {
             console.log(`⏳ Esperando que la Celda ${cellIndex + 1} termine (o timeout)...`);
             try {
                  // Esperar a que el icono de ejecución desaparezca
                  await runButton.locator('.cell-execution-icon.executing').waitFor({ state: 'hidden', timeout: 60000 });
                  console.log(`✅ Indicador de ejecución de Celda ${cellIndex + 1} oculto.`);
             } catch {
                   console.warn(`⚠️ Indicador de ejecución de Celda ${cellIndex + 1} no desapareció en 60s.`);
                   await sleep(5000); // Espera adicional
             }
        } else {
             // Celda 3: Esperar la salida de Cloudflare
             console.log("👂 Esperando enlace Cloudflare en la salida de la Celda 3...");
             const outputSelector = `${cellSelector} colab-static-output-renderer`;
             const linkSelector = `${outputSelector} a[href*='trycloudflare.com']`;

             await page.waitForSelector(outputSelector, { state: 'visible', timeout: 300000 }); // Esperar área de salida
             const linkHandle = await page.waitForSelector(linkSelector, { timeout: 30000 }); // Esperar enlace
             result = await linkHandle.getAttribute('href');
             console.log(`✅ URL Cloudflare capturada: ${result}`);
        }

    } catch (cellError) {
         console.error(`❌ Error ejecutando o esperando la Celda ${cellIndex + 1}: ${cellError.message}`);
         await page.screenshot({ path: `error_cell_${cellIndex + 1}.png` });
         if (cellIndex === 2) result = null;
         // Considera si detenerte: throw cellError;
         break; // Salir del bucle si una celda falla
    }
  } // Fin del bucle for

  // Guardar sesión
  try {
      const storage = await context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
      console.log(`💾 Estado de sesión guardado en ${SESSION_FILE}`);
  } catch(e) {
       console.warn(`⚠️ No se pudo guardar el estado de sesión: ${e.message}`);
  }

  // Devolver resultado y navegador
  return { result, browser };
}

// --- Bloque Principal de Ejecución (para pruebas) ---
if (require.main === module) {
  enableGpuAndRun()
    .then(async ({ result, browser }) => {
      console.log("\n📊 RESULTADO FINAL (URL):\n", result);
      // Opcional: Cerrar al ejecutar standalone
      // if (browser) await browser.close();
      // console.log("🚪 Navegador cerrado.");
    })
    .catch((err) => {
      console.error("🔥 Error en el flujo principal de enableGpuAndRun:", err.message);
      if (err.stack) {
          console.error(err.stack);
      }
      process.exit(1);
    })
    .finally(async () => {
        // Podrías añadir lógica para cerrar el browser aquí si es necesario
    });
}

module.exports = { enableGpuAndRun };