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
    executablePath: chromium.executablePath?.() || undefined,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--mute-audio','--disable-gpu','--disable-quic','--no-first-run',
      '--no-default-browser-check','--window-size=1920,1080','--force-dark-mode',
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

// ---------- goto con reintentos ----------
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

// ---------- flujo Riverside base ----------
async function openRiversideTranscription() {
  const { browser, context, pageRef } = await createUndetectableBrowser();
  const page = await gotoWithRetry(context, pageRef, 'https://riverside.com/transcription#');

  // Cookies (best-effort)
  try {
    const acceptButtons = [
      'button:has-text("Accept all")', 'button:has-text("Accept")',
      'text=Accept all', 'text=Accept'
    ];
    for (const sel of acceptButtons) {
      const b = await page.$(sel);
      if (b) { await b.click({ timeout: 2000 }).catch(()=>{}); break; }
    }
  } catch {}

  // Click "Transcribe now"
  const transcribeBtn = page.locator('#transcribe-main').first();
  await transcribeBtn.waitFor({ state: 'visible', timeout: 20000 });
  console.log('🟣 Pulsando "Transcribe now"…');
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(()=>{}),
    transcribeBtn.click()
  ]);

  return { browser, context, page };
}

// ---------- NUEVO: subir MP3 + aceptar + start ----------
async function transcribeMp3(mp3Path) {
  if (!fs.existsSync(mp3Path)) throw new Error(`MP3 no existe: ${mp3Path}`);

  const { browser, context, page } = await openRiversideTranscription();

  // Intentar encontrar un input file directamente
  async function trySetFiles() {
    const candidates = [
      'input[type="file"]',
      'input[type="file"][accept*="audio"]',
      'input[type="file"][name*="file"]',
      'input[type="file"]#file',
      'input[type="file"][id*="upload"]',
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.count()) {
          await loc.setInputFiles(mp3Path);
          console.log(`📤 Subido vía ${sel}`);
          return true;
        }
      } catch (e) { /* continúa */ }
    }
    return false;
  }

  // A veces hay que pulsar un botón "Upload/Choose" para que aparezca el input
  async function clickUploadOpeners() {
    const openers = [
      'button:has-text("Upload")',
      'button:has-text("Choose file")',
      'button:has-text("Choose a file")',
      'button:has-text("Select file")',
      'text=Upload your audio',
      'text=Drag & drop',
    ];
    for (const sel of openers) {
      const b = page.locator(sel).first();
      if (await b.count()) {
        try { await b.click({ timeout: 2000 }); } catch {}
      }
    }
  }

  // 1) Directo
  if (!(await trySetFiles())) {
    // 2) Intentar abrir el diálogo y reintentar
    await clickUploadOpeners();
    await page.waitForTimeout(800);
    if (!(await trySetFiles())) {
      console.warn('⚠️ No encontré input[type="file"]. Si la UI es puro drag&drop, adaptamos después.');
      // Aquí podríamos implementar una simulación de DnD si hiciera falta.
    }
  }

  // Aceptar casilla si existe
  try {
    const checkbox = page.locator('input[type="checkbox"]').filter({ hasNot: page.locator('[disabled]') }).first();
    if (await checkbox.isVisible({ timeout: 3000 })) {
      const checked = await checkbox.isChecked().catch(()=>false);
      if (!checked) {
        await checkbox.check({ force: true }).catch(async () => {
          await checkbox.click({ force: true });
        });
        console.log('☑️  Checkbox marcado');
      }
    }
  } catch {}

  // Start transcribing
  const startBtn = page.locator('#start-transcribing').first();
  await startBtn.waitFor({ state: 'visible', timeout: 30000 });
  console.log('▶️  Pulsando "Start transcribing"…');
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{}),
    startBtn.click()
  ]);

  // (Opcional) Esperar a que aparezca algún estado de “processing”
  try {
    await page.waitForSelector('text=Transcribing', { timeout: 15000 });
    console.log('⏱️ Transcripción arrancada.');
  } catch {}

  // No cierro el browser para poder inspeccionar si quieres; si prefieres:
  // await browser.close();

  return { ok: true };
}

module.exports = {
  createUndetectableBrowser,
  gotoWithRetry,
  ensurePage,
  openRiversideTranscription,
  transcribeMp3,              // ⬅️ export nuevo
};
