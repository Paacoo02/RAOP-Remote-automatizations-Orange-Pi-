// gemini_auto.js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs/promises');

// Reusamos las utilidades de login Drive para aprovechar sesión Google
const { createUndetectableBrowser, gotoWithRetry, handleGoogleLogin } = require('./auto_log_in.js');

/* ==============================
 * Config / Debug
 * ============================== */
const DEBUG = process.env.DEBUG_GEMINI_AUTOMATION !== '0'; // ON por defecto
const dlog = (...args) => { if (DEBUG) console.log('[GEMINI]', ...args); };

/* ==============================
 * Utilidades internas
 * ============================== */
const TIMEOUTS = {
  editorVisible: 60_000,
  stopAppear: 15_000,     // tiempo para que aparezca el icono stop tras enviar
  stopGone: 300_000,      // hasta 5 min para que desaparezca stop (fin)
  replyVisible: 120_000,
  sidebarOps: 30_000
};

// Selectores robustos para el icono Angular Material "stop"
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

// Botón de enviar (para detectar el cambio de STOP ➜ ENVIAR)
const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="Enviar"]',
  'button[aria-label*="Send"]',
  '[data-testid="send-button"]',
  'button:has-text("Enviar")',
  'button:has-text("Send")',
];

// Selectores para el OUTPUT real en el DOM (estructura que nos has pasado)
// <message-content class="model-response-text ...">
//   <div class="markdown markdown-main-panel stronger enable-updated-hr-color"
//        id="model-response-message-content..." aria-live="polite" aria-busy="false"> ... </div>
// </message-content>
const MESSAGE_CONTENT_CANDIDATES = [
  'message-content.model-response-text .markdown.markdown-main-panel.stronger.enable-updated-hr-color[aria-live="polite"]',
  'message-content.model-response-text [id^="model-response-message-content"][aria-live="polite"]',
  'message-content.model-response-text[aria-live="polite"]',
  'message-content.model-response-text'
];

async function tryClickFirst(page, selectors = []) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      try {
        await loc.click({ timeout: 3_500 });
        dlog('click:', sel);
        return true;
      } catch (e) {
        dlog('click fail:', sel, e.message);
      }
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

/**
 * Observa el ciclo del icono mat-icon "stop":
 * - Detecta la APARICIÓN tras enviar.
 * - Espera la DESAPARICIÓN (fin de generación).
 * Devuelve métricas y qué selector coincidió (en string JSON-safe).
 */
