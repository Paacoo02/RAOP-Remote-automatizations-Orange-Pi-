// auto_log_in.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// === Carpeta fija (u/1) ===
const FIXED_FOLDER_URL = 'https://drive.google.com/drive/u/1/folders/1YROi4erJExtApAxCPbm9G0gjAHPPs8ir';

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
    executablePath: chromium.executablePath(),
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

// ---------- goto con reintentos (lo exportamos) ----------
async function gotoWithRetry(context, pageRef, url, opts = {}) {
  const max = 3;
  for (let i = 1; i <= max; i++) {
    const page = await ensurePage(context, pageRef);
    try {
      console.log(`➡️  goto attempt ${i}: ${url}`);
      await page.goto(url, { waitUntil: 'commit', timeout: 60000, ...opts }); // 👈 'commit' aquí
      return page;
    } catch (e) {
      console.log(`⚠️ goto error intento ${i}: ${e.message}`);
      if (!pageRef.page || pageRef.page.isClosed()) await ensurePage(context, pageRef);
      if (i === max) throw e;
      try { await pageRef.page.waitForTimeout(1500); } catch {}
    }
  }
}

// ---------- login (igual que ya tienes) ----------
async function handleGoogleLogin(authPage, context) {
  const EMAIL = process.env.GOOGLE_USER || 'pacoplanestomas';
  const PASS  = process.env.GOOGLE_PASS  || '392002Planes0.';
  console.log('🔐 Iniciando flujo de login…');

  if (!/accounts\.google\.com/.test(authPage.url())) {
    await authPage.goto(
      'https://accounts.google.com/v3/signin/identifier?service=wise&hl=en&flowName=GlifWebSignIn&flowEntry=ServiceLogin&continue=https%3A%2F%2Fdrive.google.com%2Fdrive%2Fmy-drive',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
  }

  const emailBox = authPage
    .getByLabel(/Email|Correo|Phone|Teléfono/i)
    .or(authPage.locator('#identifierId:visible, input[name="identifier"]:visible, input[type="email"]:visible'))
    .first();
  await emailBox.waitFor({ state: 'visible', timeout: 20000 });
  await emailBox.click();
  await emailBox.fill('');
  await emailBox.type(EMAIL, { delay: 60 });

  const nextId = authPage.locator('#identifierNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible').first();
  await nextId.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([authPage.waitForLoadState('domcontentloaded'), nextId.click()]);

  await Promise.race([
    authPage.waitForURL(/(signin\/v2\/sl\/pwd|signin\/challenge\/pwd)/i, { timeout: 30000 }),
    authPage.locator('input[type="password"]:visible, input[name="Passwd"]:visible').waitFor({ timeout: 30000 })
  ]).catch(() => {});

  const passBox = authPage.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first();
  await passBox.waitFor({ state: 'visible', timeout: 30000 });
  await passBox.click();
  await passBox.fill('');
  await passBox.type(PASS, { delay: 50 });

  const nextPwd = authPage.locator('#passwordNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible').first();
  await nextPwd.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([authPage.waitForLoadState('domcontentloaded'), nextPwd.click()]);

  // Redirección
  const ctx = authPage.context();
  try {
    await authPage.waitForURL(/drive\.google\.com/i, { timeout: 60000 });
    console.log('✅ Login correcto (misma pestaña)');
    await saveSession(context);
    return;
  } catch {}

  const drivePage =
    ctx.pages().find(p => /drive\.google\.com/i.test(p.url())) ||
    (await ctx.waitForEvent('page', { timeout: 60000, predicate: p => /drive\.google\.com/i.test(p.url()) }).catch(() => null));

  if (drivePage) {
    console.log('✅ Login correcto (otra pestaña):', drivePage.url());
    await saveSession(context);
  } else {
    console.log('⚠️ No se detectó Drive tras login (posible 2FA/captcha).');
  }
}

async function saveSession(context) {
  try {
    const cookies = await context.cookies();
    const storage = await context.storageState();
    const sessionData = { cookies, storage, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'google_session.json'), JSON.stringify(sessionData, null, 2));
    console.log('💾 Sesión guardada en google_session.json');
  } catch (e) { console.log('⚠️ saveSession:', e.message); }
}

