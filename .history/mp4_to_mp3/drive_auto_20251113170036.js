// drive_auto.js — Abre Colab, monta Drive, espera JSON (celda 2) y True (celda 3), y (si True) descarga.
'use strict';

const os = require('os'); // ← asegura que 'os' está en scope (evita ReferenceError)
const puppeteer = require('puppeteer-extra');                  // (no lanzamos puppeteer; ok)
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const {
  attemptGoogleLogin,
  switchToVideosTab,
  downloadAndTrashFileViaMenu,   // preferido (menu Download)
  FIXED_FOLDER_URL
} = require('./auto_log_in.js');

const COLAB_NOTEBOOK_URL =
  process.env.COLAB_NOTEBOOK_URL ||
  'https://colab.research.google.com/drive/1WjbE6Cez95NnBn4AhLgisCHG2FJuDrmk?usp=sharing&hl=en';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EMAIL = process.env.GOOGLE_USER || 'pacoplanestomas@gmail.com';
const PASS  = process.env.GOOGLE_PASS  || '392002Planes0.';

/* ---------------- Utils existentes ---------------- */
// ... (isOAuthLikeUrl, clickByTextAcrossFrames, ensureVisibleAndFocused, ...)
// ... (stepThroughConsent, waitAndFocusConnectButton, waitForOAuthCascade, ...)
// ... (handleOAuthPopupByEmailOrForm, openRuntimeMenu, clickRuntimeRestartLike, ...)
// ... (confirmYesOkDialogs, restartRuntimeFlexible, waitForCellToFinish, ...)
// ... (waitForMountedDriveInCell, ensureRunButtonIndex, runCellByIndex)
// ... (Las funciones auxiliares existentes no cambian) ...


/* === NUEVO: Espera "True" en la celda final (índice 3) === */
async function waitForTrueInCell(page, idx = 3, { timeoutMs = 300000, pollMs = 300 } = {}) {
  console.log(`👂 Esperando "True" estricto en celda #${idx}…`);
  const handle = await page.waitForFunction?.(
    (i) => {
      const cell = document.querySelectorAll('.cell.code')[i];
      if (!cell) return false;

      // 1. Colector recursivo
      const nodes = [];
      (function collect(root, acc) {
        if (!root) return;
        acc.push(root);
        if (root.shadowRoot) {
          const shadowChildren = root.shadowRoot.querySelectorAll('*');
          for (const el of shadowChildren) { collect(el, acc); }
        }
        const children = root.querySelectorAll ? root.querySelectorAll(':scope > *') : [];
        for (const el of children) { collect(el, acc); }
      })(cell, nodes);

      // 2. Iterar todos los nodos, al revés
      const texts = [];
      for (let j = nodes.length - 1; j >= 0; j--) {
        const node = nodes[j];
        if (!node || node.tagName === 'STYLE' || node.tagName === 'SCRIPT') continue;
        const text = (node.textContent || '').trim();
        if (text) texts.push(text);
      }
      
      if (texts.length) {
        // Busca el texto "True" exacto en las salidas
        for (const t of texts) {
            const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const lastLine = lines.pop();
            if (lastLine === 'True') {
                return { kind: 'true', value: true };
            }
        }
      }
      return false; // No encontrado aún
    },
    idx,
    { timeout: timeoutMs, polling: pollMs }
  );
  return handle?.jsonValue?.();
}

/* === NUEVO: Extrae el JSON de la celda 2 (después de ejecutar) === */
async function getJsonOutputFromCell(page, idx = 2) {
  console.log(`... Saneando JSON de la celda #${idx}...`);
  try {
    const jsonResult = await page.evaluate((i) => {
      const cell = document.querySelectorAll('.cell.code')[i];
      if (!cell) return null;
      
      // 1. Colector recursivo
      const nodes = [];
      (function collect(root, acc) {
        if (!root) return;
        acc.push(root);
        if (root.shadowRoot) {
          const shadowChildren = root.shadowRoot.querySelectorAll('*');
          for (const el of shadowChildren) { collect(el, acc); }
        }
        const children = root.querySelectorAll ? root.querySelectorAll(':scope > *') : [];
        for (const el of children) { collect(el, acc); }
      })(cell, nodes);
      
      // 2. Iterar todos los nodos, al revés
      for (let j = nodes.length - 1; j >= 0; j--) {
        const node = nodes[j];
        if (!node || node.tagName === 'STYLE' || node.tagName === 'SCRIPT') continue;
        
        const text = (node.textContent || '').trim();
        if (!text) continue;

        const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (!lines.length) continue;

        const lastLine = lines[lines.length - 1];

        if (lastLine.startsWith('{') && lastLine.endsWith('}')) {
          try {
            const parsed = JSON.parse(lastLine);
            if (typeof parsed.ok === 'boolean') {
              return parsed; // ¡Encontrado!
            }
          } catch (e) {}
        }
      }
      return null;
    }, idx);
    
    console.log(jsonResult ? '✅ JSON extraído.' : '⚠️ No se encontró JSON en la celda 2.');
    return jsonResult;

  } catch (e) {
    console.warn(`⚠️ No se pudo extraer JSON de la celda #${idx}: ${e.message}`);
    return null;
  }
}


