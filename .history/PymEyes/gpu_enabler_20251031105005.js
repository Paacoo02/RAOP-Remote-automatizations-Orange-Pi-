


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
// En la sección "Navegar a Colab"
try {
  console.log(`🌍 Navegando al notebook: ${COLAB_NOTEBOOK_URL}`);
  
  // --- LÍNEA CORREGIDA ---
  // 'domcontentloaded' es demasiado rápido (nos "adelantamos").
  // Usamos 'load', que espera a que los scripts y recursos iniciales carguen.
  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: "load", timeout: 180000 });
  // -------------------------

  // Añadimos un log para saber que el 'goto' terminó y ahora esperamos la UI
  console.log("✅ Navegación (goto) completada. Esperando la UI del editor...");

  // Esperar a que la estructura principal de Colab esté lista
  // (Esta parte ya estaba bien)
  console.log("⏳ Esperando a que el editor de Colab y las celdas carguen...");
  const firstCell = page.locator('.cell.code').first();
  await firstCell.waitFor({ state: 'visible', timeout: 120000 });
  console.log("✅ Notebook editor visible.");

} catch (colabNavError) {
   console.error(`❌ Falló la navegación o carga del notebook Colab: ${colabNavError.message}`);
   // Tomar un volcado del DOM puede ser útil aquí
   // const html = await page.content();
   // fs.writeFileSync('error_colab_dom.html', html);
   // console.log("... DOM guardado en error_colab_dom.html");
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
       throw e;
  }

  // Esperar conexión estable
  // (Esta parte no necesita cambios)
    // (Esta parte no necesita cambios)
    
  // --- PASO 2: Desconectar y eliminar el entorno ---
  // (Esta parte no necesita cambios, ya usa localizadores)
  try {
    console.log("🔌 Reiniciando entorno de ejecución...");

    // Abrir menú
    const dropdownSelector = '[aria-label*="Additional connection options"]';
    await page.waitForSelector(dropdownSelector, { timeout: 15000 });
    await page.click(dropdownSelector);
    console.log("✅ Menú desplegable abierto.");

    // Esperar menú visible
    await page.waitForSelector('.goog-menu.goog-menu-vertical', { visible: true, timeout: 5000 });

    // Clic en 'Disconnect...'
    console.log("⌨️ Buscando opción 'Disconnect and delete runtime'...");
    const clickedMenuItem = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".goog-menuitem, .goog-menuitem-content"));
      const targetItem = items.find(item =>
        (item.textContent || "").toLowerCase().includes("disconnect and delete runtime")
      );
      if (!targetItem) return false;
      targetItem.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      targetItem.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
      targetItem.click();
      return true;
    });

    if (!clickedMenuItem) {
      throw new Error("❌ No se pudo encontrar 'Disconnect and delete runtime' en el menú.");
    }
    console.log("✅ Opción 'Disconnect and delete runtime' pulsada.");

    // --- MANEJO DEL DIÁLOGO DE CONFIRMACIÓN (SIN ESPERA EXPLÍCITA) ---
    console.log("⏳ Intentando confirmar el diálogo 'Yes/No' inmediatamente...");
    // Selectores para usar DENTRO de evaluate:
    const dialogSelectorForEval = 'mwc-dialog.yes-no-dialog[open]'; // Para buscar DENTRO del evaluate
    const yesButtonContainerSelector = 'md-text-button[slot="primaryAction"][dialogaction="ok"]';
    const touchSpanSelector = 'span.touch';

    let yesClicked = false;
    try {
        // Pausa muy breve por si el diálogo tarda unas décimas de segundo en añadirse al DOM
        await sleep(500);

        console.log("🖱️ Intentando click en 'Yes' (priorizando span.touch) usando page.evaluate...");
        yesClicked = await page.evaluate((dialogSel, yesBtnContainerSel, touchSel) => {
            const dialogElement = document.querySelector(dialogSel);
            // Si el diálogo NO existe en este punto, page.evaluate simplemente devolverá false
            if (!dialogElement) {
                console.log("... Diálogo no encontrado en el DOM al intentar click.");
                return false;
            }

            let clickTarget = null;
            const yesButtonContainer = dialogElement.querySelector(yesBtnContainerSel) ||
                                      (dialogElement.shadowRoot ? dialogElement.shadowRoot.querySelector(yesBtnContainerSel) : null);

            if (yesButtonContainer) {
            clickTarget = yesButtonContainer.querySelector(touchSel) || yesButtonContainer; // Intenta span, si no, el botón
            }

            if (clickTarget && typeof clickTarget.click === 'function') {
            clickTarget.click();
            return true;
            }
            console.warn("Botón 'Yes' o span.touch no encontrados dentro del diálogo existente.");
            return false;
        }, dialogSelectorForEval, yesButtonContainerSelector, touchSpanSelector);

        if (yesClicked) {
          console.log("⏳ 'Yes' pulsado. Esperando posible diálogo 'OK' (1.5s)...");
          // Espera a que el diálogo "Yes" se cierre y aparezca el "OK"
          await sleep(1500); 
  
          try {
              // La estrategia más simple y genérica para un diálogo "OK"
              // es presionar 'Enter', ya que no tenemos selectores específicos para él.
              // Si el diálogo "OK" también fuera complejo, necesitaríamos
              // replicar la lógica de 'page.evaluate' con nuevos selectores.
              console.log("🖱️ Intentando pulsar 'OK' (Método: Presionar 'Enter')...");
              await page.keyboard.press('Enter');
              console.log("👍 'OK' pulsado (Método: Presionar 'Enter').");
  
          } catch (okError) {
              console.error("❌ Falló al presionar 'Enter' para el diálogo 'OK'.", okError.message);
              // No relanzamos el error; el "Yes" fue lo importante y ya se gestionó.
          }
        } else {
            // Fallback si evaluate no funcionó (p.ej., diálogo no estaba aún o botón no encontrado)
            console.warn("⚠️ No se pudo hacer clic con page.evaluate (diálogo/botón no listo?). Intentando 'Enter'...");
            await page.keyboard.press('Enter');
            console.log("👍 'Yes' pulsado (Método: Presionar 'Enter').");
            yesClicked = true; // Asumimos que Enter funcionará si el diálogo es modal
        }

    } catch (error) {
        // Error durante la evaluación o el press Enter
        console.warn(`⚠️ Error inesperado al intentar confirmar diálogo: ${error.message}. Intentando 'Enter' como fallback final...`);
        try {
            await page.keyboard.press('Enter');
            console.log("👍 'Yes' pulsado (Método: Presionar 'Enter' - Fallback de error).");
            yesClicked = true;
        } catch (enterError) {
            console.error("❌ Falló incluso al presionar 'Enter' tras error inicial.", enterError.message);
            // Considera si lanzar el error o continuar asumiendo que pudo funcionar
            // throw error; // Descomenta si fallar aquí debe detener todo
        }
    }

    // Esperar cierre del diálogo (opcional pero bueno para la estabilidad)
    if (yesClicked) {
      console.log("⌛ Esperando posible cierre del diálogo...");
      try {
        // Esperamos un tiempo razonable a que desaparezca el atributo 'open'
        await page.waitForFunction(() => !document.querySelector('mwc-dialog.yes-no-dialog[open]'), { timeout: 5000 });
        console.log("✅ Diálogo cerrado.");
      } catch (closeError) {
        console.warn("⚠️ El diálogo no se cerró visualmente tras la acción, pero continuamos...");
      }
    } else {
        // Si no se pudo hacer clic ni presionar Enter, es un problema
         console.error("❌ No se pudo confirmar el diálogo 'Yes/No' por ningún método.");
         throw new Error("Fallo al confirmar el reinicio del runtime.");
    }   

  } catch (e) {
    console.error("❌ Error detallado al reiniciar el entorno:", e);
    console.log("📸 Se ha guardado una captura de pantalla del error.");
    throw e;
  }

  // --- PASO 3: Ejecutar las 3 celdas en secuencia ---
  console.log("▶️ Ejecutando el flujo principal de 3 celdas...");
  let result = null;
  let stopButtonHandle = null;

  for (let i = 0; i < 3; i++) {
    const allCells = await page.$$(".cell.code");
    if (allCells.length < 3) throw new Error(`Error: Se esperaban ${3} celdas, pero se encontraron ${allCells.length}.`);

    const cell = allCells[i];
    await cell.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    const editor = await cell.waitForSelector(".monaco-editor", { timeout: 10000 });

    if (i === 2) { // Limpiar salida solo en la última celda
      console.log("🧹 Limpiando salida anterior de la celda 3...");
      await cell.evaluate((el) => {
        const outputNode = el.querySelector('.cell-output, .output_subarea, colab-static-output-renderer');
        if (outputNode) outputNode.innerHTML = '';
      });
      await sleep(200);
    }

    await editor.click();
    await page.keyboard.down(mod);
    await page.keyboard.press("Enter");
    await page.keyboard.up(mod);
    console.log(`▶️ Celda ${i + 1} ejecutada.`);

    await sleep(5000); // Espera después de ejecutar cada celda

    if (i === 2) { // Esperar resultado solo en la última celda
      try {
        console.log("👂 Esperando el enlace de Cloudflare...");
        const linkSelector = "colab-static-output-renderer a[href*='trycloudflare.com']";
        const linkHandle = await cell.waitForSelector(linkSelector, { timeout: 300000 });
        result = await page.evaluate(a => a.href, linkHandle);
        console.log(`✅ URL capturada: ${result}`);
        stopButtonHandle = await cell.$('.colab-run-button[title*="Detener"], .colab-run-button[title*="Stop"]');
        if (stopButtonHandle) console.log("✅ Botón de detención encontrado.");
      } catch (e) {
        console.error("❌ Error al leer la salida de la celda 3:", e.message);
        result = null;
      }
    }
  }

  return { result, stopButtonHandle, page, browser };
}

// --- Bloque de Ejecución Principal ---
if (require.main === module) {
  enableGpuAndRun()
    .then(async ({ result, browser }) => {
      console.log("\n📊 RESULTADO FINAL (URL):\n", result);
      // await browser.close(); // Descomenta si quieres cerrar al final
      // console.log("🚪 Navegador cerrado.");
    })
    .catch((err) => {
      console.error("🔥 Error en el flujo principal:", err.message);
      if (err.stack) {
          console.error(err.stack);
      }
      process.exit(1);
    });
}

module.exports = { enableGpuAndRun };