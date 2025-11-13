// gemini_auto.js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs/promises');

// Reusamos utilidades de login Drive para aprovechar sesión Google
const { createUndetectableBrowser, gotoWithRetry, handleGoogleLogin } = require('./auto_log_in.js');

/* ==============================
 * Config / Debug
 * ============================== */
const DEBUG = process.env.DEBUG_GEMINI_AUTOMATION !== '0'; // ON por defecto
const dlog = (...args) => { if (DEBUG) console.log('[GEMINI]', ...args); };
const ddom = (...args) => { if (DEBUG) console.log('[GEMINI DOM]', ...args); };

/* ==============================
 * Tiempos / Selectores
 * ============================== */
const TIMEOUTS = {
  editorVisible: 60_000,
  stopAppear: 15_000,
  stopGone: 300_000,
  replyVisible: 120_000,
  sidebarOps: 30_000
};

const STOP_ICON_SELECTORS = [
  'mat-icon[fonticon="stop"]',
  'mat-icon[ng-reflect-font-icon="stop"]',
  'mat-icon[data-mat-icon-name="stop"]',
  '.mat-icon[fonticon="stop"]',
  '.mat-icon[data-mat-icon-name="stop"]',
  'button:has(mat-icon[fonticon="stop"])',
  'button:has(.mat-icon[data-mat-icon-name="stop"])',
  '[aria-label*="Parar"] mat-icon',
  '[aria-label*="Stop"] mat-icon'
];

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="Enviar"]',
  'button[aria-label*="Send"]',
  '[data-testid="send-button"]',
  'button:has-text("Enviar")',
  'button:has-text("Send")',
];

const MESSAGE_CONTENT_CANDIDATES = [
  'message-content.model-response-text .markdown.markdown-main-panel.stronger.enable-updated-hr-color[aria-live="polite"]',
  'message-content.model-response-text [id^="model-response-message-content"][aria-live="polite"]',
  'message-content.model-response-text[aria-live="polite"]',
  'message-content.model-response-text'
];

/* ==============================
 * Helpers
 * ============================== */
async function tryClickFirst(page, selectors = []) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try { await loc.click({ timeout: 3500 }); dlog('click:', sel); return true; }
      catch (e) { dlog('click fail:', sel, e.message); }
    }
  }
  return false;
}

async function focusEditorAndInsert(page, editorLocator, text) {
  await editorLocator.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod); await page.keyboard.press('KeyA'); await page.keyboard.up(mod);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
  dlog('Texto inyectado en editor. Longitud =', text.length);
}

async function sendCurrentEditor(page) {
  const clicked = await tryClickFirst(page, SEND_BUTTON_SELECTORS);
  if (!clicked) { try { await page.keyboard.press('Enter'); dlog('Enviar via Enter'); } catch {} }
  else { dlog('Enviar via botón'); }
}

async function countMessages(page) {
  const counts = await page.evaluate(() => {
    const md = document.querySelectorAll('[data-testid="markdown"]').length;
    const art = document.querySelectorAll('article').length;
    const fb = document.querySelectorAll('.response, .message, .markdown-body').length;
    const mc = document.querySelectorAll('message-content.model-response-text').length;
    return { md, art, fb, mc, total: md + art + fb + mc };
  }).catch(() => ({ md: 0, art: 0, fb: 0, mc: 0, total: 0 }));
  dlog('Conteo mensajes:', counts);
  return counts;
}

