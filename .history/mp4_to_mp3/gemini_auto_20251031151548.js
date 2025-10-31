// gemini_auto.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// Reutilizamos helpers del auto_log_in.js
const {
  createUndetectableBrowser,
  gotoWithRetry,
  handleGoogleLogin,
} = require('./auto_log_in.js');

const GEMINI_URL = 'https://gemini.google.com/app/7e4792d6b319d4e6';

// ---------- helpers locales ----------
async function ensurePage(context, pageRef) {
  if (pageRef.page && !pageRef.page.isClosed()) return pageRef.page;
  pageRef.page = await context.newPage();
  await pageRef.page.route('**/*', r => r.continue());
  return pageRef.page;
}

async function clickIfVisible(page, selectors, timeout = 2000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.count()) {
        await loc.click({ timeout });
        return true;
      }
    } catch {}
  }
  return false;
}

// Seletores robustos para la UI de Gemini (pueden cambiar)
const SELECTORS = {
  signin: [
    'text=/^Iniciar sesión$/',
    'text=/^Sign in$/',
    'button:has-text("Iniciar sesión")',
    'button:has-text("Sign in")',
    'span.gb_be:has-text("Iniciar sesión")',
  ],
  textareaEditable: [
    // Rich editor (Quill) dentro del rich-textarea
    'rich-textarea .ql-editor[contenteditable="true"]',
    '.ql-editor[contenteditable="true"].textarea',
    '[contenteditable="true"][aria-label*="petición"]',
    '[contenteditable="true"][aria-label*="Pregunta"]',
    '[contenteditable="true"][aria-label*="prompt"]',
  ],
  attachButtons: [
    // Distintas variantes para abrir el selector de archivo (si el input está oculto)
    '[aria-label*="Adjuntar"]',
    '[aria-label*="Subir"]',
    '[aria-label*="Add attachment"]',
    'button:has([name="Attach"]), button:has([aria-label*="Attach"])',
    'button:has-text("Adjuntar")',
    'button:has-text("Subir archivo")',
    'button:has-text("Upload")',
  ],
  fileInputs: [
    'input[type="file"][accept*="audio"]',
    'input[type="file"][accept*="mp3"]',
    'input[type="file"]',
  ],
  sendButtons: [
    '[aria-label="Enviar"]',
    '[aria-label*="Send"]',
    'button:has-text("Enviar")',
    'button:has-text("Send")',
    'button:is([type="submit"])',
  ],
};

// ---------- login + apertura ----------
async function openGemini() {
  // Creamos navegador/contexto stealth como en auto_log_in
  const { browser, context, page: firstPage } = await createUndetectableBrowser();

  // Ir a la app de Gemini
  const page = await gotoWithRetry(context, { page: firstPage }, GEMINI_URL, {
    waitUntil: 'load',
    timeout: 90000,
  });

  // Si aparece "Iniciar sesión", lanzamos el flujo de Google
  try {
    const mustLogin =
      (await page.locator(SELECTORS.signin.join(',')).count()) > 0 ||
      /accounts\.google\.com/i.test(page.url());

    if (mustLogin) {
      // Click en "Iniciar sesión" si estamos en la landing
      await clickIfVisible(page, SELECTORS.signin, 4000);

      // Puede abrir la auth en la misma pestaña o navegación
      const authPage =
        /accounts\.google\.com/i.test(page.url())
          ? page
          : await Promise.race([
              context
                .waitForEvent('page', {
                  timeout: 30000,
                  predicate: (p) => /accounts\.google\.com/i.test(p.url()),
                })
                .catch(() => null),
              (async () => {
                try {
                  await page.waitForNavigation({
                    url: /accounts\.google\.com/i,
                    waitUntil: 'domcontentloaded',
                    timeout: 30000,
                  });
                  return page;
                } catch {
                  return null;
                }
              })(),
            ]);

      if (authPage) {
        await handleGoogleLogin(authPage, context);
      }
    }
  } catch (e) {
    console.log('ℹ️ Login flow fallback:', e.message);
  }

  // Esperar a que cargue el editor (o al menos el contenedor)
  try {
    await page.waitForSelector(SELECTORS.textareaEditable.join(','), { timeout: 45000 });
  } catch {
    // A veces tarda en aplicar la UI tras login; un reload ayuda
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForSelector(SELECTORS.textareaEditable.join(','), { timeout: 45000 });
  }

  return { browser, context, page };
}

// ---------- prompt + adjuntar audio + enviar ----------
async function sendPromptWithAudio(mp3Path, promptText = 'Resúmeme diciéndome lo más importante de este audio') {
  if (!fs.existsSync(mp3Path)) {
    throw new Error(`No existe el archivo de audio: ${mp3Path}`);
  }

  const { browser, context, page } = await openGemini();

  // 1) Escribir el prompt en el rich-textarea
  const ta = page.locator(SELECTORS.textareaEditable.join(',')).first();
  await ta.click({ delay: 40 });
  await ta.type(promptText, { delay: 10 });

  // 2) Intentar adjuntar el audio: primero buscar directamente un input[type=file]
  async function trySetInput() {
    for (const sel of SELECTORS.fileInputs) {
      const inp = page.locator(sel).first();
      try {
        if (await inp.count()) {
          await inp.setInputFiles(mp3Path);
          console.log(`📎 Audio adjuntado vía selector: ${sel}`);
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Abrir el diálogo de adjuntar si el input está oculto
  if (!(await trySetInput())) {
    await clickIfVisible(page, SELECTORS.attachButtons, 2500);
    // Si la UI tarda en crear el input, damos un respiro y reintentamos
    await page.waitForTimeout(800);
    if (!(await trySetInput())) {
      console.warn('⚠️ No se localizó un input[type="file"] tras pulsar adjuntar. La UI podría ser drag&drop only.');
      // Si fuera necesario, aquí implementaríamos un fallback de drag&drop.
    }
  }

  // 3) Enviar (botón "Enviar" / "Send")
  await clickIfVisible(page, SELECTORS.sendButtons, 4000);

  // 4) (Opcional) esperar a que el mensaje aparezca en el chat o a un estado de “procesando…”
  try {
    await page.waitForSelector('text=/procesando|thinking|analizando/i', { timeout: 15000 }).catch(() => {});
  } catch {}

  // No cerramos por si quieres inspeccionar; si prefieres cerrarlo, descomenta:
  // await browser.close();

  return { ok: true };
}

module.exports = {
  openGemini,
  sendPromptWithAudio,
};
