// riverside_auto.js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function createUndetectableBrowser() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--mute-audio','--disable-gpu','--disable-quic','--no-first-run',
      '--no-default-browser-check','--window-size=1920,1080'
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
  const page = await context.newPage();
  await page.route('**/*', r => r.continue());
  return { browser, context, page };
}

async function transcribeMp3(mp3LocalPath) {
  const { browser, context, page } = await createUndetectableBrowser();
  try {
    await page.goto('https://riverside.fm/transcription', { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(()=> page.goto('https://riverside.com/transcription', { waitUntil: 'domcontentloaded', timeout: 60000 }));

    // Aceptar cookies best-effort
    for (const sel of ['button:has-text("Accept all")','button:has-text("Accept")','text=Accept all','text=Accept']) {
      const b = await page.$(sel); if (b) { await b.click({ timeout: 2000 }).catch(()=>{}); break; }
    }

    // Botón "Transcribe now"
    const transcribeBtn = page.locator('#transcribe-main').first();
    if (await transcribeBtn.count()) {
      await transcribeBtn.click().catch(()=>{});
    } else {
      // alternativa: link/botón con texto
      const tBtn = page.locator('text=Transcribe now').first();
      if (await tBtn.count()) await tBtn.click().catch(()=>{});
    }

    // Subida: input[type="file"] si aparece
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(mp3LocalPath);
    } else {
      // fallback: buscar drop area y usar setInputFiles de un input oculto en el DOM
      // muchos sitios inyectan input tras abrir el modal:
      const anyInput = page.locator('input[type="file"]').first();
      await anyInput.waitFor({ timeout: 15000 }).catch(()=>{});
      if (await anyInput.count()) await anyInput.setInputFiles(mp3LocalPath);
    }

    // Marcar consentimiento si hay checkbox
    try {
      const checkbox = page.locator('input[type="checkbox"]').first();
      if (await checkbox.count()) {
        if (!(await checkbox.isChecked().catch(()=>false))) {
          await checkbox.check({ force: true }).catch(()=>checkbox.click({ force: true }));
        }
      }
    } catch {}

    // Start transcribing
    const startBtn = page.locator('#start-transcribing').first()
                    .or(page.locator('button:has-text("Start transcribing")').first());
    if (await startBtn.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{}),
        startBtn.click()
      ]);
    }

    // Espera resultado: intentamos localizar un bloque de texto de transcripción
    let transcript = null;
    await page.waitForTimeout(5000);
    const transcriptNode = page.locator('[data-testid="transcript"], .transcript, [class*="transcript"]').first();
    if (await transcriptNode.count()) {
      try { transcript = await transcriptNode.innerText({ timeout: 10000 }); } catch {}
    }

    // Si no hay, devolvemos estado “started”
    return { transcript: transcript || "", transcriptUrl: page.url(), jobId: null, started: true };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { transcribeMp3 };
