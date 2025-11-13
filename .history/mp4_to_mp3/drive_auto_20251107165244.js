// drive_auto.js
'use strict';

const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // activa stealth global en chromium
const puppeteer = require('puppeteer-extra');                     // no usamos su API; Playwright viene de auto_log_in
const { attemptGoogleLogin } = require('./auto_log_in.js');       // ← devuelve { browser, context, page } (Playwright)

const stealth = StealthPlugin();
puppeteer.use(stealth);

// Notebook con las 3 celdas (montar Drive, convertir, exponer enlace, etc.)
const COLAB_NOTEBOOK_URL =
  'https://colab.research.google.com/drive/1WjbE6Cez95NnBn4AhLgisCHG2FJuDrmk?usp=sharing';

const EMAIL = process.env.GOOGLE_USER || 'pacoplanestomas@gmail.com';
const PASS  = process.env.GOOGLE_PASS  || '392002Planes0.';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/* ──────────────────────────────────────────────────────────────────────────
   Helpers: botón “Connect to Google Drive / Conectar…”
   ────────────────────────────────────────────────────────────────────────── */
async function waitAndFocusConnectButton(page, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const focused = await page.evaluate(() => {
      const RX = /(Connect to Google Drive|Conectar con Google Drive)/i;
      const collect = (root, acc) => {
        acc.push(root);
        const q = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of q) {
          acc.push(el);
          if (el.shadowRoot) collect(el.shadowRoot, acc);
        }
      };
      const nodes = [];
      collect(document, nodes);
      const txt = (el) => (el.innerText || el.textContent || '').trim();

      // slot="primaryAction"
      for (const n of nodes) {
        if (n.getAttribute?.('slot') === 'primaryAction' && RX.test(txt(n))) {
          const t = n.shadowRoot?.querySelector('button') || n.querySelector?.('button') || n;
          t?.focus?.();
          return !!t && (document.activeElement === t || t.contains(document.activeElement));
        }
      }
      // cualquier botón visible con el texto
      for (const n of nodes) {
        if (n.matches?.("button, md-text-button, mwc-button, paper-button, [role='button']") && RX.test(txt(n))) {
          const t = n.shadowRoot?.querySelector('button') || n.querySelector?.('button') || n;
          t?.focus?.();
          return !!t && (document.activeElement === t || t.contains(document.activeElement));
        }
      }
      return false;
    });
    if (focused) return true;
    await sleep(100);
  }
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────
   Helpers: Popup OAuth (selección por email / formulario + consents)
   ────────────────────────────────────────────────────────────────────────── */