/* ---------------- Flujo principal ---------------- */

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
  try { const runAnyway = colabPage.locator?.('colab-dialog button:has-text("Run anyway")')?.first?.(); if (runAnyway && await runAnyway.count?.()) { await runAnyway.click?.(); await sleep(600); } } catch {}
  try { const welcomeClose = colabPage.locator?.('colab-dialog[class*="welcome-dialog"] #close-icon')?.first?.(); if (welcomeClose && await welcomeClose.count?.()) { await welcomeClose.click?.(); await sleep(300); } } catch {}

  // Celda 0 + reinicio runtime
  console.log('1️⃣ Ejecutando primera celda (Índice 0)…');
  try {
    const runBtn0 = colabPage.locator?.('colab-run-button')?.first?.();
    await runBtn0?.waitFor?.({ state: 'visible', timeout: 20000 });
    await runBtn0?.click?.();
    await sleep(1200);
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

  // Celda 1: montar Drive + consent (índice 1)
  console.log('2️⃣ Ejecutando Celda 2 (montaje Drive, Índice 1)…');
  try {
    const editor1 = colabPage.locator?.('.cell.code')?.nth?.(1)?.locator?.('.monaco-editor')?.first?.();
    await editor1?.click?.();
    await colabPage.keyboard?.down(mod); await colabPage.keyboard?.press('Enter'); await colabPage.keyboard?.up(mod);
  } catch {}
  console.log('⏳ Espera breve…'); 
  await sleep(3500);

  const focused = await waitAndFocusConnectButton(colabPage, 30000);
  if (!focused) console.warn('⚠️ No se pudo enfocar el botón; ENTER igualmente.');
  await colabPage.keyboard?.press('Enter');
  console.log('↩️ ENTER enviado al diálogo.');

  // ⬇ Manejo de popups OAuth con reintentos sobre la MISMA ventana
  await waitForOAuthCascade(context, colabPage, handleOAuthPopupByEmailOrForm, { windowMs: 120000, idleMs: 2000 });
  await colabPage.bringToFront?.();
  console.log('🕰️ Esperando montaje /content/drive…');

  await Promise.race([
    waitForMountedDriveInCell(colabPage, 1, { timeoutMs: 180000 }),
    waitForCellToFinish(colabPage, 1, { timeoutMs: 180000 })
  ]).catch(()=>{});
  console.log('✅ Montaje de Drive OK (texto o tick).');

  // Celda 2: ejecutar FFMPEG/JSON y esperar que TERMINE (índice 2)
  console.log('3️⃣ Ejecutando Celda 3 (lógica FFMPEG, Índice 2)…');
  // ESPERAMOS EL TICK (true) para asegurar que el JSON se ha impreso.
  await runCellByIndex(colabPage, 2, true); 
  console.log('✅ Celda 3 (FFMPEG) finalizada.');
  
  // Celda 3: ejecutar 'print("True")' y esperar "True" (índice 3)
  console.log('4️⃣ Ejecutando Celda 4 (True, Índice 3)…');
  await runCellByIndex(colabPage, 3, false);
  const outcome = await waitForTrueInCell(colabPage, 3, { timeoutMs: 300000 });

  // AHORA, volvemos a la celda 2 para recoger el JSON
  const colabJson = await getJsonOutputFromCell(colabPage, 2);

  if (colabJson && colabJson.ok === false) {
    console.error('❌ Notebook (Celda 2) devolvió JSON con error:', colabJson.error);
    throw new Error(colabJson.error || 'El notebook de Colab falló (ok: false).');
  }

  if (outcome?.kind === 'true') {
    console.log('🟢 Notebook (Celda 3) devolvió True → procederemos a descargar video.mp3.');
    console.log('📄 Info Colab (Celda 2):', JSON.stringify(colabJson));
  
    const videosTab = await switchToVideosTab(context);
    await videosTab?.bringToFront?.().catch(()=>{});
    try { await videosTab?.waitForLoadState?.('domcontentloaded', { timeout: 10000 }); } catch {}
  
    let dlInfo = null;
    let savedPath = null;
    let browser = null;
  
    try {
      console.log("Hemos llegado a la zona crítica");
      dlInfo = await downloadAndTrashFileViaMenu(
        videosTab,
        'video.mp3',
        { destDir: (typeof os?.tmpdir === 'function' ? os?.tmpdir() : '/tmp'), timeoutMs: 120000 }
      );
      savedPath = dlInfo?.path || null;
      console.log('✅ Descarga completada por menú:', savedPath);
    } catch (err) {
      console.warn('⚠️ Falló método por menú, intentando método antiguo como fallback:', err.message);
      try {
        const { downloadAndTrashFile } = require('./auto_log_in.js');
        dlInfo = await downloadAndTrashFile(
          videosTab,
          'video.mp3',
          { destDir: (typeof os?.tmpdir === 'function' ? os?.tmpdir() : '/tmp'), timeoutMs: 120000 }
        );
        savedPath = dlInfo?.path || null;
        console.log('✅ Descarga completada por método antiguo:', savedPath);
      } catch (e2) {
        console.error('❌ Falló también el método antiguo:', e2.message);
        throw e2;
      }
    } finally {
      // 🔒 Cerrar navegador/contexto solo si realmente se descargó algo
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
    }
  
    // Devolvemos el JSON de Colab junto con el resto
    return { result: true, colabJson: colabJson, download: dlInfo, page: colabPage, context };
  }
  
  // Ni link ni True → no seguimos
  throw new Error('No se obtuvo "True" en la celda 4 (índice 3).');
}

if (require.main === module) {
  drive_auto()
    .then(({ result, colabJson, download }) => { 
      console.log('\n' + '-'.repeat(60));
      console.log('📊 RESULTADO SCRIPT (ok):', result); 
      console.log('\n📄 INFO COLAB (JSON):\n', JSON.stringify(colabJson, null, 2));
      console.log('\n💾 INFO DESCARGA:\n', download);
      console.log('-'.repeat(60));
    })
    .catch(err => { console.error('🔥 Error:', err?.stack || err?.message); process.exit(1); });
}

module.exports = { drive_auto };