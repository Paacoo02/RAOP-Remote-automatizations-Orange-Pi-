// riverside_auto.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// ---------- helpers ----------
async function ensurePage(context, pageRef) {
  if (pageRef.page && !pageRef.page.isClosed()) return pageRef.page;
  console.log('🆘 Page cerrada; creando una nueva pestaña…');
  pageRef.page = await context.newPage();
  await pageRef.page.route('**/*', r => r.continue());
  attachPageResilience(context, pageRef);
  return pageRef.page;
}

function attachPageResilience(context, pageRef) {
  try { pageRef.page.removeAllListeners('close'); } catch {}
  try { pageRef.page.removeAllListeners('crash'); } catch {}
  pageRef.page.on('crash', async () => {
    console.log('💥 page.crash detectado');
    try { await pageRef.page.close().catch(()=>{}); } catch {}
    await ensurePage(context, pageRef);
  });
}

// ---------- lanzar navegador/contexto ----------
async function createUndetectableBrowser() {
  console.log('🚀 Creando navegador indetectable…');

  const browser = await chromium.launch({
    headless: false,
    // Si tu runtime requiere ruta explícita y la tienes disponible, mantenla:
    executablePath: chromium.executablePath?.() || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--disable-gpu',
      '--disable-quic',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080',
      '--force-dark-mode',
      '--enable-features=WebUIDarkMode',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles'
  });

  await context.addInitScript(() => {
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch {}
    if (!window.chrome) window.chrome = { runtime: {}, app: { isInstalled: false } };
  });

  const pageRef = { page: await context.newPage() };
  await pageRef.page.route('**/*', r => r.continue());
  attachPageResilience(context, pageRef);

  return { browser, context, page: pageRef.page, pageRef };
}

// ---------- goto con reintentos (reutilizado) ----------
async function gotoWithRetry(context, pageRef, url, opts = {}) {
  const max = 3;
  for (let i = 1; i <= max; i++) {
    const page = await ensurePage(context, pageRef);
    try {
      console.log(`➡️  goto attempt ${i}: ${url}`);
      await page.goto(url, { waitUntil: 'load', timeout: 90000, ...opts });
      return page;
    } catch (e) {
      console.log(`⚠️ goto error intento ${i}: ${e.message}`);
      if (!pageRef.page || pageRef.page.isClosed()) await ensurePage(context, pageRef);
      if (i === max) throw e;
      try { await pageRef.page.waitForTimeout(1500); } catch {}
    }
  }
}

// ---------- flujo Riverside: abrir, click "Transcribe now", aceptar, "Start transcribing" ----------
async function openRiversideTranscription() {
  const { browser, context, pageRef } = await createUndetectableBrowser();
  const page = await gotoWithRetry(context, pageRef, 'https://riverside.com/transcription#');

  // 1) Aceptar cookies si hay (best-effort, no rompe si no aparece)
  try {
    const acceptButtons = [
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'text=Accept all',
      'text=Accept'
    ];
    for (const sel of acceptButtons) {
      const b = await page.$(sel);
      if (b) { await b.click({ timeout: 2000 }).catch(()=>{}); break; }
    }
  } catch {}

  // 2) Click "Transcribe now" (id facilitado)
  const transcribeBtn = page.locator('#transcribe-main').first();
  await transcribeBtn.waitFor({ state: 'visible', timeout: 15000 });
  console.log('🟣 Pulsando "Transcribe now"…');
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(()=>{}),
    transcribeBtn.click()
  ]);

  // 3) (Pendiente) Subir/arrastrar MP3 — lo dejamos preparado
  // Cuando lo tengas: usa setInputFiles si existe un <input type="file"> oculto:
  // const fileInput = page.locator('input[type="file"]').first();
  // if (await fileInput.count()) { await fileInput.setInputFiles('/ruta/al/audio.mp3'); }
  // Si fueras a simular drag&drop real, podemos añadirlo luego.

  // 4) Aceptar casilla si existe (buscamos un checkbox visible y lo marcamos)
  try {
    const checkbox = page.locator('input[type="checkbox"]').filter({ hasNot: page.locator('[disabled]') }).first();
    if (await checkbox.isVisible({ timeout: 3000 })) {
      const checked = await checkbox.isChecked().catch(()=>false);
      if (!checked) {
        console.log('☑️  Marcando checkbox de consentimiento…');
        await checkbox.check({ force: true }).catch(async () => {
          await checkbox.click({ force: true });
        });
      }
    } else {
      // A veces la UI usa wrappers; intentamos click por texto estándar
      const consentLabels = [
        'I agree', 'I accept', 'Accept terms', 'Terms', 'I understand'
      ];
      for (const text of consentLabels) {
        const lbl = page.locator(`text=${text}`).first();
        if (await lbl.count()) { await lbl.click({ timeout: 1000 }).catch(()=>{}); break; }
      }
    }
  } catch (e) {
    console.log('ℹ️ No se encontró checkbox de consentimiento visible (continuamos)…');
  }

  // 5) Click "Start transcribing"
  const startBtn = page.locator('#start-transcribing').first();
  await startBtn.waitFor({ state: 'visible', timeout: 20000 });
  console.log('▶️  Pulsando "Start transcribing"…');
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{}),
    startBtn.click()
  ]);

  // Devuelve handles para continuar (subida de archivo, leer estado, etc.)
  return { browser, context, page };
}

module.exports = {
  // reutilizables
  createUndetectableBrowser,
  gotoWithRetry,
  ensurePage,
  // flujo riverside
  openRiversideTranscription,
};