async function handleOAuthPopupByEmailOrForm(p) {
  // 1) tarjeta de cuenta directa
  try {
    let candidate = p.locator(`[data-email="${EMAIL}"]`).first();
    if (!(await candidate.count())) {
      candidate = p.locator(`div[role="button"]:has-text("${EMAIL}")`).first();
    }
    if (await candidate.count()) {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click();
      console.log(`🟢 Cuenta seleccionada por email: ${EMAIL}`);
    }
  } catch (e) {
    console.log('ℹ️ No se pudo seleccionar tarjeta directa:', e.message);
  }

  // 2) formulario email → pass (si aparece)
  try {
    const emailBox = p.locator('#identifierId:visible, input[name="identifier"]:visible, input[type="email"]:visible').first();
    if (await emailBox.count()) {
      await emailBox.click().catch(()=>{});
      await emailBox.fill('').catch(()=>{});
      await emailBox.type(EMAIL, { delay: 40 });
      const nextId = p.locator('#identifierNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible').first();
      if (await nextId.count()) {
        await Promise.all([p.waitForLoadState('domcontentloaded').catch(()=>{}), nextId.click()]);
      } else {
        await p.keyboard.press('Enter').catch(()=>{});
      }
    }

    await Promise.race([
      p.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first().waitFor({ timeout: 15000 }),
      p.waitForURL(/challenge\/pwd|signin\/v2\/sl\/pwd/i, { timeout: 15000 }).catch(()=>{})
    ]).catch(()=>{});
    const passBox = p.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first();
    if (await passBox.count()) {
      await passBox.click().catch(()=>{});
      await passBox.fill('').catch(()=>{});
      await passBox.type(PASS, { delay: 40 });
      const nextPwd = p.locator('#passwordNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible').first();
      if (await nextPwd.count()) {
        await Promise.all([p.waitForLoadState('domcontentloaded').catch(()=>{}), nextPwd.click()]);
      } else {
        await p.keyboard.press('Enter').catch(()=>{});
      }
      console.log('🟢 Password enviado.');
    }
  } catch (e) {
    console.log('ℹ️ Flujo de formulario no requerido:', e.message);
  }

  // 3) 1-2 pantallas de “Consent”
  for (let i = 0; i < 4; i++) {
    try {
      const cont = p.locator('button:has-text("Continuar"), button:has-text("Continue")').first();
      await cont.waitFor({ state: 'visible', timeout: 15000 });
      await cont.click();
      await p.waitForTimeout(600);
      console.log(`➡️ Consent #${i + 1}`);
    } catch {
      break;
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Reinicio de Runtime — NUEVO: vía menú "Runtime" (EN/ES, UI nueva/antigua)
   ────────────────────────────────────────────────────────────────────────── */
async function openRuntimeMenu(page) {
  const buttons = [
    '#runtime-menu-button',
    '[aria-label="Runtime"]',
    '[aria-label="Entorno de ejecución"]',
    'text=Runtime',
    'text=Entorno de ejecución'
  ];
  for (const sel of buttons) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      await loc.click({ delay: 20 });
      // menú clásico (goog) o role="menu"
      const menu = page.locator('.goog-menu.goog-menu-vertical,[role="menu"]').first();
      await menu.waitFor({ state: 'visible', timeout: 8000 });
      return true;
    } catch { /* siguiente selector */ }
  }
  return false;
}

async function clickRuntimeRestartLike(page) {
  const candidates = [
    // EN
    '.goog-menuitem:has-text("Restart runtime")',
    '.goog-menuitem:has-text("Factory reset runtime")',
    '.goog-menuitem:has-text("Disconnect and delete runtime")',
    '[role="menuitem"]:has-text("Restart runtime")',
    '[role="menuitem"]:has-text("Factory reset runtime")',
    '[role="menuitem"]:has-text("Disconnect and delete runtime")',
    // ES
    '.goog-menuitem:has-text("Reiniciar el entorno de ejecución")',
    '.goog-menuitem:has-text("Restablecer el entorno")',
    '.goog-menuitem:has-text("Desconectar y eliminar el entorno")',
    '[role="menuitem"]:has-text("Reiniciar el entorno de ejecución")',
    '[role="menuitem"]:has-text("Restablecer el entorno")',
    '[role="menuitem"]:has-text("Desconectar y eliminar el entorno")'
  ];
  const item = page.locator(candidates.join(', ')).first();
  await item.waitFor({ state: 'visible', timeout: 10000 });
  await item.click();
}

async function confirmYesOkDialogs(page) {
  const tryClick = async () => {
    return await page.evaluate(() => {
      const sels = [
        // mwc/colab modernos
        'mwc-dialog[open] [dialogaction="ok"]',
        'colab-dialog[open] [dialogaction="ok"]',
        // textos frecuentes
        'mwc-dialog[open] button:enabled',
        'colab-dialog[open] button:enabled',
        'paper-dialog[opened] .ok',
        // genérico
        'dialog[open] button:not([disabled]):not([aria-disabled="true"])'
      ];
      for (const s of sels) {
        const n = document.querySelector(s);
        if (n) { n.click(); return true; }
      }
      return false;
    });
  };
  await sleep(400);
  let ok = await tryClick();
  if (!ok) {
    // prueba con textos internacionales
    const labels = ['Yes','OK','Restart','Continue','Aceptar','Reiniciar','Sí'];
    for (const t of labels) {
      try {
        const b = await page.locator(`button:has-text("${t}")`).first();
        if (await b.count()) { await b.click(); ok = true; break; }
      } catch {}
    }
  }
  if (!ok) { await page.keyboard.press('Enter').catch(()=>{}); }
  // esperar cierre de diálogos
  try {
    await page.waitForFunction(() =>
      !document.querySelector('mwc-dialog[open], colab-dialog[open], paper-dialog[opened], dialog[open]'),
      { timeout: 8000 }
    );
  } catch {}
}

// Fallback antiguo por si el menú fallase (lo dejamos como último recurso)
async function clickDisconnectAndDeleteLegacy(page) {
  const dropdownSelector = '[aria-label*="Additional connection options"]';
  await page.waitForSelector(dropdownSelector, { timeout: 8000 });
  await page.click(dropdownSelector);
  await page.waitForSelector('.goog-menu.goog-menu-vertical', { visible: true, timeout: 5000 });

  const ok = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.goog-menuitem, .goog-menuitem-content'));
    const wants = [
      'disconnect and delete runtime',
      'desconectar y eliminar el entorno',
      'desconectar y eliminar runtime',
      'disconnect and delete'
    ];
    const pick = items.find(el => wants.some(w => (el.textContent || '').toLowerCase().includes(w)));
    if (!pick) return false;
    const target = pick.closest('.goog-menuitem') || pick;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
    target.click();
    return true;
  });
  if (!ok) throw new Error('Legacy: no se encontró "Disconnect and delete runtime".');
}

