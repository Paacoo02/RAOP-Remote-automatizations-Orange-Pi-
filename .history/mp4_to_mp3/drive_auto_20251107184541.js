// drive_auto.js
'use strict';

const fs = require('fs');
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // activa stealth global en chromium
const puppeteer = require('puppeteer-extra');                     // no usamos su API; Playwright viene de auto_log_in
const { attemptGoogleLogin } = require('./auto_log_in.js');       // ← devuelve { browser, context, page } (Playwright)

const stealth = StealthPlugin();
puppeteer.use(stealth);

// Notebook con las 3 celdas (montar Drive, convertir, exponer enlace, etc.)
// Fuerza UI en inglés para estabilizar selectores: &hl=en
const COLAB_NOTEBOOK_URL =
  'https://colab.research.google.com/drive/1WjbE6Cez95NnBn4AhLgisCHG2FJuDrmk?usp=sharing&hl=en';

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

  // 3) 1-3 pantallas de “Consent”
  for (let i = 0; i < 3; i++) {
    try {
      const cont = p.locator('button:has-text("Continue"), button:has-text("Continuar")').first();
      await cont.waitFor({ state: 'visible', timeout: 8000 });
      await cont.click();
      await p.waitForTimeout(500);
      console.log(`➡️ Consent #${i + 1}`);
    } catch {
      break;
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Manejo de N popups OAuth en cascada (1..N). Continuar cuando cierren.
   ────────────────────────────────────────────────────────────────────────── */
function isOAuthLikeUrl(u = '') {
  return /accounts\.google\.com|ServiceLogin|signin|oauth|consent|gsi|challenge\/pwd/i.test(u);
}

async function waitForOAuthCascade(context, hostPage, handlePopupFn, {
  windowMs = 60000,
  idleMs   = 1200,
  detectTimeout = 12000,
} = {}) {
  const handled = new Set();
  const deadline = Date.now() + windowMs;
  let lastActivity = Date.now();

  const newlySeen = new Set();
  const onPage = (p) => {
    if (p === hostPage) return;
    newlySeen.add(p);
  };
  context.on('page', onPage);

  try {
    while (Date.now() < deadline) {
      const candidates = [...context.pages(), ...newlySeen]
        .filter(p => p && !p.isClosed() && p !== hostPage && !handled.has(p));

      let popup = null;
      for (const p of candidates) {
        try { await p.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(()=>{}); } catch {}
        const url = p.url();
        if (isOAuthLikeUrl(url)) { popup = p; break; }
      }

      if (!popup) {
        if (Date.now() - lastActivity >= idleMs) break;
        await sleep(200);
        continue;
      }

      handled.add(popup);
      await popup.bringToFront().catch(()=>{});
      await handlePopupFn(popup);

      await Promise.race([
        new Promise(res => popup.once('close', res)),
        popup.waitForURL(u => /colab\.research\.google\.com/i.test(u), { timeout: 15000 }).catch(()=>{})
      ]);

      lastActivity = Date.now();
    }
  } finally {
    context.off('page', onPage);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Reinicio de Runtime — intenta primero menú "Runtime", fallback a dropdown
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
      await loc.waitFor({ state: 'visible', timeout: 6000 });
      await loc.click({ delay: 20 });
      const menu = page.locator('.goog-menu.goog-menu-vertical,[role="menu"]').first();
      await menu.waitFor({ state: 'visible', timeout: 6000 });
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
  await item.waitFor({ state: 'visible', timeout: 8000 });
  await item.click();
}

async function confirmYesOkDialogs(page) {
  const tryClick = async () => {
    return await page.evaluate(() => {
      const sels = [
        'mwc-dialog[open] [dialogaction="ok"]',
        'colab-dialog[open] [dialogaction="ok"]',
        'mwc-dialog[open] button:enabled',
        'colab-dialog[open] button:enabled',
        'paper-dialog[opened] .ok',
        'dialog[open] button:not([disabled]):not([aria-disabled="true"])'
      ];
      for (const s of sels) {
        const n = document.querySelector(s);
        if (n) { n.click(); return true; }
      }
      return false;
    });
  };
  await sleep(300);
  let ok = await tryClick();
  if (!ok) {
    const labels = ['Yes','OK','Restart','Continue','Aceptar','Reiniciar','Sí'];
    for (const t of labels) {
      try {
        const b = page.locator(`button:has-text("${t}")`).first();
        if (await b.count()) { await b.click(); ok = true; break; }
      } catch {}
    }
  }
  if (!ok) { await page.keyboard.press('Enter').catch(()=>{}); }
  try {
    await page.waitForFunction(() =>
      !document.querySelector('mwc-dialog[open], colab-dialog[open], paper-dialog[opened], dialog[open]'),
      { timeout: 6000 }
    );
  } catch {}
}

async function restartRuntimeFlexible(page) {
  console.log("🔌 Reiniciando entorno de ejecución...");
  // 1) Intenta menú Runtime
  if (await openRuntimeMenu(page)) {
    try {
      await clickRuntimeRestartLike(page);
      await confirmYesOkDialogs(page);
      console.log('✅ Reinicio desde menú Runtime.');
      return;
    } catch (e) {
      console.warn('⚠️ Falló reinicio desde Runtime menu, probamos dropdown clásico:', e.message);
    }
  }
  // 2) Fallback: dropdown “Additional connection options”
  try {
    const dropdownSelector = '[aria-label*="Additional connection options"]';
    await page.waitForSelector(dropdownSelector, { timeout: 12000 });
    await page.click(dropdownSelector);
    await page.waitForSelector('.goog-menu.goog-menu-vertical', { visible: true, timeout: 5000 });

    const clickedMenuItem = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".goog-menuitem, .goog-menuitem-content"));
      const wants = [
        'disconnect and delete runtime',
        'factory reset runtime',
        'restart runtime',
        'desconectar y eliminar el entorno',
        'restablecer el entorno',
        'reiniciar el entorno de ejecución'
      ];
      const pick = items.find(el =>
        wants.some(w => (el.textContent || '').toLowerCase().includes(w))
      );
      if (!pick) return false;
      const target = pick.closest('.goog-menuitem') || pick;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
      target.click();
      return true;
    });
    if (!clickedMenuItem) throw new Error('No se encontró opción de reinicio en dropdown.');
    await confirmYesOkDialogs(page);
    console.log('✅ Reinicio desde dropdown.');
  } catch (e) {
    console.error('❌ Error detallado al reiniciar el entorno:', e);
    throw e;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Espera a que la celda termine y muestre el tick ✓ (md-icon "check"/"done").
   Si aparece un icono de error, lanza error. Recorre shadow DOM.
   ────────────────────────────────────────────────────────────────────────── */
async function waitForCellToFinish(page, idx = 0, { timeoutMs = 300000, pollMs = 250 } = {}) {
  console.log(`🕒 Esperando tick ✓ en la celda #${idx}…`);

  const handle = await page.waitForFunction(
    (i) => {
      const cells = document.querySelectorAll('.cell.code');
      const cell  = cells[i];
      if (!cell) return false;

      // Recorrido profundo (incluye shadow roots)
      const collectDeep = (root, acc = []) => {
        acc.push(root);
        const q = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of q) {
          acc.push(el);
          if (el.shadowRoot) collectDeep(el.shadowRoot, acc);
        }
        return acc;
      };

      // 1) Si la celda sigue "corriendo", no resolvemos todavía
      let running = false;
      const rb = cell.querySelector('colab-run-button');
      if (rb) {
        const r = rb.shadowRoot || rb;
        const stopBtn =
          r.querySelector('paper-icon-button[icon*="stop"], mwc-icon-button[icon*="stop"], ' +
                          'button[aria-label*="Interrupt"], button[title*="Interrupt"], ' +
                          'button[aria-label*="Detener"],  button[title*="Detener"]');
        if (stopBtn) running = true;
      }
      if (cell.querySelector('colab-busy, colab-progress, colab-progress-bar, .cell-execution-indicator, .loading, .spinner')) {
        running = true;
      }
      if (running) return false;

      // 2) Buscar explícitamente el tick ✓ dentro de la celda
      const nodes = collectDeep(cell, []);
      const getText = (el) => (el.textContent || '').trim().toLowerCase();
      const getIcon = (el) => (el.getAttribute?.('icon') || el.getAttribute?.('aria-label') || '').toLowerCase();

      const isIconEl = (el) =>
        el.tagName === 'MD-ICON' ||
        el.matches?.('.material-icons, md-icon, iron-icon, svg, [role="img"]');

      const hasCheck = nodes.some(el =>
        isIconEl(el) && ( /check|done/.test(getText(el)) || /check|done/.test(getIcon(el)) )
      );

      // 3) Heurística de error
      const hasError = nodes.some(el =>
        isIconEl(el) && ( /error|close|cancel|clear|warning|bug|fail|failed/.test(getText(el)) ||
                          /error|close|cancel|clear|warning/.test(getIcon(el)) )
      ) || cell.querySelector('.error, .colab-error, .output-error, [role="alert"]');

      return (hasCheck || hasError) ? { ok: !!hasCheck, err: !!hasError } : false;
    },
    idx,
    { timeout: timeoutMs, polling: pollMs }
  );

  const { ok, err } = await handle.jsonValue();
  if (err && !ok) throw new Error(`La celda #${idx} terminó con icono de error.`);
  await new Promise(r => setTimeout(r, 400));
  console.log(`✅ Celda #${idx} finalizada con ✓ tick.`);
}

