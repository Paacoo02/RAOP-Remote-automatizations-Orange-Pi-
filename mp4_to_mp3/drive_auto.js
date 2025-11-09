// drive_auto.js — Abre Colab, monta Drive, espera link/True y descarga/borra un archivo desde la carpeta
'use strict';

const os = require('os');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const {
  attemptGoogleLogin,
  switchToVideosTab,
  downloadAndTrashFile,
  FIXED_FOLDER_URL
} = require('./auto_log_in.js');

const COLAB_NOTEBOOK_URL =
  process.env.COLAB_NOTEBOOK_URL ||
  'https://colab.research.google.com/drive/1WjbE6Cez95NnBn4AhLgisCHG2FJuDrmk?usp=sharing&hl=en';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EMAIL = process.env.GOOGLE_USER || 'pacoplanestomas@gmail.com';
const PASS  = process.env.GOOGLE_PASS  || '392002Planes0.';

function isOAuthLikeUrl(u = '') {
  return /accounts\.google\.com|ServiceLogin|signin|oauth|consent|gsi|challenge\/pwd/i.test(u);
}

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

      for (const n of nodes) {
        if (n.getAttribute?.('slot') === 'primaryAction' && RX.test(txt(n))) {
          const t = n.shadowRoot?.querySelector('button') || n.querySelector?.('button') || n;
          t?.focus?.();
          return !!t && (document.activeElement === t || t.contains(document.activeElement));
        }
      }
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

async function waitForOAuthCascade(context, hostPage, handlePopupFn, {
  windowMs = 60000, idleMs = 1200
} = {}) {
  const handled = new Set();
  const deadline = Date.now() + windowMs;
  let lastActivity = Date.now();

  const onPage = (p) => {};
  context.on('page', onPage);
  try {
    while (Date.now() < deadline) {
      const candidates = (await context.pages()).filter(p => p && !p.isClosed() && p !== hostPage && !handled.has(p));
      let popup = null;
      for (const p of candidates) {
        try { await p.waitForLoadState?.('domcontentloaded', { timeout: 12000 }).catch(()=>{}); } catch {}
        const url = p.url?.() || '';
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
        new Promise(res => popup.once?.('close', res)),
        popup.waitForURL?.(u => /colab\.research\.google\.com/i.test(u), { timeout: 15000 }).catch(()=>{})
      ]);
      lastActivity = Date.now();
    }
  } finally { context.off?.('page', onPage); }
}

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

async function openRuntimeMenu(page) {
  const buttons = ['#runtime-menu-button','[aria-label="Runtime"]','[aria-label="Entorno de ejecución"]','text=Runtime','text=Entorno de ejecución'];
  for (const sel of buttons) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 6000 });
      await loc.click({ delay: 20 });
      const menu = page.locator('.goog-menu.goog-menu-vertical,[role="menu"]').first();
      await menu.waitFor({ state: 'visible', timeout: 6000 });
      return true;
    } catch {}
  }
  return false;
}

async function clickRuntimeRestartLike(page) {
  const candidates = [
    '.goog-menuitem:has-text("Restart runtime")','.goog-menuitem:has-text("Factory reset runtime")','.goog-menuitem:has-text("Disconnect and delete runtime")',
    '[role="menuitem"]:has-text("Restart runtime")','[role="menuitem"]:has-text("Factory reset runtime")','[role="menuitem"]:has-text("Disconnect and delete runtime")',
    '.goog-menuitem:has-text("Reiniciar el entorno de ejecución")','.goog-menuitem:has-text("Restablecer el entorno")','.goog-menuitem:has-text("Desconectar y eliminar el entorno")',
    '[role="menuitem"]:has-text("Reiniciar el entorno de ejecución")','[role="menuitem"]:has-text("Restablecer el entorno")','[role="menuitem"]:has-text("Desconectar y eliminar el entorno")'
  ];
  const item = page.locator(candidates.join(', ')).first();
  await item.waitFor({ state: 'visible', timeout: 8000 });
  await item.click();
}