async function restartRuntimeFlexible(page) {
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
}

/* ──────────────────────────────────────────────────────────────────────────
   Flujo principal (Drive + Colab)
   ────────────────────────────────────────────────────────────────────────── */
async function drive_auto() {
  console.log('🚀 Iniciando el flujo en Google Colab…');

  // 1) Login con Playwright (auto_log_in.js)
  let browser, context, page;
  ({ browser, context, page } = await attemptGoogleLogin());
  if (!page || page.isClosed() || !page.url().includes('drive.google.com')) {
    throw new Error('Login process failed to land on Google Drive.');
  }
  console.log(`[Main] Confirmada página en Google Drive: ${page.url()}`);

  // 2) Abrir notebook
  console.log(`🌍 Navegando al notebook: ${COLAB_NOTEBOOK_URL}`);
  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: 'load', timeout: 180000 });
  console.log('✅ Navegación completada; esperando editor…');
  await page.locator('.cell.code').first().waitFor({ state: 'visible', timeout: 120000 });
  console.log('✅ Editor visible.');

  // 3) Popups “Run anyway” / bienvenida y (opcional) limpiar salidas
  try {
    const runAnyway = page.locator('colab-dialog button:has-text("Run anyway")').first();
    if (await runAnyway.count()) { await runAnyway.click(); await sleep(600); }
  } catch {}
  try {
    const welcomeClose = page.locator('colab-dialog[class*="welcome-dialog"] #close-icon').first();
    if (await welcomeClose.count()) { await welcomeClose.click(); await sleep(300); }
  } catch {}
  // limpiar salidas (best-effort, sin romper si no aparece)
  try {
    const editBtn = page.locator('#edit-menu-button, [aria-label="Edit"], [aria-label="Editar"], text=Edit, text=Editar').first();
    await editBtn.click();
    const clearItem = page.locator('.goog-menuitem:has-text("Clear all outputs"), [role="menuitem"]:has-text("Clear all outputs"), .goog-menuitem:has-text("Borrar todas las salidas"), [role="menuitem"]:has-text("Borrar todas las salidas")').first();
    await clearItem.waitFor({ state: 'visible', timeout: 3000 });
    await clearItem.click();
    await page.locator('#edit-menu, [role="menu"]:has-text("Clear")').first().waitFor({ state: 'hidden', timeout: 3000 }).catch(()=>{});
    console.log('🧹 Salidas limpiadas.');
  } catch {
    console.warn('ℹ️ No se pudo limpiar (UI distinta o sin salidas).');
  }

  // 4) Ejecuta celda 0 (activación) y reinicia runtime de forma flexible
  console.log('1️⃣ Ejecutando primera celda…');
  const runBtn0 = page.locator('colab-run-button').first();
  await runBtn0.waitFor({ state: 'visible', timeout: 20000 });
  await runBtn0.click();
  console.log('⏳ Espera breve antes del reinicio…');
  await sleep(1200);

  await restartRuntimeFlexible(page); // ← REEMPLAZA al método antiguo

  // Re-ejecuta celda 0 para reactivar tras el reinicio
  try {
    const editor0 = await page.locator('.cell.code').nth(0).locator('.monaco-editor').first();
    await editor0.click();
    await page.keyboard.down(mod); await page.keyboard.press('Enter'); await page.keyboard.up(mod);
    console.log('✅ Celda 0 re-ejecutada tras el reinicio.');
  } catch (e) {
    console.warn('⚠️ No se pudo relanzar la celda 0:', e.message);
  }

  // 5) Celda 1 (montaje Drive)
  console.log('2️⃣ Ejecutando Celda 2 (montaje Drive)…');
  const editor1 = await page.locator('.cell.code').nth(1).locator('.monaco-editor').first();
  await editor1.click();

  // Preparar captura de popup
  const popupPromise = new Promise((resolve) =>
    context.once('page', (newPage) => { console.log('… Popup OAuth detectada!'); resolve(newPage); })
  );

  await page.keyboard.down(mod); await page.keyboard.press('Enter'); await page.keyboard.up(mod);
  console.log('⏳ Celda 2 lanzada. Esperando ~5s…'); await sleep(5000);

  const focused = await waitAndFocusConnectButton(page, 30000);
  if (!focused) console.warn('⚠️ No se pudo enfocar el botón; ENTER igualmente.');
  await page.keyboard.press('Enter');
  console.log('↩️ ENTER enviado al diálogo de Colab.');

  // Manejo de 1–2 consent popups
  const firstPopup = await popupPromise;
  await firstPopup.waitForLoadState('load', { timeout: 60000 });
  await firstPopup.bringToFront();
  console.log('🔓 Popup OAuth cargada:', firstPopup.url());
  await handleOAuthPopupByEmailOrForm(firstPopup);
  await new Promise(res => firstPopup.once('close', res));
  console.log('✅ Popup #1 cerrada.');

  // Si aparece un segundo popup, lo atendemos igual (best effort)
  try {
    const second = await context.waitForEvent('page', { timeout: 6000, predicate: p => p !== page }).catch(()=>null);
    if (second) {
      await second.waitForLoadState('load', { timeout: 30000 }).catch(()=>{});
      await second.bringToFront().catch(()=>{});
      console.log('🔓 Popup OAuth #2:', second.url());
      await handleOAuthPopupByEmailOrForm(second);
      await new Promise(res => second.once('close', res));
      console.log('✅ Popup #2 cerrada.');
    }
  } catch {}

  await page.bringToFront();
  console.log('🕰️ Margen para montar /content/drive…');
  await sleep(8000);

  // 6) Celda 2 (tercera visual): obtener link trycloudflare (si tu notebook lo genera)
  console.log('3️⃣ Ejecutando Celda 3…');
  const editor2 = await page.locator('.cell.code').nth(2).locator('.monaco-editor').first();
  await editor2.click();
  await page.keyboard.down(mod); await page.keyboard.press('Enter'); await page.keyboard.up(mod);

  console.log('👂 Esperando enlace trycloudflare…');
  const link = await page
    .locator("colab-static-output-renderer a[href*='trycloudflare.com']")
    .first()
    .waitFor({ timeout: 300000 })
    .then(h => page.evaluate(a => a.href, h));

  console.log('✅ URL:', link);
  return { result: link, page, browser };
}

/* ────────────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  drive_auto()
    .then(({ result /*, browser*/ }) => {
      console.log('\n📊 RESULTADO FINAL (URL):\n', result);
      // No cerramos el navegador a propósito
    })
    .catch(err => {
      console.error('🔥 Error:', err?.stack || err?.message);
      process.exit(1);
    });
}

module.exports = { drive_auto };