/* ──────────────────────────────────────────────────────────────────────────
   Dump de DOM profundo (incluye shadow roots) para una celda concreta
   ────────────────────────────────────────────────────────────────────────── */
async function dumpCellDOM(page, idx = 0, { maxChars = 200000 } = {}) {
  try {
    const data = await page.evaluate((i, maxLen) => {
      const cell = document.querySelectorAll('.cell.code')[i];
      if (!cell) return { html: '[celda no encontrada]', icons: [] };

      const ser = (node, depth = 0) => {
        const pad = '  '.repeat(depth);
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
          return t ? `${pad}"${t}"\n` : '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        let out = `${pad}<${node.tagName.toLowerCase()}`;
        if (node.attributes && node.attributes.length) {
          for (const a of Array.from(node.attributes)) {
            out += ` ${a.name}=${JSON.stringify(a.value)}`;
          }
        }
        out += '>';
        if (node.tagName === 'MD-ICON') {
          const txt = (node.textContent || '').trim();
          if (txt) out += txt;
        }
        out += '\n';

        if (node.shadowRoot) {
          out += `${pad}  <#shadow-root>\n`;
          for (const c of Array.from(node.shadowRoot.childNodes)) {
            out += ser(c, depth + 2);
          }
          out += `${pad}  </#shadow-root>\n`;
        }

        for (const c of Array.from(node.childNodes)) {
          out += ser(c, depth + 1);
        }
        out += `${pad}</${node.tagName.toLowerCase()}>\n`;
        return out;
      };

      let html = ser(cell, 0);
      if (html.length > maxLen) html = html.slice(0, maxLen) + '\n...[truncated]...';

      const icons = Array.from(cell.querySelectorAll('md-icon,.material-icons,iron-icon,[role="img"]')).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim(),
        icon: el.getAttribute?.('icon') || '',
        aria: el.getAttribute?.('aria-label') || '',
      }));

      return { html, icons };
    }, idx, maxChars);

    console.log(`\n===================== DOM celda #${idx} (deep) =====================\n${data.html}\n====================================================================`);
    if (data.icons?.length) {
      console.log(`🔎 md-icon/material icons detectados en celda #${idx}:`);
      for (const ic of data.icons) {
        console.log(`  • <${ic.tag}> text="${ic.text}" icon="${ic.icon}" aria="${ic.aria}"`);
      }
    } else {
      console.log('🔎 No se detectaron md-icon/material icons en la celda.');
    }
  } catch (e) {
    console.warn('⚠️ No se pudo volcar el DOM de la celda:', e.message);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Helpers para celdas: asegurar índice y ejecutar por Run Button
   ────────────────────────────────────────────────────────────────────────── */
async function ensureRunButtonIndex(page, idx, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const count = await page.evaluate(() => document.querySelectorAll('colab-run-button').length);
    if (count > idx) return true;
    // Forzar lazy-load de celdas desplazando hacia abajo
    await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.9)));
    await sleep(300);
  }
  return false;
}