async function confirmYesOkDialogs(page) {
  const tryClick = async () => {
    return await page.evaluate(() => {
      const sels = [
        'mwc-dialog[open] [dialogaction="ok"]','colab-dialog[open] [dialogaction="ok"]',
        'mwc-dialog[open] button:enabled','colab-dialog[open] button:enabled',
        'paper-dialog[opened] .ok','dialog[open] button:not([disabled]):not([aria-disabled="true"])'
      ];
      for (const s of sels) { const n = document.querySelector(s); if (n) { n.click(); return true; } }
      return false;
    });
  };
  await sleep(300);
  let ok = await tryClick();
  if (!ok) {
    const labels = ['Yes','OK','Restart','Continue','Aceptar','Reiniciar','Sí'];
    for (const t of labels) {
      try { const b = page.locator(`button:has-text("${t}")`).first(); if (await b.count()) { await b.click(); ok = true; break; } } catch {}
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
  if (await openRuntimeMenu(page)) {
    try { await clickRuntimeRestartLike(page); await confirmYesOkDialogs(page); console.log('✅ Reinicio desde menú Runtime.'); return; }
    catch (e) { console.warn('⚠️ Falló reinicio desde Runtime menu:', e.message); }
  }
  try {
    const dropdownSelector = '[aria-label*="Additional connection options"]';
    await page.waitForSelector(dropdownSelector, { timeout: 12000 });
    await page.click(dropdownSelector);
    await page.waitForSelector('.goog-menu.goog-menu-vertical', { visible: true, timeout: 5000 });
    const clicked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".goog-menuitem, .goog-menuitem-content"));
      const wants = ['disconnect and delete runtime','factory reset runtime','restart runtime','desconectar y eliminar el entorno','restablecer el entorno','reiniciar el entorno de ejecución'];
      const pick = items.find(el => wants.some(w => (el.textContent || '').toLowerCase().includes(w)));
      if (!pick) return false;
      const target = pick.closest('.goog-menuitem') || pick;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
      target.click();
      return true;
    });
    if (!clicked) throw new Error('No se encontró opción de reinicio.');
    await confirmYesOkDialogs(page);
    console.log('✅ Reinicio desde dropdown.');
  } catch (e) { console.error('❌ Error detallado al reiniciar:', e); throw e; }
}

async function waitForCellToFinish(page, idx = 0, { timeoutMs = 300000, pollMs = 250 } = {}) {
  console.log(`🕒 Esperando tick ✓ en la celda #${idx}…`);
  const handle = await page.waitForFunction(
    (i) => {
      const cells = document.querySelectorAll('.cell.code');
      const cell  = cells[i];
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
      if (cell.querySelector('colab-busy, colab-progress, colab-progress-bar, .cell-execution-indicator, .loading, .spinner')) running = true;
      if (running) return false;

      const nodes = collectDeep(cell, []);
      const getText = (el) => (el.textContent || '').trim().toLowerCase();
      const getIcon = (el) => (el.getAttribute?.('icon') || el.getAttribute?.('aria-label') || '').toLowerCase();
      const isIconEl = (el) => el.tagName === 'MD-ICON' || el.matches?.('.material-icons, md-icon, iron-icon, svg, [role="img"]');

      const hasCheck = nodes.some(el => isIconEl(el) && ( /check|done/.test(getText(el)) || /check|done/.test(getIcon(el)) ));
      const hasError = nodes.some(el => isIconEl(el) && ( /error|close|cancel|clear|warning|bug|fail|failed/.test(getText(el)) ||
                                                         /error|close|cancel|clear|warning/.test(getIcon(el)) )) ||
                       cell.querySelector('.error, .colab-error, .output-error, [role="alert"]');
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

async function ensureRunButtonIndex(page, idx, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const count = await page.evaluate(() => document.querySelectorAll('colab-run-button').length);
    if (count > idx) return true;
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
  if (waitTick) await waitForCellToFinish(page, idx);
}

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
      const a = nodes.find(el => el.tagName === 'A' && /trycloudflare\.com/i.test(el.getAttribute?.('href') || ''));
      if (a) return { kind: 'link', value: a.href };
      const hasTrue = nodes.some(el => {
        if (!el.matches?.('colab-static-output-renderer, pre, code, span, div')) return false;
        const t = (el.textContent || '').trim();
        return t === 'True' || /\bTrue\b/.test(t);
      });
      if (hasTrue) return { kind: 'true', value: true };
      return false;
    },
    idx,
    { timeout: timeoutMs, polling: pollMs }
  );
  return handle.jsonValue();
}