async function waitForStopIconCycle(page, { appearTimeout = TIMEOUTS.stopAppear, goneTimeout = TIMEOUTS.stopGone } = {}) {
  dlog('Observando ciclo del icono STOP…');
  const details = {
    appeared: false, disappeared: false, appearAt: null, disappearAt: null,
    appearSelector: null, durationMs: null, timeoutAtAppear: false, timeoutAtGone: false,
  };

  const appearedSelHandle = await page.waitForFunction(
    (sels) => sels.find(s => !!document.querySelector(s)) || null,
    STOP_ICON_SELECTORS,
    { timeout: appearTimeout }
  ).catch(() => null);

  const appearedSel = appearedSelHandle ? await appearedSelHandle.jsonValue().catch(() => null) : null;
  if (appearedSel) {
    details.appeared = true;
    details.appearAt = Date.now();
    details.appearSelector = String(appearedSel);
    dlog('STOP APARECIÓ via', details.appearSelector);
  } else {
    details.timeoutAtAppear = true;
    dlog('STOP no apareció dentro de', appearTimeout, 'ms.');
  }

  const res = await page.waitForFunction((sels, maxMs) => new Promise((resolve) => {
    const visible = () => {
      for (const s of sels) {
        const els = Array.from(document.querySelectorAll(s));
        for (const el of els) {
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const ariaHidden = el.closest('[aria-hidden="true"]');
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' &&
              rect.width > 1 && rect.height > 1 && !ariaHidden) return true;
        }
      }
      return false;
    };

    if (!visible()) return resolve({ disappeared: true, disappearAt: Date.now() });

    const obs = new MutationObserver(() => {
      if (!visible()) { obs.disconnect(); resolve({ disappeared: true, disappearAt: Date.now() }); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    setTimeout(() => { try { obs.disconnect(); } catch {}; resolve({ disappeared: !visible(), disappearAt: Date.now() }); }, Math.max(100, maxMs));
  }), STOP_ICON_SELECTORS, goneTimeout).catch(() => null);

  if (res?.disappeared) {
    details.disappeared = true;
    details.disappearAt = res.disappearAt;
    details.durationMs = details.appearAt ? (details.disappearAt - details.appearAt) : null;
  } else {
    details.timeoutAtGone = true;
  }

  dlog('STOP ciclo fin:', { appeared: details.appeared, disappeared: details.disappeared, durationMs: details.durationMs });
  return details;
}

async function waitForStopToSend(page, { stableMs = 700, timeout = TIMEOUTS.stopGone } = {}) {
  dlog('Esperando CAMBIO STOP ➜ ENVIAR (o OUTPUT listo)…');
  const t0 = Date.now();
  const handle = await page.waitForFunction((stopSels, sendSels, msgCands, stable) => {
    const anyVisible = (selectors) => {
      for (const s of selectors) {
        const els = Array.from(document.querySelectorAll(s));
        for (const el of els) {
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const ariaHidden = el.closest('[aria-hidden="true"]');
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' &&
              rect.width > 1 && rect.height > 1 && !ariaHidden) return true;
        }
      }
      return false;
    };

    const sendVisible = () => {
      for (const s of sendSels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const dis = el.getAttribute('disabled') != null || el.getAttribute('aria-disabled') === 'true';
        const cs = el && getComputedStyle(el);
        if (!dis && cs && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') return true;
      }
      return false;
    };

    const outputReady = () => {
      const pickLast = () => {
        for (const sel of msgCands) {
          const all = Array.from(document.querySelectorAll(sel));
          if (all.length) return all[all.length - 1];
        }
        return null;
      };
      const node = pickLast();
      if (!node) return false;
      const host = node.closest?.('message-content.model-response-text') || node;
      const busyNode = node.hasAttribute?.('aria-busy') ? node : (host.querySelector?.('[aria-live][aria-busy]') || node);
      const busy = busyNode?.getAttribute?.('aria-busy');
      const textOk = (host.textContent || '').trim().length > 0;
      return busy === 'false' && textOk;
    };

    const stopVisible = anyVisible(stopSels);
    const ok = !stopVisible && (sendVisible() || outputReady());

    if (!window.__endStableSince) window.__endStableSince = 0;
    if (ok) {
      if (!window.__endStableSince) window.__endStableSince = Date.now();
      if (Date.now() - window.__endStableSince >= stable) {
        return { since: window.__endStableSince, mode: (sendVisible() ? 'send-visible' : 'output-ready') };
      }
      return false;
    } else {
      window.__endStableSince = 0;
      return false;
    }
  }, STOP_ICON_SELECTORS, SEND_BUTTON_SELECTORS, MESSAGE_CONTENT_CANDIDATES, stableMs, { timeout }).catch(() => null);

  if (!handle) { dlog('⚠️ Timeout esperando fin (STOP ➜ ENVIAR / OUTPUT listo).'); return { ok: false, waitedMs: Date.now() - t0, mode: null }; }
  const val = await handle.jsonValue().catch(() => ({}));
  const waitedMs = Date.now() - (val?.since || Date.now());
  dlog('Fin detectado. modo =', val?.mode, '| estabilizado en', waitedMs, 'ms');
  return { ok: true, waitedMs, mode: val?.mode || null };
}

async function readOutputFromMessageContent(page, { timeout = TIMEOUTS.replyVisible } = {}) {
  dlog('Esperando a que el OUTPUT (message-content) esté listo…');

  await page.waitForFunction((cands) => {
    const pickLast = () => {
      for (const sel of cands) {
        const all = Array.from(document.querySelectorAll(sel));
        if (all.length) return { sel, el: all[all.length - 1] };
      }
      return null;
    };
    const found = pickLast();
    if (!found) return false;

    const el = found.el;
    const host = el.closest?.('message-content.model-response-text') || el;
    const busyNode = el.hasAttribute?.('aria-busy') ? el : (host.querySelector?.('[aria-live][aria-busy]') || el);
    const busy = busyNode?.getAttribute?.('aria-busy');
    const txt = (host.textContent || '').trim();
    return busy === 'false' && txt.length > 0;
  }, MESSAGE_CONTENT_CANDIDATES, { timeout });

  const result = await page.evaluate((cands) => {
    const pickLast = () => {
      for (const sel of cands) {
        const all = Array.from(document.querySelectorAll(sel));
        if (all.length) return { sel, node: all[all.length - 1] };
      }
      return null;
    };
    const found = pickLast();
    if (!found) return { text: '', selector: null, html: '' };

    const host = found.node.closest?.('message-content.model-response-text') || found.node;
    const inner = host.querySelector?.('.markdown.markdown-main-panel') || host;
    const text = (inner.innerText || host.innerText || '').trim();
    const html = (inner.innerHTML || host.innerHTML || '').trim();
    return { text, html, selector: found.sel };
  }, MESSAGE_CONTENT_CANDIDATES);

  dlog('OUTPUT listo desde selector:', result.selector, '| Longitud texto =', (result.text || '').length);
  return result;
}

/* ==============================
 * Debug DOM helpers (impresión y volcado a archivo)
 * ============================== */
const trimForConsole = (s, n = 2000) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);



/* ==============================
 * Borrado de conversación (topbar + lateral)
 * ============================== */
async function clearChatFromTopbar(page) {
  const clearSelectors = [
    'button[aria-label*="Limpiar conversación"]',
    'button[aria-label*="Limpiar chat"]',
    'button[aria-label*="Eliminar conversación"]',
    'button[aria-label*="Clear chat"]',
    'button[aria-label*="Delete chat"]',
    'button:has-text("Limpiar chat")',
    'button:has-text("Eliminar conversación")',
    'button:has-text("Clear chat")',
    'button:has-text("Delete chat")',
  ];
  if (await tryClickFirst(page, clearSelectors)) {
    const dialog = page.locator('div.cdk-overlay-container div[role="dialog"]:visible, div[role="dialog"]:visible').first();
    try { await dialog.waitFor({ state: 'visible', timeout: 6000 }); } catch {}
    const confirmBtn = dialog.locator(
      'button[data-test-id="confirm-button"], ' +
      'button:has(.mdc-button__label:has-text("Eliminar")), ' +
      'button:has-text("Eliminar"), ' +
      'button:has-text("Delete")'
    ).first();

    try {
      await confirmBtn.waitFor({ state: 'visible', timeout: 6000 });
      await confirmBtn.click({ timeout: 6000 }).catch(async (e) => {
        dlog('Confirm topbar click fallo:', e.message);
        await confirmBtn.dispatchEvent('click').catch(()=>{});
        await confirmBtn.evaluate(el => el.click()).catch(()=>{});
      });
      await page.waitForTimeout(1200);
      return true;
    } catch (e) {
      dlog('⚠️ No se pudo confirmar el diálogo (topbar):', e.message);
      await dumpOverlayDOM(page, 'topbar-confirm-timeout');
    }
  }
  return false;
}

async function openSidebarIfHidden(page) {
  const toggles = [
    'button[aria-label*="Mostrar barra lateral"]',
    'button[aria-label*="Ocultar barra lateral"]',
    'button[aria-label*="Show sidebar"]',
    'button[aria-label*="Hide sidebar"]',
    '[data-testid="side-nav-toggle"]',
  ];
  await tryClickFirst(page, toggles);
}

async function deleteConversationFromSidebar(page) {
  await openSidebarIfHidden(page);

  let container = page.locator('.conversation-actions-container.selected').first();
  if (!(await container.count())) container = page.locator('.conversation-actions-container').first();
  if (!(await container.count())) { dlog('⚠️ No se encontró .conversation-actions-container en el lateral.'); return false; }

  try { await container.scrollIntoViewIfNeeded(); await container.hover({ timeout: 1500 }).catch(() => {}); } catch {}

  // Abrir menú
  let actionsBtn = container.locator('button[data-test-id="actions-menu-button"]').first();
  if (await actionsBtn.count()) {
    try { await actionsBtn.click({ timeout: 3000 }); }
    catch (e) { dlog('click actions-menu-button fallo:', e.message); try { await actionsBtn.focus(); await page.keyboard.press('Enter'); } catch {} }
  } else {
    const icon = container.locator('mat-icon[fonticon="more_vert"], mat-icon[data-mat-icon-name="more_vert"], .mat-icon[fonticon="more_vert"], .mat-icon[data-mat-icon-name="more_vert"]').first();
    if (await icon.count()) {
      const clicked = await icon.evaluate((el) => { const btn = el.closest('button,[role="button"],.mat-mdc-icon-button'); if (btn) { btn.click(); return true; } return false; }).catch(() => false);
      if (!clicked) { try { await icon.click({ timeout: 1500 }); } catch {} }
    } else { dlog('⚠️ No se encontró botón ni icono de acciones.'); return false; }
  }

  const menuPanel = page.locator('div.cdk-overlay-container .mat-mdc-menu-panel:visible, div.cdk-overlay-pane .mat-mdc-menu-panel:visible, div[role="menu"]:visible').first();
  try { await menuPanel.waitFor({ state: 'visible', timeout: 6000 }); dlog('Menú lateral (overlay) visible.'); }
  catch (e) { dlog('⚠️ Menú overlay no visible:', e.message); await dumpOverlayDOM(page, 'menu-not-visible'); return false; }

  const deleteBtn = menuPanel.locator(
    'button[mat-menu-item][data-test-id="delete-button"], ' +
    'button[mat-menu-item]:has-text("Eliminar"), ' +
    'button[role="menuitem"]:has-text("Eliminar"), ' +
    'button.mat-mdc-menu-item:has-text("Eliminar"), ' +
    'button[mat-menu-item]:has(mat-icon[fonticon="delete"]), ' +
    'button[mat-menu-item]:has(mat-icon[data-mat-icon-name="delete"])'
  ).first();

  try {
    await deleteBtn.waitFor({ state: 'visible', timeout: 6000 });
    await deleteBtn.click({ timeout: 6000 });
    dlog('Click en "Eliminar" del menú lateral');
  } catch (e) {
    dlog('⚠️ No se pudo pulsar "Eliminar" del menú lateral:', e.message);
    await dumpOverlayDOM(page, 'delete-item-missing');
    return false;
  }

  // Confirmación – EXACTO data-test-id="confirm-button" + alternativas
  try {
    await page.waitForTimeout(150); // pequeña animación
    const dialog = page.locator('div.cdk-overlay-container div[role="dialog"]:visible, div[role="dialog"]:visible, .mdc-dialog:visible, .mat-mdc-dialog-container:visible').first();
    await dialog.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

    // imprime DOM inmediatamente tras abrir el diálogo (para inspección)
    await dumpOverlayDOM(page, 'after-delete-click');

    // selector exacto que nos has pasado
    let confirmBtn = dialog.locator('button[data-test-id="confirm-button"]').first();

    // Si no aparece, ampliamos búsqueda dentro del diálogo y global
    if (!(await confirmBtn.count())) {
      confirmBtn = dialog.locator(
        'button:has(.mdc-button__label:has-text("Eliminar")), ' +
        'button:has-text("Eliminar"), ' +
        'button:has-text("Delete")'
      ).first();
    }
    if (!(await confirmBtn.count())) {
      // fallback global: a veces el botón no está correctamente anidado bajo role="dialog"
      confirmBtn = page.locator(
        '.cdk-overlay-container button[data-test-id="confirm-button"], ' +
        '.cdk-overlay-container button:has(.mdc-button__label:has-text("Eliminar")), ' +
        '.cdk-overlay-container button:has-text("Eliminar"), ' +
        '.cdk-overlay-container button:has-text("Delete")'
      ).first();
    }

    await confirmBtn.waitFor({ state: 'visible', timeout: 8000 });
    try {
      await confirmBtn.click({ timeout: 8000 });
    } catch (e) {
      dlog('Confirm lateral click fallo:', e.message);
      await confirmBtn.dispatchEvent('click').catch(()=>{});
      await confirmBtn.evaluate(el => el.click()).catch(()=>{});
      try { await confirmBtn.focus(); await page.keyboard.press('Enter'); } catch {}
    }

    await page.waitForTimeout(1200);
    dlog('✅ Conversación borrada desde lateral (confirm-button / texto)');
    return true;
  } catch (e) {
    dlog('⚠️ No se pudo confirmar el diálogo lateral:', e.message);
    // Volcado final de DOM para ver dónde falla exactamente
    await dumpOverlayDOM(page, 'confirm-timeout');
    return false;
  }
}

/* ==============================
 * Exportadas
 * ============================== */

/**
 * Flujo completo:
 *  1) Abrir Gemini y pegar /tmp/video.txt en el editor.
 *  2) Enviar.
 *  3) Esperar fin robusto (STOP desaparecido + ENVIAR visible o OUTPUT listo).
 *  4) Leer OUTPUT desde <message-content …>.
 *  5) Borrar conversación (topbar o lateral) — con volcado de DOM si falla confirmación.
 */
async function injectFileAndDeleteConversation({ filePath = '/tmp/video.txt', deleteAfter = true, captureConsole = true } = {}) {
  const { browser, context, page } = await createUndetectableBrowser();
  const debugBag = {
    steps: [],
    stopCycle: null,
    endWait: null,
    countsBefore: null,
    countsAfter: null,
    urlAtStart: null,
    urlAtEnd: null,
    console: []
  };

  try {
    if (captureConsole) {
      page.on('console', (msg) => {
        const item = { type: msg.type(), text: msg.text() };
        debugBag.console.push(item);
        if (DEBUG) console.log('[BROWSER]', item.type, item.text);
      });
    }

    await gotoWithRetry(context, { page }, 'https://gemini.google.com/app?hl=es');
    debugBag.urlAtStart = page.url();
    debugBag.steps.push('goto Gemini');

    if (page.url().includes('accounts.google.com')) {
      debugBag.steps.push('handleGoogleLogin');
      await handleGoogleLogin(page, context);
      await gotoWithRetry(context, { page }, 'https://gemini.google.com/app?hl=es');
      debugBag.steps.push('back to Gemini');
    }

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: TIMEOUTS.editorVisible });
    debugBag.steps.push('editor visible');

    const text = await fs.readFile(filePath, 'utf8');
    debugBag.steps.push(`read file (${filePath}, ${text.length} chars)`);
    await focusEditorAndInsert(page, editor, text);

    debugBag.countsBefore = await countMessages(page);
    await sendCurrentEditor(page);
    debugBag.stopCycle = await waitForStopIconCycle(page).catch(() => null);
    debugBag.endWait = await waitForStopToSend(page, { stableMs: 700, timeout: TIMEOUTS.stopGone });
    debugBag.countsAfter = await countMessages(page);

    const output = await readOutputFromMessageContent(page, { timeout: TIMEOUTS.replyVisible });

    let deleted = false;
    if (deleteAfter) {
      deleted = await clearChatFromTopbar(page);
      if (!deleted) {
        try { deleted = await deleteConversationFromSidebar(page); } catch { deleted = false; }
      }
      debugBag.steps.push(`delete chat = ${deleted}`);
    }

    debugBag.urlAtEnd = page.url();

    return {
      ok: true,
      summary: output.text || '',
      html: output.html || '',
      url: page.url(),
      deleted,
      debug: JSON.parse(JSON.stringify(debugBag))
    };
  } catch (e) {
    debugBag.error = e?.message || String(e);
    return { ok: false, error: debugBag.error, debug: JSON.parse(JSON.stringify(debugBag)) };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/**
 * Compat: escribe prompt+text a un tmp y usa el flujo completo.
 */
async function summarizeWithGemini({ prompt = '', text = '', audioPath = null } = {}) {
  const tmp = `${prompt || ''}${prompt && text ? '\n\n' : ''}${text || ''}`;
  const tmpPath = '/tmp/video.txt';
  await fs.writeFile(tmpPath, tmp || '(vacío)');
  return injectFileAndDeleteConversation({ filePath: tmpPath, deleteAfter: true });
}

module.exports = {
  injectFileAndDeleteConversation,
  summarizeWithGemini,
};
