// drive_auto.js — Abre Colab, monta Drive, espera JSON (Celda 2) y link/True (Celda 3)
'use strict';

const os = require('os'); // ← asegura que 'os' está en scope (evita ReferenceError)
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const {
  attemptGoogleLogin,
  switchToVideosTab,
  downloadAndTrashFileViaMenu,
  FIXED_FOLDER_URL,
  waitForDriveReady // <-- IMPORTANTE: Asegúrate de que esto se importa
} = require('./auto_log_in.js');

const COLAB_NOTEBOOK_URL =
  process.env.COLAB_NOTEBOOK_URL ||
  'https://colab.research.google.com/drive/1WjbE6Cez95NnBn4AhLgisCHG2FJuDrmk?usp=sharing&hl=en';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EMAIL = process.env.GOOGLE_USER || 'pacoplanestomas@gmail.com';
const PASS  = process.env.GOOGLE_PASS  || '392002Planes0.';

/* ---------------- Utils existentes ---------------- */
// (Las funciones isOAuthLikeUrl, clickByTextAcrossFrames, ensureVisibleAndFocused,
// stepThroughConsent, waitAndFocusConnectButton, waitForOAuthCascade, 
// handleOAuthPopupByEmailOrForm, openRuntimeMenu, clickRuntimeRestartLike, 
// confirmYesOkDialogs, restartRuntimeFlexible, y waitForCellToFinish
// permanecen EXACTAMENTE IGUALES)