async function runCellByIndex(page, idx, waitTick = false) {
  const ok = await ensureRunButtonIndex(page, idx);
  if (!ok) throw new Error(`No se encontró el Run Button de la celda #${idx}.`);

  const runBtn = page.locator('colab-run-button').nth(idx);
  await runBtn.scrollIntoViewIfNeeded().catch(()=>{});
  await runBtn.waitFor({ state: 'visible', timeout: 60000 });
  await runBtn.click();
  if (waitTick) {
    await waitForCellToFinish(page, idx);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Esperar enlace de Cloudflare O "True" en la salida de la celda dada
   (busca dentro del DOM de ESA celda, incluyendo shadow DOM)
   ────────────────────────────────────────────────────────────────────────── */
async function waitForCloudflareLinkOrTrueInCell(page, idx = 2, { timeoutMs = 300000, pollMs = 300 } = {}) {
  console.log(`👂 Esperando enlace trycloudflare.com o la cadena "True" en la celda #${idx}…`);
  const handle = await page.waitForFunction(
    (i) => {
      const cell = document.querySelectorAll('.cell.code')[i];
      if (!cell) return false;

      const collectDeep = (root, acc = []) => {
        acc.push(root);
        const q = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of q) {
          acc.push(el);
          if (el.shadowRoot) collectDeep(el.shadowRoot, acc);
        }
        return acc;
      };

      const nodes = collectDeep(cell, []);
      // 1) ¿Hay enlace trycloudflare?
      const a = nodes.find(el => el.tagName === 'A' && /trycloudflare\.com/i.test(el.getAttribute?.('href') || ''));
      if (a) return { kind: 'link', value: a.href };

      // 2) ¿Existe la cadena "True" en la salida de esa celda?
      //    P.ej. un print(True) o un valor booleano renderizado
      const hasTrue = nodes.some(el => {
        if (!el.matches?.('colab-static-output-renderer, pre, code, span, div')) return false;
        const t = (el.textContent || '').trim();
        // Coincidencia estricta o token suelto
        return t === 'True' || /\bTrue\b/.test(t);
      });
      if (hasTrue) return { kind: 'true', value: true };

      return false;
    },
    idx,
    { timeout: timeoutMs, polling: pollMs }
  );

  return handle.jsonValue(); // { kind: 'link'|'true', value: string|true }
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

  // 2) Abrir notebook en **otra pestaña** manteniendo Drive (misma ventana)
  // 🔴 CAMBIO: NO navegamos la pestaña de Drive; creamos una nueva y vamos a Colab.
  console.log(`🌍 Navegando al notebook (pestaña nueva): ${COLAB_NOTEBOOK_URL}`);

const [colabPage] = await Promise.all([
  context.waitForEvent('page', { timeout: 30000 }), // capturamos la nueva pestaña
  page.evaluate((url) => window.open(url, '_blank'), COLAB_NOTEBOOK_URL) // abrir desde Drive
]);

// Traemos Colab al frente y esperamos al editor
await colabPage.bringToFront();
try {
  await colabPage.waitForLoadState('domcontentloaded', { timeout: 240000 });
} catch (e) {
  console.warn('⚠️ Colab no reportó domcontentloaded a tiempo, continuamos:', e.message);
}
await colabPage.locator('.cell.code').first().waitFor({ state: 'visible', timeout: 120000 });
console.log('✅ Editor de Colab visible (Drive sigue abierto en la primera pestaña).');

// A partir de aquí trabajamos sobre la pestaña de Colab
page = colabPage;

  // 3) Popups “Run anyway” / bienvenida y (opcional) limpiar salidas
  try {
    const runAnyway = page.locator('colab-dialog button:has-text("Run anyway")').first();
    if (await runAnyway.count()) { await runAnyway.click(); await sleep(600); }
  } catch {}
  try {
    const welcomeClose = page.locator('colab-dialog[class*="welcome-dialog"] #close-icon').first();
    if (await welcomeClose.count()) { await welcomeClose.click(); await sleep(300); }
  } catch {}
  try {
    const editBtn = page.locator('#edit-menu-button, [aria-label="Edit"], text=Edit').first();
    await editBtn.click();
    const clearItem = page.locator(
      '.goog-menuitem:has-text("Clear all outputs"), [role="menuitem"]:has-text("Clear all outputs")'
    ).first();
    await clearItem.waitFor({ state: 'visible', timeout: 2500 });
    await clearItem.click();
    await page.locator('#edit-menu, [role="menu"]:has-text("Clear")').first()
      .waitFor({ state: 'hidden', timeout: 2500 }).catch(()=>{});
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

  await restartRuntimeFlexible(page);

  // Re-ejecuta celda 0 para reactivar tras el reinicio
  try {
    const editor0 = await page.locator('.cell.code').nth(0).locator('.monaco-editor').first();
    await editor0.click();
    await page.keyboard.down(mod); await page.keyboard.press('Enter'); await page.keyboard.up(mod);
    console.log('✅ Celda 0 re-ejecutada tras el reinicio.');
    await waitForCellToFinish(page, 0).catch(async e => {
      console.warn('⚠️ No se pudo confirmar fin de la celda 0:', e.message);
      await dumpCellDOM(page, 0).catch(()=>{});
    });
  } catch (e) {
    console.warn('⚠️ No se pudo relanzar la celda 0:', e.message);
    await dumpCellDOM(page, 0).catch(()=>{});
  }

  // 5) Celda 1 (montaje Drive) con gestión de 1..N consents
  console.log('2️⃣ Ejecutando Celda 2 (montaje Drive)…');
  const editor1 = await page.locator('.cell.code').nth(1).locator('.monaco-editor').first();
  await editor1.click();

  await page.keyboard.down(mod); await page.keyboard.press('Enter'); await page.keyboard.up(mod);
  console.log('⏳ Celda 2 lanzada. Esperando ~5s…'); 
  await sleep(5000);

  const focused = await waitAndFocusConnectButton(page, 30000);
  if (!focused) console.warn('⚠️ No se pudo enfocar el botón; ENTER igualmente.');
  await page.keyboard.press('Enter');
  console.log('↩️ ENTER enviado al diálogo de Colab.');

  // Atiende cualquier número de popups OAuth y continúa cuando se cierren
  await waitForOAuthCascade(context, page, handleOAuthPopupByEmailOrForm, {
    windowMs: 60000,
    idleMs:   1200,
    detectTimeout: 12000
  });

  await page.bringToFront();
  console.log('🕰️ Margen para montar /content/drive…');
  await sleep(8000);

  // 6) Celda 3: ejecutar por Run Button (robusto, sin depender de .monaco-editor)
  console.log('3️⃣ Ejecutando Celda 3…');
  await runCellByIndex(page, 2, false);

  // ⬇️ Nuevo en tu flujo: esperar enlace trycloudflare O "True"
  const outcome = await waitForCloudflareLinkOrTrueInCell(page, 2, { timeoutMs: 300000 });
  if (outcome?.kind === 'link') {
    console.log('✅ URL:', outcome.value);
    return { result: outcome.value, page, browser };
  } else if (outcome?.kind === 'true') {
    console.log('✅ Sin enlace de Cloudflare. Señal "True" detectada.');
    return { result: true, page, browser };
  } else {
    throw new Error('No se obtuvo enlace de Cloudflare ni señal "True" en la celda 3.');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  drive_auto()
    .then(({ result /*, page, browser*/ }) => {
      console.log('\n📊 RESULTADO FINAL:\n', result);
      // No cerramos el navegador a propósito para que puedas seguir trabajando
    })
    .catch(err => {
      console.error('🔥 Error:', err?.stack || err?.message);
      process.exit(1);
    });
}

module.exports = { drive_auto };