async function attemptGoogleLogin() {
  const { browser, context, pageRef } = await createUndetectableBrowser();

  console.log('🎯 Iniciando navegación a Google Drive…');
  await gotoWithRetry(context, pageRef, 'https://drive.google.com');
  try { await pageRef.page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}

  const url = pageRef.page.url();
  if (url.includes('accounts.google.com')) {
    console.log('🔐 Login en misma pestaña');
    await handleGoogleLogin(pageRef.page, context);

  } else if (url.includes('drive.google.com') || url.includes('workspace.google.com')) {
    console.log('📁 En Drive/Workspace, comprobando login…');
    const btnSelectors = ['text=Sign in', 'text=Acceder', 'text=Go to Drive', 'text=Ir a Drive'];
    for (const sel of btnSelectors) {
      const btn = await pageRef.page.$(sel);
      if (!btn) continue;
      console.log(`🔘 Botón encontrado (${sel}), pulsando…`);

      const [popupOrNav] = await Promise.all([
        Promise.race([
          pageRef.page.context().waitForEvent('page', {
            timeout: 30000,
            predicate: p => p !== pageRef.page && (/accounts\.google\.com/i.test(p.url()) || p.opener() === pageRef.page)
          }).catch(() => null),
          pageRef.page.waitForNavigation({
            url: /accounts\.google\.com/,
            waitUntil: 'domcontentloaded',
            timeout: 60000
          }).then(() => pageRef.page).catch(() => null)
        ]),
        btn.click()
      ]);

      const authPage = popupOrNav || pageRef.page;
      await handleGoogleLogin(authPage, context);
      break;
    }
  }

  // Cierra landing y devuelve pestaña limpia
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  await sleep(5000);
  console.log('✅ Login completado, buscando la pestaña final de Drive...');
  const allPages = await context.pages();
  let drivePage = allPages.find(p => p.url().includes('drive.google.com'));

  if (!drivePage) {
    await pageRef.page.waitForTimeout(2000);
    drivePage = (await context.pages()).find(p => p.url().includes('drive.google.com'));
  }

  if (!drivePage) throw new Error('No se pudo encontrar la página de Google Drive después del login.');

  for (const page of allPages) {
    if (page !== drivePage && !page.isClosed()) { await page.close().catch(() => {}); }
  }
  console.log('🧹 Pestañas innecesarias cerradas.');

  return { browser, context, page: drivePage };
}

/* ========================================================================== */
/* =============== AÑADIDOS ROBUSTOS PARA “SUBIR ARCHIVO” =================== */
/* ========================================================================== */