async function waitForStopIconCycle(page, {
  appearTimeout = TIMEOUTS.stopAppear,
  goneTimeout = TIMEOUTS.stopGone
} = {}) {
  dlog('Observando ciclo del icono STOP…');
  const details = {
    appeared: false,
    disappeared: false,
    appearAt: null,
    disappearAt: null,
    appearSelector: null,
    durationMs: null,
    timeoutAtAppear: false,
    timeoutAtGone: false,
  };

  // 1) Intento rápido de aparición (devuelve un string)
  const appearedSelHandle = await page.waitForFunction(
    (sels) => sels.find((s) => !!document.querySelector(s)) || null,
    STOP_ICON_SELECTORS,
    { timeout: appearTimeout }
  ).catch(() => null);

  const appearedSel = appearedSelHandle
    ? await appearedSelHandle.jsonValue().catch(() => null)
    : null;

  if (appearedSel) {
    details.appeared = true;
    details.appearAt = Date.now();
    details.appearSelector = String(appearedSel);
    dlog('STOP APARECIÓ via', details.appearSelector);
  } else {
    details.timeoutAtAppear = true;
    dlog('STOP no apareció dentro de', appearTimeout, 'ms (posible respuesta rápida).');
  }

  // 2) Observamos con MutationObserver hasta desaparición (o timeout)
  function injectObserver(sels, maxMs) {
    return page.evaluate((selectors, maxMs) => new Promise((resolve) => {
      const data = {
        appeared: false,
        disappeared: false,
        appearAt: null,
        disappearAt: null,
        appearSelector: null,
        durationMs: null,
        timeoutAtAppear: false,
        timeoutAtGone: false,
      };

      const exists = () => {
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (el) return s;
        }
        return null;
      };

      const stepDisappear = () => {
        const obs2 = new MutationObserver(() => {
          const selNow = exists();
          if (!selNow) {
            data.disappeared = true;
            data.disappearAt = Date.now();
            data.durationMs = data.appearAt ? (data.disappearAt - data.appearAt) : null;
            obs2.disconnect();
            resolve(data);
          }
        });
        // comprobar una vez por si ya desapareció
        if (!exists()) {
          data.disappeared = true;
          data.disappearAt = Date.now();
          data.durationMs = data.appearAt ? (data.disappearAt - data.appearAt) : null;
          resolve(data);
          return;
        }
        obs2.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        setTimeout(() => {
          try { obs2.disconnect(); } catch {}
          data.timeoutAtGone = !data.disappeared;
          resolve(data);
        }, Math.max(100, maxMs));
      };

      // Fase apariencia
      const obs1 = new MutationObserver(() => {
        const selNow = exists();
        if (selNow && !data.appeared) {
          data.appeared = true;
          data.appearAt = Date.now();
          data.appearSelector = selNow;
          obs1.disconnect();
          stepDisappear();
        }
      });

      const selInit = exists();
      if (selInit) {
        data.appeared = true;
        data.appearAt = Date.now();
        data.appearSelector = selInit;
        stepDisappear();
      } else {
        obs1.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        setTimeout(() => {
          try { obs1.disconnect(); } catch {}
          if (!data.appeared) {
            data.timeoutAtAppear = true;
            // aun así pasamos a observar la desaparición por si nunca aparece y ya está todo
            stepDisappear();
          }
        }, Math.max(100, maxMs));
      }
    }), sels, maxMs);
  }

  const result = await injectObserver(STOP_ICON_SELECTORS, goneTimeout);
  // Forzar JSON-safe en appearSelector
  if (result && result.appearSelector) result.appearSelector = String(result.appearSelector);
  Object.assign(details, result);

  if (details.appeared) {
    dlog('STOP ciclo:', {
      appeared: details.appeared,
      disappeared: details.disappeared,
      appearSelector: details.appearSelector,
      durationMs: details.durationMs
    });
  } else {
    dlog('STOP no llegó a aparecer; flags:', { timeoutAtAppear: details.timeoutAtAppear, timeoutAtGone: details.timeoutAtGone });
  }

  return details;
}

/**
 * NUEVO: Espera explícitamente al CAMBIO STOP ➜ ENVIAR:
 *   - Condición: NO hay ningún STOP visible Y hay un botón ENVIAR visible y habilitado.
 *   - Requiere estabilidad durante `stableMs`.
 * Devuelve info de depuración (selector del botón enviar y ms de espera).
 */
async function waitForStopToSend(page, {
  stableMs = 700,
  timeout = TIMEOUTS.stopGone
} = {}) {
  dlog('Esperando CAMBIO STOP ➜ ENVIAR… (estable', stableMs, 'ms)');
  const t0 = Date.now();
  const resHandle = await page.waitForFunction((stopSels, sendSels, stable) => {
    const stopExists = () => stopSels.some(s => !!document.querySelector(s));
    const findSend = () => {
      for (const s of sendSels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const disabled = el.getAttribute('disabled') != null || el.getAttribute('aria-disabled') === 'true';
        const st = window.getComputedStyle(el);
        const visible = st && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
        if (!disabled && visible) return s;
      }
      return null;
    };

    const ok = !stopExists() && !!findSend();
    if (!window.__stopToSendSince) window.__stopToSendSince = 0;
    if (ok) {
      if (!window.__stopToSendSince) window.__stopToSendSince = Date.now();
      if (Date.now() - window.__stopToSendSince >= stable) {
        return { since: window.__stopToSendSince, sendSel: findSend() };
      }
      return false;
    } else {
      window.__stopToSendSince = 0;
      return false;
    }
  }, STOP_ICON_SELECTORS, SEND_BUTTON_SELECTORS, stableMs, { timeout })
  .catch(() => null);

  if (!resHandle) {
    dlog('⚠️ Timeout esperando STOP ➜ ENVIAR.');
    return { ok: false, waitedMs: Date.now() - t0, sendSel: null };
  }
  const val = await resHandle.jsonValue().catch(() => ({}));
  const waitedMs = Date.now() - (val?.since || Date.now());
  dlog('Cambio STOP ➜ ENVIAR detectado. sendSel =', val?.sendSel, '| estabilizado en', waitedMs, 'ms');
  return { ok: true, sendSel: val?.sendSel || null, waitedMs };
}