/* ---------- Flujo principal ---------- */
async function drive_auto({ context: injectedContext, drivePage: injectedDrivePage } = {}) {
  console.log('🚀 Iniciando el flujo en Google Colab…');

  let context, drivePage;
  if (injectedContext && injectedDrivePage) {
    context   = injectedContext;
    drivePage = injectedDrivePage;
    console.log('🔗 Reutilizando contexto/pestaña existentes.');
  } else {
    const login = await attemptGoogleLogin();
    context   = login.context;
    drivePage = login.page;
  }

  // Asegura carpeta fija sin cerrar ni abrir de nuevo
  try {
    await drivePage.goto(FIXED_FOLDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('📁 Drive posicionado en carpeta fija.');
  } catch (e) { console.warn('⚠️ No se pudo posicionar en la carpeta fija:', e.message); }

  // Abrir Colab en pestaña nueva dentro del MISMO context
  console.log(`🌍 Abriendo notebook (pestaña nueva): ${COLAB_NOTEBOOK_URL}`);
  const opener = (url) => {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  };

  const [colabPage] = await Promise.all([
    context.waitForEvent('page', {
      timeout: 30000,
      predicate: p => {
        try { const u = typeof p.url === 'function' ? p.url() : (p.url || ''); return u.includes('colab.research.google.com'); }
        catch { return false; }
      }
    }),
    drivePage.evaluate(opener, COLAB_NOTEBOOK_URL),
  ]);

  await colabPage.bringToFront();
  try { await colabPage.waitForLoadState?.('domcontentloaded', { timeout: 240000 }); } catch {}
  try { await colabPage.waitForSelector?.('.cell.code', { timeout: 120000 }); } catch {}
  console.log('✅ Editor de Colab visible.');

  // Limpieza de diálogos
  try { const runAnyway = colabPage.locator?.('colab-dialog button:has-text("Run anyway")')?.first?.(); if (runAnyway && await runAnyway.count?.()) { await runAnyway.click?.(); await sleep(600); } } catch {}
  try { const welcomeClose = colabPage.locator?.('colab-dialog[class*="welcome-dialog"] #close-icon')?.first?.(); if (welcomeClose && await welcomeClose.count?.()) { await welcomeClose.click?.(); await sleep(300); } } catch {}

  // Celda 0 + reinicio runtime
  console.log('1️⃣ Ejecutando primera celda…');
  try {
    const runBtn0 = colabPage.locator?.('colab-run-button')?.first?.();
    await runBtn0?.waitFor?.({ state: 'visible', timeout: 20000 });
    await runBtn0?.click?.();
    await sleep(1200);
  } catch {}
  await restartRuntimeFlexible(colabPage);

  // Re-ejecutar celda 0
  try {
    const editor0 = colabPage.locator?.('.cell.code')?.nth?.(0)?.locator?.('.monaco-editor')?.first?.();
    await editor0?.click?.();
    await colabPage.keyboard?.down(mod); await colabPage.keyboard?.press('Enter'); await colabPage.keyboard?.up(mod);
    console.log('✅ Celda 0 re-ejecutada.');
    await waitForCellToFinish(colabPage, 0).catch(()=>{});
  } catch (e) { console.warn('⚠️ No se pudo relanzar celda 0:', e.message); }

  // Celda 2: montar Drive + consents
  console.log('2️⃣ Ejecutando Celda 2 (montaje Drive)…');
  try {
    const editor1 = colabPage.locator?.('.cell.code')?.nth?.(1)?.locator?.('.monaco-editor')?.first?.();
    await editor1?.click?.();
    await colabPage.keyboard?.down(mod); await colabPage.keyboard?.press('Enter'); await colabPage.keyboard?.up(mod);
  } catch {}
  console.log('⏳ Espera breve…'); 
  await sleep(5000);

  const focused = await waitAndFocusConnectButton(colabPage, 30000);
  if (!focused) console.warn('⚠️ No se pudo enfocar el botón; ENTER igualmente.');
  await colabPage.keyboard?.press('Enter');
  console.log('↩️ ENTER enviado al diálogo.');

  await waitForOAuthCascade(context, colabPage, handleOAuthPopupByEmailOrForm, { windowMs: 60000, idleMs: 1200 });  await colabPage.bringToFront();
  console.log('🕰️ Esperando montaje /content/drive…');
  await sleep(8000);

  // Celda 3
  console.log('3️⃣ Ejecutando Celda 3…');
  await runCellByIndex(colabPage, 2, false);
  const outcome = await waitForCloudflareLinkOrTrueInCell(colabPage, 2, { timeoutMs: 300000 });

  // Volver a pestaña "Videos", descargar y eliminar video.mp3
  const videosTab = await switchToVideosTab(context);
  const dlInfo = await downloadAndTrashFile(videosTab, 'video.mp3', { destDir: os.tmpdir?.() || '/tmp' });

   if (outcome?.kind === 'link') {
    return { result: outcome.value, page: colabPage, context };
  } else if (outcome?.kind === 'true') {
    return { result: true, page: colabPage, context };
  }
  throw new Error('No se obtuvo enlace de Cloudflare ni "True" en la celda 3.');
}

if (require.main === module) {
  drive_auto()
    .then(({ result }) => { console.log('\n📊 RESULTADO FINAL:\n', result); })
    .catch(err => { console.error('🔥 Error:', err?.stack || err?.message); process.exit(1); });
}

module.exports = { drive_auto };