async function waitForDriveReady(page, timeout = 60000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(()=>{});
  const markers = [
    'div[role="main"]',
    'div[guidedhelpid="drive_main_page"]',
    '#drive_main_page',
    'c-wiz',
  ];
  for (const sel of markers) {
    try { await page.locator(sel).first().waitFor({ state: 'visible', timeout: 15000 }); console.log(`🟢 Ready via ${sel}`); return; } catch {}
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  console.log('🟡 Ready via networkidle');
}

function getNewButton(page) {
  const candidates = [
    '[guidedhelpid="new_menu_button"]',
    'button:has-text("Nuevo")',
    'button:has-text("New")',
    'div[aria-label="Nuevo"]',
    'div[aria-label="New"]',
    'button[aria-label="Nuevo"]',
    'button[aria-label="New"]',
  ];
  return page.locator(candidates.join(', ')).first();
}

async function openNewMenu(page, timeout = 20000) {
  const btn = getNewButton(page);
  await btn.waitFor({ state: 'visible', timeout });
  await btn.scrollIntoViewIfNeeded().catch(()=>{});
  await btn.hover({ trial: true }).catch(()=>{});
  await btn.click();
  const visibleMenu = page.locator('div[role="menu"]:visible').first();
  await visibleMenu.waitFor({ state: 'visible', timeout: 10000 });
  console.log('🟩 Menú "Nuevo" abierto');
  return true;
}

/** Cierra overlays / tooltips que bloqueen y vuelve a intentar foco en el main */
async function clearOverlays(page) {
  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(200).catch(()=>{});
  await page.keyboard.press('Escape').catch(()=>{});
  await page.mouse.click(10, 100).catch(()=>{});
}

/**
 * Dentro del menú visible, localiza y pulsa el item "Subir archivo".
 * Evita nodos aria-hidden / aria-disabled.
 */
async function clickUploadFileItem(page) {
  const menu = page.locator('div[role="menu"]:visible').first();
  await menu.waitFor({ state: 'visible', timeout: 10000 });

  const item = menu.locator([
    'div[role="menuitem"][aria-hidden="false"][aria-disabled="false"]:has-text("Subir archivo")',
    'div[role="menuitem"][aria-hidden="false"][aria-disabled="false"]:has-text("File upload")',
    'div[role="menuitem"]:not([aria-hidden="true"]):not([aria-disabled="true"]):has-text("Subir archivo")',
    'div[role="menuitem"]:not([aria-hidden="true"]):not([aria-disabled="true"]):has-text("File upload")',
    'div.a-v-T[aria-label="Subir archivo"]:visible',
    'div.a-v-T[data-tooltip="Subir archivo"]:visible'
  ].join(', ')).first();

  await item.waitFor({ state: 'visible', timeout: 10000 });
  await item.hover({ trial: true }).catch(()=>{});
  await item.scrollIntoViewIfNeeded().catch(()=>{});
  await item.click();
  console.log('📤 Click en "Subir archivo"');
}

/** Fallback: localizar el <input type="file"> y cargar ahí el archivo */
async function trySetInputFilesFallback(page, fileSpec, timeout = 7000) {
  const input = page.locator('input[type="file"]').first();
  try {
    await input.waitFor({ state: 'attached', timeout });
    await page.setInputFiles('input[type="file"]', fileSpec);
    console.log('🪄 Fallback: setInputFiles directo en <input[type=file]>');
    return true;
  } catch {
    return false;
  }
}

/**
 * Sube un archivo a la carpeta FIJA (u/1).
 * Fuerza el nombre a "Video.mp4".
 */
async function uploadFileToSpecificFolderUI(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Archivo no existe: ${filePath}`);

  const { browser, context, page } = await attemptGoogleLogin();
  try {
    const targetUrl = FIXED_FOLDER_URL.includes('?') ? `${FIXED_FOLDER_URL}&hl=es` : `${FIXED_FOLDER_URL}?hl=es`;
    await gotoWithRetry(context, { page }, targetUrl);
    console.log('📌 En carpeta fija u/1');
    await waitForDriveReady(page);

    // Asegurar foco y limpiar overlays
    await clearOverlays(page);

    const attempts = 3;
    const desiredName = 'Video.mp4';
    const fileBuffer = fs.readFileSync(filePath);
    const fileSpec = { name: desiredName, mimeType: 'video/mp4', buffer: fileBuffer };

    let uploaded = false;
    for (let i = 1; i <= attempts; i++) {
      try {
        // 1) Menú "Nuevo" → "Subir archivo"
        await openNewMenu(page, 25000);

        const chooserPromise = page.waitForEvent('filechooser', { timeout: 25000 });
        await clickUploadFileItem(page);

        let fileChooser = null;
        try {
          fileChooser = await chooserPromise;
        } catch {
          console.log('⏱️ No llegó filechooser tras click; probamos atajo Shift+u…');
        }

        // 2) Fallback #1: atajo Shift+u
        if (!fileChooser) {
          await page.keyboard.press('Shift+u').catch(()=>{});
          try {
            fileChooser = await page.waitForEvent('filechooser', { timeout: 4000 });
            console.log('⌨️  filechooser vía Shift+u');
          } catch {}
        }

        // 3) Fallback #2: inyección directa
        if (!fileChooser) {
          const ok = await trySetInputFilesFallback(page, fileSpec, 7000);
          if (!ok) throw new Error('Ni filechooser ni input[type=file] disponibles.');
          uploaded = true;
        } else {
          await fileChooser.setFiles(fileSpec); // 👈 nombre forzado Video.mp4
          uploaded = true;
        }

        if (uploaded) {
          console.log('⬆️ Subida iniciada…');
          break;
        }
      } catch (e) {
        console.log(`⚠️ Fallo al iniciar subida (intento ${i}/${attempts}): ${e.message}`);
        await page.keyboard.press('Escape').catch(()=>{});
        await page.waitForTimeout(600);
      }
    }

    if (!uploaded) throw new Error('No se pudo iniciar la subida tras varios intentos.');

    // Esperar fin de subida (por toast o aparición del item con nombre forzado)
    await page.waitForTimeout(1200);
    await Promise.race([
      page.locator('div[role="alert"]:has-text("Subida completada")').waitFor({ timeout: 180000 }),
      page.locator('div[role="alert"]:has-text("Upload complete")').waitFor({ timeout: 180000 }),
      page.locator(`div[role="gridcell"][aria-label*="${desiredName}"]`).first().waitFor({ timeout: 180000 })
    ]).catch(()=>{});
    console.log('✅ Subida detectada');

    // Intentar fileId (best-effort)
    let fileId = null;
    const cell = page.locator(`div[role="gridcell"][aria-label*="${desiredName}"]`).first();
    if (await cell.count()) {
      await cell.click({ button: 'right' }).catch(()=>{});
      const detailsSel = [
        'div[role="menuitem"]:has-text("Ver detalles")',
        'div[role="menuitem"]:has-text("Detalles")',
        'div[role="menuitem"]:has-text("View details")',
        'div[role="menuitem"]:has-text("Details")',
      ].join(', ');
      const detailsBtn = page.locator(detailsSel).first();
      if (await detailsBtn.count()) {
        await detailsBtn.click().catch(()=>{});
        const openLink = page.locator('a[href*="/file/d/"]').first();
        if (await openLink.count()) {
          const href = await openLink.getAttribute('href').catch(()=>null);
          const m = href && href.match(/\/file\/d\/([^/]+)/);
          if (m) fileId = m[1];
        }
      }
    }

    const webViewLink = fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
    const webContentLink = fileId ? `https://drive.google.com/uc?id=${fileId}&export=download` : null;

    return { ok: true, name: desiredName, id: fileId, webViewLink, webContentLink };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/**
 * Alias compatible con llamadas existentes.
 * Ignoramos opts.folderUrl y usamos siempre la carpeta u/1 fija.
 */
async function uploadFileToDriveUI(filePath, opts = {}) {
  return uploadFileToSpecificFolderUI(filePath);
}

module.exports = {
  attemptGoogleLogin,
  handleGoogleLogin,
  createUndetectableBrowser,
  gotoWithRetry,          // 👈 export original
  uploadFileToSpecificFolderUI,  // 👈 NUEVO
  uploadFileToDriveUI,           // 👈 ALIAS para compatibilidad
};