/**
 * Espera a que el **último** message-content de respuesta del modelo esté listo (aria-busy="false")
 * y devuelve su texto/HTML. Devuelve además info del selector que coincidió.
 */
async function readOutputFromMessageContent(page, {
  timeout = TIMEOUTS.replyVisible
} = {}) {
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

async function countMessages(page) {
  const counts = await page.evaluate(() => {
    const md = document.querySelectorAll('[data-testid="markdown"]').length;
    const art = document.querySelectorAll('article').length;
    const fb = document.querySelectorAll('.response, .message, .markdown-body').length;
    return { md, art, fb, total: md + art + fb };
  }).catch(() => ({ md: 0, art: 0, fb: 0, total: 0 }));
  dlog('Conteo mensajes:', counts);
  return counts;
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
    const confirmSelectors = [
      'button:has-text("Eliminar")',
      'button:has-text("Borrar")',
      'button:has-text("Delete")',
      'button[aria-label*="Eliminar"]',
      'button[aria-label*="Delete"]',
    ];
    await tryClickFirst(page, confirmSelectors);
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

async function deleteConversationFromSidebar(page) {
  await openSidebarIfHidden(page);

  const listItemCandidates = [
    'nav [role="listitem"]',
    'aside nav li',
    '[data-testid*="conversation"]',
    'nav a[href*="/app"]',
  ];

  let listItem = null;
  for (const sel of listItemCandidates) {
    const loc = page.locator(sel);
    if (await loc.count()) {
      listItem = loc.first();
      break;
    }
  }
  if (!listItem) return false;

  const kebabSelectors = [
    'button[aria-label*="Más opciones"]',
    'button[aria-label*="More options"]',
    'button[aria-label*="Delete"]',
    'button[aria-label*="Eliminar"]',
  ];
  let openedMenu = false;
  for (const sel of kebabSelectors) {
    const btn = listItem.locator(sel).first();
    if (await btn.count()) {
      try { await btn.click({ timeout: 2000 }); openedMenu = true; break; } catch {}
    }
  }
  if (!openedMenu) {
    try {
      await listItem.hover({ timeout: 1000 });
      const box = await listItem.boundingBox();
      if (box) {
        await listItem.page().mouse.click(
          box.x + box.width / 2,
          box.y + box.height / 2,
          { button: 'right' }
        );
      }
    } catch {}
  }

  const deleteItemSelectors = [
    'div[role="menu"] :is(button,div,span,a):has-text("Eliminar")',
    'div[role="menu"] :is(button,div,span,a):has-text("Borrar")',
    'div[role="menu"] :is(button,div,span,a):has-text("Delete")',
    ':is(button,div,span,a)[role="menuitem"]:has-text("Eliminar")',
    ':is(button,div,span,a)[role="menuitem"]:has-text("Delete")',
  ];
  await tryClickFirst(page, deleteItemSelectors);

  const confirmSelectors = [
    'button:has-text("Eliminar")',
    'button:has-text("Borrar")',
    'button:has-text("Delete")',
    'button[aria-label*="Eliminar"]',
    'button[aria-label*="Delete"]',
  ];
  await tryClickFirst(page, confirmSelectors);

  await page.waitForTimeout(1500);
  return true;
}

async function sendCurrentEditor(page) {
  const sendSelectors = SEND_BUTTON_SELECTORS;
  const clicked = await tryClickFirst(page, sendSelectors);
  if (!clicked) {
    try {
      await page.keyboard.press('Enter');
      dlog('Enviar via Enter');
    } catch {}
  } else {
    dlog('Enviar via botón');
  }
}

// Asegura que un objeto sea JSON-safe (evita JSHandle / referencias circulares)
function makeJsonSafe(obj) {
  try { return JSON.parse(JSON.stringify(obj)); }
  catch {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === null) { out[k] = v; continue; }
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') { out[k] = v; continue; }
      try { out[k] = JSON.parse(JSON.stringify(v)); }
      catch { out[k] = String(v); }
    }
    return out;
  }
}