function isOAuthLikeUrl(u = '') {
  return /accounts\.google\.com|ServiceLogin|signin|oauth|consent|gsi|challenge\/pwd/i.test(u);
}
async function clickByTextAcrossFrames(page, texts = [], { timeout = 8000 } = {}) {
  const pagesOrFrames = [page, ...(page.frames?.() || [])];
  const quoted = (t) => t.replace(/"/g, '\\"');
  const selectors = (txt) => [
    `button:has-text("${quoted(txt)}")`,
    `div[role="button"]:has-text("${quoted(txt)}")`,
    `span[role="button"]:has-text("${quoted(txt)}")`,
    `[jsname="LgbsSe"]:has-text("${quoted(txt)}")`,
  ];
  for (const ctx of pagesOrFrames) {
    for (const t of texts) {
      const loc = ctx.locator?.(selectors(t).join(', '))?.first?.();
      if (loc && await loc.count?.()) {
        try { await loc.scrollIntoViewIfNeeded?.(); } catch {}
        try { await loc.waitFor?.({ state: 'visible', timeout }); } catch {}
        try { await loc.click?.({ delay: 20 }); return true; } catch {}
      }
    }
  }
  return false;
}
async function ensureVisibleAndFocused(p) {
  try { await p.bringToFront?.(); } catch {}
  try { await p.setViewportSize?.({ width: 1200, height: 900 }); } catch {}
  try { await p.evaluate?.(() => window.focus?.()); } catch {}
}
async function stepThroughConsent(p, { rounds = 6 } = {}) {
  const ALLOW_TXT = ['Allow','Permitir'];
  const CONT_TXT  = ['Continue','Continuar'];
  const ADV_TXT   = ['Advanced','Avanzadas','Avanzado','Avanzada'];
  const UNSAFE_TXT= ['Go to','Ir a'];
  for (let i = 0; i < rounds; i++) {
    await ensureVisibleAndFocused(p);
    let clicked = await clickByTextAcrossFrames(p, ADV_TXT, { timeout: 2000 });
    if (clicked) {
      console.log('⚠️ Pulsado "Advanced/Avanzadas".');
      await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
      await p.waitForLoadState?.('networkidle', { timeout: 15000 }).catch(()=>{});
      await clickByTextAcrossFrames(p, UNSAFE_TXT, { timeout: 3000 }).catch(()=>{});
      await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
      await p.waitForLoadState?.('networkidle', { timeout: 15000 }).catch(()=>{});
    }
    clicked = await clickByTextAcrossFrames(p, ALLOW_TXT, { timeout: 3000 });
    if (clicked) {
      console.log(`➡️ Consent (Allow/Permitir) #${i + 1}`);
      await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
      await p.waitForLoadState?.('networkidle', { timeout: 15000 }).catch(()=>{});
    }
    let contClicked = await clickByTextAcrossFrames(p, CONT_TXT, { timeout: 2500 });
    if (contClicked) {
      console.log(`➡️ Consent (Continue/Continuar) #${i + 1}`);
      await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
      await p.waitForLoadState?.('networkidle', { timeout: 15000 }).catch(()=>{});
    }
    if (!clicked && !contClicked) {
      try {
        await p.evaluate?.(() => { window.scrollBy(0, Math.max(400, window.innerHeight * 0.9)); });
      } catch {}
      clicked = await clickByTextAcrossFrames(p, [...ALLOW_TXT, ...CONT_TXT], { timeout: 2000 });
      if (clicked) {
        console.log(`➡️ Consent tras scroll #${i + 1}`);
        await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
        await p.waitForLoadState?.('networkidle', { timeout: 15000 }).catch(()=>{});
      }
    }
    if (p.isClosed?.()) return true;
    const url = typeof p.url === 'function' ? p.url() : (p.url || '');
    if (!isOAuthLikeUrl(url)) return true;
    await p.waitForTimeout?.(700);
  }
  return false;
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
  windowMs = 120000, idleMs = 2000
} = {}) {
  const deadline = Date.now() + windowMs;
  let lastActivity = Date.now();
  const isAliveOAuth = (p) => {
    if (!p || p.isClosed?.()) return false;
    try {
      const u = typeof p.url === 'function' ? p.url() : (p.url || '');
      return isOAuthLikeUrl(u);
    } catch { return false; }
  };
  while (Date.now() < deadline) {
    const pages = (await context.pages?.()) || [];
    const oauthPopups = pages.filter(p => p && p !== hostPage && isAliveOAuth(p));
    if (!oauthPopups.length) {
      if (Date.now() - lastActivity >= idleMs) break;
      await sleep(200);
      continue;
    }
    for (const popup of oauthPopups) {
      try {
        await ensureVisibleAndFocused(popup);
        await handlePopupFn(popup);
        const finished = await Promise.race([
          new Promise(res => popup.once?.('close', () => res(true))),
          (async () => {
            let done = false;
            for (let i = 0; i < 10; i++) {
              await popup.waitForTimeout?.(500);
              if (!isAliveOAuth(popup)) { done = true; break; }
            }
            return done;
          })()
        ]);
        lastActivity = Date.now();
        if (!finished && isAliveOAuth(popup)) {
          await popup.waitForTimeout?.(500);
          await handlePopupFn(popup);
        }
      } catch (e) {}
    }
  }
}
async function handleOAuthPopupByEmailOrForm(p) {
  try { await ensureVisibleAndFocused(p); } catch {}
  try {
    let candidate = p.locator?.(`[data-email="${EMAIL}"]`)?.first?.();
    if (!(await candidate?.count?.())) {
      candidate = p.locator?.(`div[role="button"]:has-text("${EMAIL}")`)?.first?.();
    }
    if (candidate && await candidate.count?.()) {
      await candidate.scrollIntoViewIfNeeded?.().catch(()=>{});
      await candidate.click?.();
      console.log(`🟢 Cuenta seleccionada por email: ${EMAIL}`);
      await p.waitForLoadState?.('domcontentloaded', { timeout: 12000 }).catch(()=>{});
    }
  } catch {}
  try {
    const emailBox = p.locator?.('#identifierId:visible, input[name="identifier"]:visible, input[type="email"]:visible')?.first?.();
    if (emailBox && await emailBox.count?.()) {
      await emailBox.click?.().catch(()=>{});
      await emailBox.fill?.('').catch(()=>{});
      await emailBox.type?.(EMAIL, { delay: 25 }).catch(()=>{});
      const nextId = p.locator?.('#identifierNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible')?.first?.();
      if (nextId && await nextId.count?.()) await nextId.click?.();
      else await p.keyboard?.press('Enter').catch(()=>{});
      await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    }
    await Promise.race([
      p.locator?.('input[type="password"]:visible, input[name="Passwd"]:visible')?.first?.().waitFor?.({ timeout: 20000 }),
      p.waitForURL?.(/challenge\/pwd|signin\/v2\/sl\/pwd/i, { timeout: 20000 }).catch(()=>{})
    ]).catch(()=>{});
    const passBox = p.locator?.('input[type="password"]:visible, input[name="Passwd"]:visible')?.first?.();
    if (passBox && await passBox.count?.()) {
      await passBox.click?.().catch(()=>{});
      await passBox.fill?.('').catch(()=>{});
      await passBox.type?.(PASS, { delay: 25 }).catch(()=>{});
      const nextPwd = p.locator?.('#passwordNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible')?.first?.();
      if (nextPwd && await nextPwd.count?.()) await nextPwd.click?.();
      else await p.keyboard?.press('Enter').catch(()=>{});
      console.log('🟢 Password enviado (popup).');
      await p.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(()=>{});
    }
  } catch {}
  try { await stepThroughConsent(p, { rounds: 8 }); } catch {}
}
async function openRuntimeMenu(page) {
  const buttons = ['#runtime-menu-button','[aria-label="Runtime"]','[aria-label="Entorno de ejecución"]','text=Runtime','text=Entorno de ejecución'];
  for (const sel of buttons) {
    const loc = page.locator?.(sel)?.first?.();
    try {
      await loc?.waitFor?.({ state: 'visible', timeout: 6000 });
      await loc?.click?.({ delay: 20 });
      const menu = page.locator?.('.goog-menu.goog-menu-vertical,[role="menu"]')?.first?.();
      await menu?.waitFor?.({ state: 'visible', timeout: 6000 });
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
  const item = page.locator?.(candidates.join(', '))?.first?.();
  await item?.waitFor?.({ state: 'visible', timeout: 8000 });
  await item?.click?.();
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
  await sleep(100);
  let ok = await tryClick();
  if (!ok) {
    const labels = ['Yes','OK','Restart','Continue','Aceptar','Reiniciar','Sí'];
    for (const t of labels) {
      try { const b = page.locator?.(`button:has-text("${t}")`)?.first?.(); if (await b?.count?.()) { await b?.click?.(); ok = true; break; } } catch {}
    }
  }
  if (!ok) { await page.keyboard?.press('Enter').catch(()=>{}); }
  try {
    await page.waitForFunction?.(() =>
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
    await page.waitForSelector?.(dropdownSelector, { timeout: 12000 });
    await page.click?.(dropdownSelector);
    await page.waitForSelector?.('.goog-menu.goog-menu-vertical', { visible: true, timeout: 5000 });
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
  const handle = await page.waitForFunction?.(
    (i) => {
      const cells = document.querySelectorAll('.cell.code');
      const cell  = cells[i];
      if (!cell) return false;
      const collectDeep = (root, acc) => {
        acc.push(root);
        const q = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of q) {
          acc.push(el);
          if (el.shadowRoot) collectDeep(el.shadowRoot, acc);
        }
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
      const nodes = [];
      collectDeep(cell, nodes);
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
  const { ok, err } = (await handle?.jsonValue?.()) || {};
  if (err && !ok) throw new Error(`La celda #${idx} terminó con icono de error.`);
  await new Promise(r => setTimeout(r, 150));
  console.log(`✅ Celda #${idx} finalizada con ✓ tick.`);
}

// -----------------------------------------------------------------
//  INICIO: NUEVA LÓGICA DE LECTURA DE JSON
// -----------------------------------------------------------------

/**
 * (REEMPLAZA a waitForMountedDriveInCell)
 * Lee el output de una celda *después* de que haya terminado (waitForCellToFinish).
 * Busca la última línea de texto en el output y trata de parsearla como JSON.
 */
async function readCellJsonOutput(page, idx = 1) {
  console.log(`JSON: Leyendo output de la celda #${idx}...`);
  try {
    const jsonString = await page.evaluate((i) => {
      const cell = document.querySelectorAll('.cell.code')[i];
      if (!cell) return null;

      // Recoger todos los textos de salida
      const outSelectors = [
        'colab-output-renderer', 'colab-static-output-renderer',
        '.output', 'pre', 'code', 'span', 'div'
      ];
      const texts = [];
      for (const sel of outSelectors) {
        // Busca en profundidad, incluyendo shadow DOM si es necesario
        (function collectText(node) {
          if (!node) return;
          if (node.shadowRoot) {
            collectText(node.shadowRoot);
          }
          if (node.matches && node.matches(sel)) {
             const t = (node.innerText || node.textContent || '').trim();
             if (t) texts.push(t);
          }
          node.querySelectorAll?.(sel).forEach(n => {
             const t = (n.innerText || n.textContent || '').trim();
             if (t) texts.push(t);
          });
        })(cell);
      }
      
      if (!texts.length) {
        // Fallback: buscar cualquier texto si los selectores fallan
        const allText = (cell.innerText || cell.textContent || '').trim();
        if (allText) texts.push(allText);
      }
      
      if (!texts.length) return null;

      // El JSON es la última línea de texto no vacía del último bloque de output
      const lastOutput = texts[texts.length - 1].trim();
      const lastLine = lastOutput.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();

      // Intenta parsear la última línea
      if (lastLine && lastLine.startsWith('{') && lastLine.endsWith('}')) {
        return lastLine;
      }
      // Fallback: si el JSON es la totalidad del último output
      if (lastOutput.startsWith('{') && lastOutput.endsWith('}')) {
        return lastOutput;
      }
      return null; // No se encontró JSON claro

    }, idx);

    if (jsonString) {
      return JSON.parse(jsonString); // Parsear en Node.js, no en el navegador
    }
    console.warn(`JSON: No se encontró un string JSON claro en la celda #${idx}.`);
    return null;
  } catch (e) {
    console.error(`JSON: Error al parsear output de la celda #${idx}: ${e.message}`);
    return null;
  }
}
// -----------------------------------------------------------------
//  FIN: NUEVA LÓGICA DE LECTURA DE JSON
// -----------------------------------------------------------------


async function ensureRunButtonIndex(page, idx, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const count = await page.evaluate?.(() => document.querySelectorAll('colab-run-button').length);
    if ((count || 0) > idx) return true;
    await page.evaluate?.(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.9)));
    await sleep(300);
  }
  return false;
}

async function runCellByIndex(page, idx, waitTick = false) {
  const ok = await ensureRunButtonIndex(page, idx);
  if (!ok) throw new Error(`No se encontró el Run Button de la celda #${idx}.`);
  const runBtn = page.locator?.('colab-run-button')?.nth?.(idx);
  await runBtn?.scrollIntoViewIfNeeded?.().catch(()=>{});
  await runBtn?.waitFor?.({ state: 'visible', timeout: 60000 });
  await runBtn?.click?.();
  if (waitTick) await waitForCellToFinish(page, idx);
}

/* === ENDURECIMIENTO: “True” estricto en la celda #3 === */
async function waitForCloudflareLinkOrTrueInCell(page, idx = 2, { timeoutMs = 300000, pollMs = 300 } = {}) {
  console.log(`👂 Esperando enlace trycloudflare.com o "True" en celda #${idx}…`);
  const handle = await page.waitForFunction?.(
    (i) => {
      const cell = document.querySelectorAll('.cell.code')[i];
      if (!cell) return false;

      // Busca un link trycloudflare en outputs
      const deep = [];
      (function collect(node){ 
        deep.push(node); 
        const q = node.querySelectorAll ? node.querySelectorAll('*') : []; 
        for (const el of q) { 
          deep.push(el); 
          if (el.shadowRoot) collect(el.shadowRoot); 
        } 
      })(cell);
      const linkNode = deep.find(el => el.tagName === 'A' && /trycloudflare\.com/i.test(el.getAttribute?.('href') || ''));
      if (linkNode) return { kind: 'link', value: linkNode.href };

      // Obtiene el ÚLTIMO texto de salida no vacío y lo compara ESTRICTO con "True"
      const outSelectors = [
        'colab-output-renderer', 'colab-static-output-renderer',
        '.output', 'pre', 'code', 'span', 'div'
      ];
      const texts = [];
      for (const sel of outSelectors) {
        cell.querySelectorAll(sel).forEach(n => {
          const t = (n.innerText || n.textContent || '').trim();
          if (t) texts.push(t);
        });
      }
      if (texts.length) {
        const last = texts[texts.length - 1].trim();
        const lastLine = last.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).pop();
        if (last === 'True' || lastLine === 'True') return { kind: 'true', value: true };
      }
      return false;
    },
    idx,
    { timeout: timeoutMs, polling: pollMs }
  );
  return handle?.jsonValue?.();
}


/* ---------------- Flujo principal ---------------- */

async function drive_auto({ context: injectedContext, drivePage: injectedDrivePage } = {}) {
  console.log('🚀 Iniciando el flujo en Google Colab…');

  let context, drivePage;
  let colabCell2Result = null; // <-- Variable para guardar el JSON de la celda 2

  if (injectedContext && injectedDrivePage) {
    context   = injectedContext;
    drivePage = injectedDrivePage;
    console.log('🔗 Reutilizando contexto/pestaña existentes.');
  } else {
    const login = await attemptGoogleLogin();
    context   = login.context;
    drivePage = login.page;
  }

  // Asegura carpeta fija
  try {
    await drivePage.goto?.(FIXED_FOLDER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('📁 Drive posicionado en carpeta fija.');
  } catch (e) { console.warn('⚠️ No se pudo posicionar en la carpeta fija:', e.message); }

  // Abre Colab en pestaña nueva dentro del MISMO context
  console.log(`🌍 Abriendo notebook (pestaña nueva): ${COLAB_NOTEBOOK_URL}`);
  const opener = (url) => {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  };

  const [colabPage] = await Promise.all([
    context.waitForEvent?.('page', {
      timeout: 30000,
      predicate: p => {
        try { const u = typeof p.url === 'function' ? p.url() : (p.url || ''); return u.includes('colab.research.google.com'); }
        catch { return false; }
      }
    }),
    drivePage.evaluate?.(opener, COLAB_NOTEBOOK_URL),
  ]);

  await colabPage.bringToFront?.();
  try { await colabPage.waitForLoadState?.('domcontentloaded', { timeout: 240000 }); } catch {}
  try { await colabPage.waitForSelector?.('.cell.code', { timeout: 120000 }); } catch {}
  console.log('✅ Editor de Colab visible.');

  // Dialogs
  try { const runAnyway = colabPage.locator?.('colab-dialog button:has-text("Run anyway")')?.first?.(); if (runAnyway && await runAnyway.count?.()) { await runAnyway.click?.(); await sleep(200); } } catch {}
  try { const welcomeClose = colabPage.locator?.('colab-dialog[class*="welcome-dialog"] #close-icon')?.first?.(); if (welcomeClose && await welcomeClose.count?.()) { await welcomeClose.click?.(); await sleep(150); } } catch {}

  // Celda 0 + reinicio runtime
  console.log('1️⃣ Ejecutando primera celda…');
  try {
    const runBtn0 = colabPage.locator?.('colab-run-button')?.first?.();
    await runBtn0?.waitFor?.({ state: 'visible', timeout: 20000 });
    await runBtn0?.click?.();
    await sleep(400);
  } catch {}
  await restartRuntimeFlexible(colabPage);

  // Re-ejecutar celda 0 y esperar tick
  try {
    const editor0 = colabPage.locator?.('.cell.code')?.nth?.(0)?.locator?.('.monaco-editor')?.first?.();
    await editor0?.click?.();
    await colabPage.keyboard?.down(mod); await colabPage.keyboard?.press('Enter'); await colabPage.keyboard?.up(mod);
    console.log('✅ Celda 0 re-ejecutada.');
    await waitForCellToFinish(colabPage, 0).catch(()=>{});
  } catch (e) { console.warn('⚠️ No se pudo relanzar celda 0:', e.message); }

  // -----------------------------------------------------------------
  //  INICIO: LÓGICA CORREGIDA PARA CELDA 2
  // -----------------------------------------------------------------

  // Celda 2: montar Drive + consent
  console.log('2️⃣ Ejecutando Celda 2 (montaje Drive)…');
  try {
    const editor1 = colabPage.locator?.('.cell.code')?.nth?.(1)?.locator?.('.monaco-editor')?.first?.();
    await editor1?.click?.();
    await colabPage.keyboard?.down(mod); await colabPage.keyboard?.press('Enter'); await colabPage.keyboard?.up(mod);
  } catch {}
  
  console.log('⏳ Esperando 2 segundos a que aparezca el diálogo de montaje...'); 
  await sleep(2000); // Pausa fija de 2s

  // Asumimos que el diálogo (de tu captura) SIEMPRE aparece.
  // No usamos 'waitAndFocusConnectButton' porque no necesitamos enfocar, solo pulsar Enter.
  console.log('↩️ Pulsando ENTER para aceptar el diálogo "Conectar con Google Drive".');
  await colabPage.keyboard?.press('Enter').catch(e => {
    console.warn(`⚠️ Fallo al pulsar ENTER (quizás el diálogo no estaba activo): ${e.message}`);
  });

  // ⬇ Manejo de popups OAuth (esto DEBERÍA ocurrir siempre después de pulsar Enter)
  console.log('🔐 Esperando cascada de popups de OAuth...');
  await waitForOAuthCascade(context, colabPage, handleOAuthPopupByEmailOrForm, { windowMs: 120000, idleMs: 2000 });
  await colabPage.bringToFront?.();
  
  console.log('🕰️ Esperando finalización de Celda 2 (montaje y JSON)...');

  try {
    // 1. Esperamos SOLAMENTE a que la celda termine (tick)
    await waitForCellToFinish(colabPage, 1, { timeoutMs: 180000 });
    console.log('✅ Celda 2 (montaje) finalizada con ✓ tick.');

  } catch (e) {
    console.error(`❌ Falló la ejecución de la Celda 2 (no terminó con tick): ${e.message}`);
    // Aún si falla el tick, intentamos leer el JSON por si acaso
    colabCell2Result = await readCellJsonOutput(colabPage, 1);
    throw new Error(`Fallo en la celda 2 (montaje): ${e.message}`);
  }
  
  // 2. Ahora que ha terminado, leemos su output JSON
  colabCell2Result = await readCellJsonOutput(colabPage, 1); // <-- GUARDAMOS EL JSON
    
  if (colabCell2Result && colabCell2Result.ok) {
    console.log('✅ JSON de Celda 2 parseado correctamente.');
  } else if (colabCell2Result) {
    console.warn('⚠️ JSON de Celda 2 reportó un error:', colabCell2Result.error);
    // Lanzamos el error para detener el flujo si Colab falló
    throw new Error(`Error reportado por Colab (Celda 2): ${colabCell2Result.error}`);
  } else {
    // Si el tick apareció (try anterior) pero no hay JSON, es un error
    console.warn('⚠️ No se pudo parsear el JSON de la Celda 2 (output vacío o malformado).');
    throw new Error('No se pudo parsear el JSON de la Celda 2 (montaje).');
  }
  // -----------------------------------------------------------------
  //  FIN: LÓGICA MODIFICADA PARA CELDA 2
  // -----------------------------------------------------------------


  // Celda 3: ejecutar y esperar ESTRICTAMENTE True o link
  console.log('3️⃣ Ejecutando Celda 3…');
  await runCellByIndex(colabPage, 2, false);
  const outcome = await waitForCloudflareLinkOrTrueInCell(colabPage, 2, { timeoutMs: 300000 });

  if (outcome?.kind === 'link') {
    console.log('🔗 Notebook devolvió link; devolvemos el link y detenemos flujo.');
    return { result: outcome.value, page: colabPage, context, colabCell2Result }; // <-- Adjuntamos JSON
  }

  if (outcome?.kind === 'true') {
    console.log('🟢 Notebook devolvió True → procederemos a descargar video.mp3 (método: menú “Descargar”).');
  
    const videosTab = await switchToVideosTab(context);
    await videosTab?.bringToFront?.().catch(()=>{});
    try { await videosTab?.waitForLoadState?.('domcontentloaded', { timeout: 10000 }); } catch {}
  
    let dlInfo = null;
    let savedPath = null;
    let browser = null;
  
    // -----------------------------------------------------------------
    //  INICIO: LÓGICA DE REINTENTO DE DESCARGA
    // -----------------------------------------------------------------
    const MAX_DOWNLOAD_ATTEMPTS = 3;
    const DOWNLOAD_RETRY_DELAY_MS = 10000; // 10 segundos
    let lastDownloadError = null;

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        console.log(`[Intento ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}] Iniciando descarga por menú...`);
        
        if (attempt > 1) {
          console.log(`Recargando pestaña de Drive para forzar sincronización...`);
          // Usar goto() es más estable que reload() y asegura la URL correcta
          const targetUrl = FIXED_FOLDER_URL.includes('?') ? `${FIXED_FOLDER_URL}&hl=es` : `${FIXED_FOLDER_URL}?hl=es`;
          await videosTab.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          // Usar el helper robusto para esperar que la UI esté lista
          await waitForDriveReady(videosTab, 30000); 
          console.log("✅ Pestaña recargada y lista.");
          await sleep(2000); // Pequeña espera extra para que la lista de archivos se pinte
        }

        console.log("Hemos llegado a la zona crítica");
        dlInfo = await downloadAndTrashFileViaMenu(
          videosTab,
          'video.mp3',
          { destDir: (typeof os?.tmpdir === 'function' ? os.tmpdir() : '/tmp'), timeoutMs: 120000 }
        );
        
        savedPath = dlInfo?.path || null;
        console.log(`✅ [Intento ${attempt}] Descarga completada por menú:`, savedPath);
        lastDownloadError = null; 
        break; 
      
      } catch (err) {
        console.warn(`⚠️ [Intento ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}] Falló método por menú:`, err.message);
        lastDownloadError = err; 
        
        // Si el error es que la página no existe (porque crasheó)
        if (err.message.includes('Target closed') || err.message.includes('crashed') || videosTab.isClosed()) {
            console.error("❌ La pestaña de Drive se cerró o crasheó. No se puede continuar.");
            throw new Error(`La pestaña de Drive crasheó durante el intento ${attempt}: ${err.message}`);
        }
        
        if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
          console.log(`...esperando ${DOWNLOAD_RETRY_DELAY_MS / 1000}s antes de reintentar...`);
          await sleep(DOWNLOAD_RETRY_DELAY_MS);
        }
      }
    }

    if (lastDownloadError) {
      console.error(`❌ Fallaron todos los ${MAX_DOWNLOAD_ATTEMPTS} intentos de descarga.`);
      throw lastDownloadError;
    }

    if (savedPath) {
      try {
        console.log('🧹 Cerrando contexto Playwright...');
        await context.close();
      } catch (closeErr) {
        console.warn('⚠️ Error al cerrar contexto:', closeErr.message);
      }
  
      try {
        browser = context.browser?.() || context._browser || null;
        if (browser) {
          await browser.close();
          console.log('✅ Navegador cerrado correctamente.');
        }
      } catch (closeErr) {
        console.warn('⚠️ Error al cerrar navegador:', closeErr.message);
      }
    }
    // -----------------------------------------------------------------
    //  FIN: LÓGICA DE REINTENTO DE DESCARGA
    // -----------------------------------------------------------------
  
    return { result: true, download: dlInfo, page: colabPage, context, colabCell2Result }; // <-- Adjuntamos JSON
  }
  

  // Ni link ni True → no seguimos
  throw new Error('No se obtuvo enlace de Cloudflare ni "True" en la celda 3.');
}

if (require.main === module) {
  drive_auto()
    .then(({ result, colabCell2Result }) => { // <-- Extraemos el nuevo JSON
      console.log('\n📊 RESULTADO FINAL (Celda 3):\n', result);
      
      if (colabCell2Result) {
        console.log('\n📦 DATOS (Celda 2 JSON):\n', JSON.stringify(colabCell2Result, null, 2)); // <-- Lo imprimimos
      } else {
        console.log('\n📦 DATOS (Celda 2 JSON): No se pudo capturar.');
      }
    })
    .catch(err => { console.error('🔥 Error:', err?.stack || err?.message); process.exit(1); });
}

module.exports = { drive_auto };