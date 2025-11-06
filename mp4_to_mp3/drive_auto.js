// drive_auto.js
'use strict';

const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // solo para activar el patch stealth global
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
   REINICIO ROBUSTO DEL RUNTIME (core)
   ────────────────────────────────────────────────────────────────────────── */
async function clickDisconnectAndDelete(page) {
  const dropdownSelector = '[aria-label*="Additional connection options"]';
  await page.waitForSelector(dropdownSelector, { timeout: 15000 });
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

  if (!ok) throw new Error('No se encontró "Disconnect and delete runtime" en el menú.');
  console.log('✅ Opción "Disconnect and delete runtime" pulsada.');
}

async function confirmYesOkDialogs(page) {
  // intenta clicar YES del diálogo (mwc/colab/paper/dialog), si no, Enter
  const tryClickYes = async () => {
    return await page.evaluate(() => {
      const selCandidates = [
        // mwc-dialog (nuevo)
        'mwc-dialog.yes-no-dialog[open] md-text-button[slot="primaryAction"][dialogaction="ok"] span.touch',
        'mwc-dialog.yes-no-dialog[open] md-text-button[slot="primaryAction"][dialogaction="ok"]',
        // variantes genéricas
        'mwc-dialog[open] [dialogaction="ok"]',
        'colab-dialog[open] [dialogaction="ok"]',
        'paper-dialog[opened] .ok',
        'dialog[open] button:not([disabled]):not([aria-disabled="true"])'
      ];
      for (const s of selCandidates) {
        const host = document.querySelector(s);
        if (!host) continue;
        // intenta botón dentro de shadow si aplica
        let btn = host;
        if (host.shadowRoot) {
          btn = host.shadowRoot.querySelector('button, md-text-button') || host;
        }
        if (typeof btn.click === 'function') { btn.click(); return true; }
      }
      return false;
    });
  };

  // da margen a que aparezca
  await sleep(400);
  let yes = await tryClickYes();
  if (!yes) {
    console.warn('⚠️ No encontré botón YES visible, intento ENTER…');
    await page.keyboard.press('Enter').catch(()=>{});
    yes = true; // damos por bueno
  } else {
    console.log('🖱️ YES (OK) pulsado');
  }

  // posible diálogo "OK" posterior
  await sleep(1200);
  try {
    const clickedOk = await page.evaluate(() => {
      const sels = [
        'mwc-dialog[open] [dialogaction="ok"]',
        'colab-dialog[open] [dialogaction="ok"]',
        'paper-dialog[opened] .ok',
        'dialog[open] button:not([disabled]):not([aria-disabled="true"])'
      ];
      for (const s of sels) {
        const n = document.querySelector(s);
        if (n) { n.click(); return true; }
      }
      return false;
    });
    if (clickedOk) console.log('✅ Diálogo “OK” confirmado.');
  } catch {}

  // espera a que no quede ningún diálogo abierto
  try {
    await page.waitForFunction(() =>
      !document.querySelector('mwc-dialog[open], colab-dialog[open], paper-dialog[opened], dialog[open]'),
      { timeout: 8000 }
    );
  } catch {
    console.warn('⚠️ Timeout esperando cierre visual del diálogo; seguimos.');
  }
}

async function restartRuntimeHard(page) {
  console.log('🔌 Reiniciando entorno de ejecución…');
  await clickDisconnectAndDelete(page);
  await confirmYesOkDialogs(page);
  // pequeño margen tras el reset
  await sleep(1200);
  console.log('✅ Reinicio confirmado.');
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

  // 3) Cierra popups y limpia salidas
  try {
    const runAnyway = page.locator('colab-dialog button:has-text("Run anyway")').first();
    if (await runAnyway.isVisible({ timeout: 3000 })) { await runAnyway.click(); await sleep(600); }
    const welcomeClose = page.locator('colab-dialog[class*="welcome-dialog"] #close-icon').first();
    if (await welcomeClose.isVisible({ timeout: 1000 })) { await welcomeClose.click(); await sleep(300); }
  } catch {}
  try {
    await page.locator('#edit-menu-button').click();
    await page.locator('#edit-menu .goog-menuitem').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.goog-menuitem:has-text("Clear all outputs")').first().click();
    await page.locator('#edit-menu').waitFor({ state: 'hidden', timeout: 5000 });
    console.log('🧹 Salidas limpiadas.');
  } catch (e) {
    console.warn('ℹ️ No se pudo limpiar (posible ausencia de salidas):', e.message);
  }

  // 4) Ejecuta celda 0 (activación) y REINICIA runtime de forma robusta
  console.log('1️⃣ Ejecutando primera celda…');
  const runBtn0 = page.locator('.cell.code >> nth=0 >> colab-run-button').first();
  await runBtn0.waitFor({ state: 'visible', timeout: 15000 });
  await runBtn0.click();
  console.log('⏳ Espera breve antes del reinicio…');
  await sleep(1200);

  await restartRuntimeHard(page);

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

  // Si aparece un segundo popup, lo atendemos igual (best effort, 6s)
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

  // 6) Celda 2 (tu “tercera” visual): obtener link trycloudflare
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
      // await browser.close();
    })
    .catch(err => {
      console.error('🔥 Error:', err?.stack || err?.message);
      process.exit(1);
    });
}

module.exports = { drive_auto };