/* ==============================
 * Funciones exportadas
 * ============================== */

/**
 * Inyecta el contenido de un archivo de texto en Gemini, envía, y:
 *   1) Espera a que el botón cambie de STOP ➜ ENVIAR (fin real).
 *   2) Justo después, lee el OUTPUT desde <message-content …> y lo devuelve (texto y HTML).
 *   3) (Opcional) borra la conversación desde topbar o sidebar.
 */
async function injectFileAndDeleteConversation({ filePath = '/tmp/video.txt', deleteAfter = true, captureConsole = true } = {}) {
  const { browser, context, page } = await createUndetectableBrowser();
  const debugBag = {
    steps: [],
    stopCycle: null,             // para tener trazas de aparición/desaparición
    stopToSend: null,            // el nuevo detector de cambio STOP ➜ ENVIAR
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

    // Ir a Gemini (forzamos ES para labels)
    await gotoWithRetry(context, { page }, 'https://gemini.google.com/app?hl=es');
    debugBag.urlAtStart = page.url();
    debugBag.steps.push('goto Gemini');

    // Si pide login, lo hacemos y reintentamos
    if (page.url().includes('accounts.google.com')) {
      debugBag.steps.push('handleGoogleLogin');
      await handleGoogleLogin(page, context);
      await gotoWithRetry(context, { page }, 'https://gemini.google.com/app?hl=es');
      debugBag.steps.push('back to Gemini');
    }

    // Esperar el editor contenteditable
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: TIMEOUTS.editorVisible });
    debugBag.steps.push('editor visible');

    // Leer archivo e inyectar
    const text = await fs.readFile(filePath, 'utf8');
    debugBag.steps.push(`read file (${filePath}, ${text.length} chars)`);
    await focusEditorAndInsert(page, editor, text);

    // Conteo mensajes antes de enviar
    debugBag.countsBefore = await countMessages(page);

    // Enviar
    await sendCurrentEditor(page);

    // (Opcional) trazas completas del ciclo STOP
    debugBag.stopCycle = await waitForStopIconCycle(page).catch(() => null);

    // 1) Esperar explícitamente CAMBIO STOP ➜ ENVIAR (estabilidad)
    debugBag.stopToSend = await waitForStopToSend(page, { stableMs: 700, timeout: TIMEOUTS.stopGone });

    // Conteo mensajes después (para ver si aumentó)
    debugBag.countsAfter = await countMessages(page);

    // 2) Tomar el OUTPUT real del DOM indicado
    const output = await readOutputFromMessageContent(page, { timeout: TIMEOUTS.replyVisible });

    // 3) Borrar conversación (topbar o sidebar)
    let deleted = false;
    if (deleteAfter) {
      deleted = await clearChatFromTopbar(page);
      if (!deleted) {
        try { deleted = await deleteConversationFromSidebar(page); } catch { deleted = false; }
      }
      debugBag.steps.push(`delete chat = ${deleted}`);
    }

    debugBag.urlAtEnd = page.url();

    const safeDebug = makeJsonSafe(debugBag);
    return {
      ok: true,
      summary: output.text || '',
      html: output.html || '',
      url: page.url(),
      deleted,
      debug: safeDebug
    };
  } catch (e) {
    debugBag.error = e?.message || String(e);
    const safeDebug = makeJsonSafe(debugBag);
    return { ok: false, error: debugBag.error, debug: safeDebug };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/**
 * Compat: escribe prompt+text a un tmp y usa el flujo con espera STOP ➜ ENVIAR
 * y parseo del <message-content>.
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
