// auto_log_in.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

/* ================== CONFIG ================== */
const FIXED_FOLDER_URL = 'https://drive.google.com/drive/u/1/folders/1YROi4erJExtApAxCPbm9G0gjAHPPs8ir';
const DELETE_BEFORE_UPLOAD = true;          // borrar antes para evitar diálogo
const MAKE_LINK_PUBLIC = false;             // poner “Cualquiera con enlace” (opcional)
const DESIRED_NAME = 'video.mp4';

/* ================== PERSISTENT CONTEXT ================== */
const USER_DIR = path.join(os.tmpdir(), 'pw-profile-paco'); // perfil persistente

/* ================== HELPERS BÁSICOS ================== */
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

/* ================== BROWSER INDETECTABLE (PERSISTENTE) ================== */
async function createUndetectableBrowser() {
  console.log('🚀 Creando navegador indetectable (persistent context)…');
  const context = await chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--mute-audio','--disable-gpu','--disable-quic','--no-first-run',
      '--no-default-browser-check','--window-size=1920,1080',
      '--force-dark-mode','--enable-features=WebUIDarkMode',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Europe/Madrid',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });

  await context.addInitScript(() => {
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch {}
    if (!window.chrome) window.chrome = { runtime: {}, app: { isInstalled: false } };
  });

  const pageRef = { page: context.pages()[0] || await context.newPage() };
  await pageRef.page.route('**/*', r => r.continue());
  attachPageResilience(context, pageRef);

  return { browser: context.browser(), context, page: pageRef.page, pageRef };
}

+/* ================== NUEVO: navegador específico para Riverside ================== */
+async function createRiversideBrowser() {    console.log('🚀 Creando navegador (Riverside) con SW habilitados…');
    const profileDir = path.join(os.tmpdir(), 'pw-profile-riverside'); // perfil separado
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      serviceWorkers: 'allow',           // ← clave para uploader moderno
      ignoreHTTPSErrors: true,
      args: [
        '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
        '--disable-background-timer-throttling','--disable-renderer-backgrounding',
        '--mute-audio','--no-first-run','--no-default-browser-check',
        '--window-size=1920,1080',
        '--force-dark-mode','--enable-features=WebUIDarkMode',
        // (opcional) mantenemos GPU desactivada en Xvfb: '--disable-gpu',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      extraHTTPHeaders: { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' }
    });
  
    await context.addInitScript(() => {
      try { delete Object.getPrototypeOf(navigator).webdriver; } catch {}
      if (!window.chrome) window.chrome = { runtime: {}, app: { isInstalled: false } };
    });
  
    const pageRef = { page: context.pages()[0] || await context.newPage() };
    await pageRef.page.route('**/*', r => r.continue());
    attachPageResilience(context, pageRef);
  
    return { browser: context.browser(), context, page: pageRef.page, pageRef };
  }

/* ================== GOTO CON REINTENTOS ================== */
async function gotoWithRetry(context, pageRef, url, opts = {}) {
  const max = 3;
  for (let i = 1; i <= max; i++) {
    const page = await ensurePage(context, pageRef);
    try {
      console.log(`➡️  goto attempt ${i}: ${url}`);
      await page.goto(url, { waitUntil: 'commit', timeout: 60000, ...opts });
      return page;
    } catch (e) {
      console.log(`⚠️ goto error intento ${i}: ${e.message}`);
      if (!pageRef.page || pageRef.page.isClosed()) await ensurePage(context, pageRef);
      if (i === max) throw e;
      try { await pageRef.page.waitForTimeout(1500); } catch {}
    }
  }
}

/* ================== LOGIN GOOGLE ================== */
async function handleGoogleLogin(authPage, context) {
  const EMAIL = process.env.GOOGLE_USER || 'pacoplanestomas';
  const PASS  = process.env.GOOGLE_PASS  || '392002Planes0.';
  console.log('🔐 Iniciando flujo de login…');

  if (!/accounts\.google\.com/.test(authPage.url())) {
    await authPage.goto(
      'https://accounts.google.com/v3/signin/identifier?service=wise&hl=es&flowName=GlifWebSignIn&flowEntry=ServiceLogin&continue=https%3A%2F%2Fdrive.google.com%2Fdrive%2Fmy-drive',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
  }

  const emailBox = authPage
    .getByLabel(/Email|Correo|Phone|Teléfono/i)
    .or(authPage.locator('#identifierId:visible, input[name="identifier"]:visible, input[type="email"]:visible'))
    .first();
  await emailBox.waitFor({ state: 'visible', timeout: 20000 });
  await emailBox.click();
  await emailBox.type(EMAIL, { delay: 60 });

  const nextId = authPage.locator('#identifierNext:visible, div[role="button"]:has-text("Siguiente"), div[role="button"]:has-text("Next")').first();
  await nextId.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([authPage.waitForLoadState('domcontentloaded'), nextId.click()]);

  await Promise.race([
    authPage.waitForURL(/(signin\/v2\/sl\/pwd|signin\/challenge\/pwd)/i, { timeout: 30000 }),
    authPage.locator('input[type="password"]:visible, input[name="Passwd"]:visible').waitFor({ timeout: 30000 })
  ]).catch(() => {});

  const passBox = authPage.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first();
  await passBox.waitFor({ state: 'visible', timeout: 30000 });
  await passBox.click();
  await passBox.type(PASS, { delay: 50 });

  const nextPwd = authPage.locator('#passwordNext:visible, div[role="button"]:has-text("Siguiente"), div[role="button"]:has-text("Next")').first();
  await nextPwd.waitFor({ state: 'visible', timeout: 15000 });
  await Promise.all([authPage.waitForLoadState('domcontentloaded'), nextPwd.click()]);

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
    const btnSelectors = ['text=Sign in','text=Acceder','text=Go to Drive','text=Ir a Drive'];
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
            url: /accounts\.google\.com/, waitUntil: 'domcontentloaded', timeout: 60000
          }).then(() => pageRef.page).catch(() => null)
        ]),
        btn.click()
      ]);
      const authPage = popupOrNav || pageRef.page;
      await handleGoogleLogin(authPage, context);
      break;
    }
  }
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  await sleep(5000);
  console.log('✅ Login completado, buscando la pestaña final de Drive...');
  const allPages = await context.pages();
  let drivePage = allPages.find(p => p.url().includes('drive.google.com'));
  if (!drivePage) {
    await pageRef.page.waitForTimeout(2000);
    drivePage = (await context.pages()).find(p => p.url().includes('drive.google.com'));
  }
  if (!drivePage) throw new Error('No se pudo encontrar la página de Google Drive después del login.');
  for (const page of allPages) if (page !== drivePage && !page.isClosed()) await page.close().catch(()=>{});
  console.log('🧹 Pestañas innecesarias cerradas.');
  return { browser, context, page: drivePage };
}

/* ================== UTILIDADES DRIVE ================== */
async function waitForDriveReady(page, timeout = 60000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(()=>{});
  const markers = ['div[role="main"]','div[guidedhelpid="drive_main_page"]','#drive_main_page','c-wiz'];
  for (const sel of markers) {
    try { await page.locator(sel).first().waitFor({ state: 'visible', timeout: 15000 }); console.log(`🟢 Ready via ${sel}`); return; } catch {}
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  console.log('🟡 Ready via networkidle');
}
function getNewButton(page) {
  const candidates = [
    '[guidedhelpid="new_menu_button"]','button:has-text("Nuevo")','button:has-text("New")',
    'div[aria-label="Nuevo"]','div[aria-label="New"]','button[aria-label="Nuevo"]','button[aria-label="New"]',
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
async function clearOverlays(page) {
  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(200).catch(()=>{});
  await page.keyboard.press('Escape').catch(()=>{});
  await page.mouse.click(10, 100).catch(()=>{});
}
async function clickUploadFileItem(page) {
  const menu = page.locator('div[role="menu"]:visible').first();
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  const item = menu.locator([
    'div[role="menuitem"][aria-hidden="false"][aria-disabled="false"]:has-text("Subir archivo")',
    'div[role="menuitem"][aria-hidden="false"][aria-disabled="false"]:has-text("File upload")',
    'div[role="menuitem"]:not([aria-hidden="true"]):not([aria-disabled="true"]):has-text("Subir archivo")',
    'div[role="menuitem"]:not([aria-hidden="true"]):not([aria-disabled="true"]):has-text("File upload")',
    'div.a-v-T[aria-label="Subir archivo"]:visible','div.a-v-T[data-tooltip="Subir archivo"]:visible'
  ].join(', ')).first();
  await item.waitFor({ state: 'visible', timeout: 10000 });
  await item.scrollIntoViewIfNeeded().catch(()=>{});
  await item.click();
  console.log('📤 Click en "Subir archivo"');
}
async function trySetInputFilesFallback(page, fileSpec, timeout = 7000) {
  const input = page.locator('input[type="file"]').first();
  try {
    await input.waitFor({ state: 'attached', timeout });
    await page.setInputFiles('input[type="file"]', fileSpec);
    console.log('🪄 Fallback: setInputFiles directo en <input[type=file]>');
    return true;
  } catch { return false; }
}

/* ================== BORRADO PREVIO (opcional) ================== */
async function findRowByName(page, name) {
  const candidates = [
    `div[role="row"]:has([aria-label*="${name}"])`,
    `div[role="gridcell"][aria-label*="${name}"]`,
    `div[aria-label*="${name}"][role="link"]`,
    `div[aria-label*="${name}"]`,
    `div:has-text("${name}")`
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try { await loc.waitFor({ state: 'visible', timeout: 1500 }); return loc; } catch {}
  }
  return null;
}
async function openRowOverflowMenu(page, rowLoc) {
  const kebab = rowLoc.locator('div.pYTkkf-c-RLmnJb, button[aria-haspopup="menu"]').first();
  try { await kebab.waitFor({ state: 'visible', timeout: 1500 }); await kebab.click(); return true; } catch {}
  try { await rowLoc.click({ button: 'right' }); return true; } catch {}
  return false;
}
async function clickMoveToTrashInMenu(page) {
  const item = page.locator([
    'div.a-v-T[aria-label="Mover a la papelera"]',
    'div.a-v-T[data-tooltip="Mover a la papelera"]',
    'div[role="menuitem"]:has-text("Mover a la papelera")',
    'div[role="menuitem"]:has-text("Move to trash")',
    'div[aria-label="Move to trash"]'
  ].join(', ')).first();
  await item.waitFor({ state: 'visible', timeout: 4000 });
  await item.click();
  console.log('🗑️  “Mover a la papelera” pulsado');
  const confirm = page.locator('div[role="dialog"]:visible button:has-text("Mover a la papelera"), div[role="dialog"]:visible button:has-text("Move to trash")').first();
  if (await confirm.count()) { await confirm.click().catch(()=>{}); console.log('✅ Confirmación de papelera aceptada'); }
  await page.locator('div[role="alert"]:has-text("papelera"), div[role="alert"]:has-text("trash")').first().waitFor({ timeout: 8000 }).catch(()=>{});
}
async function trashExistingFile(page, name) {
  const row = await findRowByName(page, name);
  if (!row) { console.log(`ℹ️ No se encontró fila para "${name}" (nada que borrar).`); return false; }
  await row.scrollIntoViewIfNeeded().catch(()=>{});
  await row.click({ position: { x: 10, y: 10 } }).catch(()=>{});
  const opened = await openRowOverflowMenu(page, row);
  if (!opened) { console.log('⚠️ No se pudo abrir el menú; probamos tecla Delete…'); await page.keyboard.press('Delete').catch(()=>{}); await page.keyboard.press('Backspace').catch(()=>{}); return true; }
  await clickMoveToTrashInMenu(page).catch(async () => {
    const reopen = await openRowOverflowMenu(page, row);
    if (reopen) await clickMoveToTrashInMenu(page).catch(()=>{});
  });
  return true;
}

/* ================== DIÁLOGO CONFLICTO ================== */
async function handleUploadConflictDialog(page, totalTimeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < totalTimeoutMs) {
    const dialog = page.locator('div[role="dialog"]:visible')
      .filter({ hasText: /Opciones de subida|Upload options|ya está en esta ubicación|already exists/i }).first();
    if (await dialog.count()) {
      try {
        const replaceRadio = dialog.locator('label:has-text("Reemplazar archivo actual"), label:has-text("Replace existing file")').first();
        if (await replaceRadio.count()) await replaceRadio.click().catch(()=>{});
      } catch {}
      try {
        const uploadBtn = dialog.locator('button:has-text("Subir"), div[role="button"]:has-text("Subir"), button:has-text("Upload"), div[role="button"]:has-text("Upload")').last();
        await uploadBtn.click(); console.log('✅ “Subir” confirmado'); return true;
      } catch {}
      await dialog.focus().catch(()=>{});
      await page.keyboard.press('Enter').catch(()=>{});
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

/* ================== ESPERA SUBIDA (MISMO DOM) ================== */
async function waitForUploadedRowSameDOM(page, fileName, timeoutMs = 5 * 60 * 1000) {
  const t0 = Date.now();
  const snooze = (ms) => new Promise(r => setTimeout(r, ms));

  async function nudgeGrid() {
    try {
      const grid = page.locator('[role="main"] [role="grid"]').first();
      if (await grid.count()) {
        await grid.evaluate(el => el.scrollBy(0, 500));
        await snooze(100);
        await grid.evaluate(el => el.scrollBy(0, -500));
      } else {
        await page.mouse.wheel(0, 600).catch(()=>{});
        await snooze(100);
        await page.mouse.wheel(0, -600).catch(()=>{});
      }
    } catch {}
  }

  async function hopRecentsAndBack() {
    try {
      const recent = page.locator('a[aria-label*="Recientes"], a[aria-label*="Recent"]').first();
      if (await recent.count()) {
        await recent.click().catch(()=>{});
        await page.waitForLoadState('domcontentloaded').catch(()=>{});
        await snooze(500);
      }
    } catch {}
    try {
      const url = FIXED_FOLDER_URL.includes('?') ? `${FIXED_FOLDER_URL}&hl=es` : `${FIXED_FOLDER_URL}?hl=es`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForDriveReady(page);
    } catch {}
  }

  async function findDivRow() {
    return await page.evaluate((name) => {
      const norm = (s)=> (s||'').toLowerCase();
      const wanted = norm(name);
      const rows = Array.from(document.querySelectorAll('div[role="row"]'));
      for (const r of rows) {
        const text = norm((r.getAttribute('aria-label') || '') + ' ' + (r.innerText || ''));
        if (!text.includes(wanted)) continue;

        if (r.querySelector('[role="progressbar"], [aria-busy="true"], [aria-live="polite"]')) continue;

        const hasName =
          !!r.querySelector('strong.DNoYtb') ||
          !!r.querySelector(`[aria-label*="${name}"]`) ||
          text.includes(wanted);

        if (!hasName) continue;

        const dataId = r.getAttribute('data-id') || '';
        return { dataId, html: r.outerHTML };
      }
      return null;
    }, fileName).catch(()=>null);
  }

  await snooze(1200);
  let cycles = 0;

  while (Date.now() - t0 < timeoutMs) {
    const info = await findDivRow();
    if (info) {
      let row;
      if (info.dataId) {
        row = page.locator(`div[role="row"][data-id="${info.dataId}"]`).first();
      } else {
        row = page.locator(`div[role="row"]:has([aria-label*="${fileName}"]), div[role="row"]:has-text("${fileName}")`).first();
      }
      try { await row.waitFor({ state: 'visible', timeout: 4000 }); } catch {}
      return { fileId: info.dataId || null, row };
    }

    cycles++;
    if (cycles % 6 === 2) await nudgeGrid();
    if (cycles % 10 === 0) await hopRecentsAndBack();
    await snooze(300);
  }

  throw new Error(`Timeout esperando fila subida (DOM div[role="row"]) para "${fileName}".`);
}

// Variante usada por uploadFileToSpecificFolderUI
async function waitUntilUploadedUsingSameDOM(page, name, {
  maxMs = 5 * 60 * 1000,
  pollMs = 300
} = {}) {
  const t0 = Date.now();
  let cycles = 0;

  const snooze = (ms) => new Promise(r => setTimeout(r, ms));
  const nudgeGrid = async () => {
    try {
      const grid = page.locator('[role="main"] [role="grid"]').first();
      if (await grid.count()) {
        await grid.evaluate(el => el.scrollBy(0, 600));
        await snooze(60);
        await grid.evaluate(el => el.scrollBy(0, -600));
      } else {
        await page.mouse.wheel(0, 600).catch(()=>{});
        await snooze(60);
        await page.mouse.wheel(0, -600).catch(()=>{});
      }
    } catch {}
  };

  const appearsNow = async () => {
    return await page.evaluate((fileName) => {
      const norm = (s)=> (s||'').toLowerCase();
      const wanted = norm(fileName);
      const main = document.querySelector('div[role="main"]');
      if (!main) return null;

      const rows = Array.from(main.querySelectorAll('div[role="row"]'));
      for (const r of rows) {
        const text = norm((r.getAttribute('aria-label') || '') + ' ' + (r.textContent || ''));
        if (!text.includes(wanted)) continue;
        if (r.querySelector('[role="progressbar"], [aria-busy="true"], [aria-live="polite"]')) continue;
        return { id: r.getAttribute('data-id') || null };
      }
      const cells = Array.from(main.querySelectorAll('div[role="gridcell"][aria-label]'));
      for (const c of cells) {
        const text = norm(c.getAttribute('aria-label') || '');
        if (!text.includes(wanted)) continue;
        if (c.querySelector('[role="progressbar"], [aria-busy="true"], [aria-live="polite"]')) continue;
        const host = c.closest('[data-id]') || c;
        return { id: host.getAttribute('data-id') || null };
      }
      const any = Array.from(main.querySelectorAll('[aria-label]'));
      for (const el of any) {
        const text = norm(el.getAttribute('aria-label') || '');
        if (!text.includes(wanted)) continue;
        if (el.querySelector && el.querySelector('[role="progressbar"], [aria-busy="true"], [aria-live="polite"]')) continue;
        const host = el.closest('[data-id]') || el;
        return { id: host.getAttribute('data-id') || null };
      }
      return null;
    }, name).catch(()=>null);
  };

  while (Date.now() - t0 < maxMs) {
    const info = await appearsNow();
    if (info) {
      const row = info.id
        ? page.locator(`[data-id="${info.id}"]`).first()
        : (await findRowByName(page, name)) || page.locator(`div[role="row"]:has-text("${name}")`).first();
      try { await row.waitFor({ state: 'visible', timeout: 3000 }); } catch {}
      console.log(`✅ (SAME-DOM) Detectado "${name}" ${info.id ? `(id=${info.id})` : '(sin data-id)'}`);
      return { fileId: info.id || null, row };
    }
    cycles++;
    if (cycles % 6 === 2) await nudgeGrid();
    await snooze(pollMs);
  }

  throw new Error(`Timeout esperando subida de "${name}" con el mismo DOM (sin navegación).`);
}

/* ================== VERIFICACIONES / SHARE ================== */
async function getDisplayedNameFromRow(page, row) {
  try {
    const name = await row.evaluate((el) => {
      const strong = el.querySelector('strong.DNoYtb');
      if (strong) return strong.textContent.trim();
      const attrName = el.getAttribute('aria-label') || '';
      if (attrName) return attrName;
      const cell = el.querySelector('[role="gridcell"][aria-label]');
      if (cell) return (cell.getAttribute('aria-label') || '').trim();
      return (el.innerText || '').trim();
    });
    return (name || '').trim();
  } catch { return null; }
}
async function verifyInRecents(page, name, timeoutMs = 8000) {
  try {
    const recent = page.locator('a[aria-label*="Recientes"], a[aria-label*="Recent"]').first();
    if (await recent.count()) {
      await recent.click().catch(()=>{});
      await page.waitForLoadState('domcontentloaded').catch(()=>{});
      const item = page.locator(
        `div[role="gridcell"][aria-label*="${name}"], div[role="row"]:has([aria-label*="${name}"]), div[aria-label*="${name}"]`
      ).first();
      await item.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    }
  } catch {}
  return false;
}
async function makeAnyoneWithLinkViewer(page, row) {
  await row.click({ button: 'right' }).catch(()=>{});
  const shareBtn = page.locator([
    'div[role="menuitem"]:has-text("Compartir")',
    'div[role="menuitem"]:has-text("Share")',
    '[aria-label="Compartir"]',
  ].join(', ')).first();
  try { await shareBtn.waitFor({ state: 'visible', timeout: 5000 }); await shareBtn.click(); } catch {
    const topShare = page.locator('div[aria-label="Compartir"], div[aria-label="Share"]').first();
    await topShare.click().catch(()=>{});
  }
  const accessBtn = page.locator('div[role="button"]:has-text("Restringido"), div[role="button"]:has-text("Restricted")').first();
  if (await accessBtn.count()) await accessBtn.click().catch(()=>{});
  const anyoneItem = page.locator('div[role="menuitem"]:has-text("Cualquier persona con el enlace"), div[role="menuitem"]:has-text("Anyone with the link")').first();
  if (await anyoneItem.count()) await anyoneItem.click().catch(()=>{});
  const roleBtn = page.locator('div[role="button"]:has-text("Lector"), div[role="button"]:has-text("Viewer")').first();
  if (await roleBtn.count()) await roleBtn.click().catch(()=>{});
  const roleViewer = page.locator('div[role="menuitem"]:has-text("Lector"), div[role="menuitem"]:has-text("Viewer")').first();
  if (await roleViewer.count()) await roleViewer.click().catch(()=>{});
  const copyBtn = page.locator('button:has-text("Copiar enlace"), button:has-text("Copy link")').first();
  let link = null;
  if (await copyBtn.count()) {
    await copyBtn.click().catch(()=>{});
    link = await page.locator('input[aria-label*="Enlace"], input[type="text"]').first().inputValue().catch(()=>null);
  }
  await page.keyboard.press('Escape').catch(()=>{});
  return link;
}

async function ensureFileIdFromRow(page, row) {
  try {
    const hasId = await row.getAttribute('data-id');
    if (hasId) return hasId;
  } catch {}

  try {
    await row.scrollIntoViewIfNeeded().catch(()=>{});
    await row.click({ position: { x: 10, y: 10 } }).catch(()=>{});
    await row.dblclick().catch(async () => { await page.keyboard.press('Enter').catch(()=>{}); });

    await page.waitForURL(/\/file\/d\//, { timeout: 15000 });
    const m = page.url().match(/\/file\/d\/([^/]+)/);
    const id = m ? m[1] : null;

    try { await page.keyboard.press('Escape'); await waitForDriveReady(page); } catch {}
    return id;
  } catch {
    return null;
  }
}

/* ================== SUBIR ARCHIVO (UI) ================== */
async function uploadFileToSpecificFolderUI(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`Archivo no existe: ${filePath}`);

  const { browser, context, page } = await attemptGoogleLogin();
  let keepOpen = !!opts.keepDriveOpen;

  const targetUrl = FIXED_FOLDER_URL.includes('?') ? `${FIXED_FOLDER_URL}&hl=es` : `${FIXED_FOLDER_URL}?hl=es`;
  await gotoWithRetry(context, { page }, targetUrl);
  console.log('📌 En carpeta fija u/1');
  await waitForDriveReady(page);
  await clearOverlays(page);

  const desiredName = DESIRED_NAME;

  if (DELETE_BEFORE_UPLOAD) {
    await trashExistingFile(page, desiredName).catch(()=>{});
    await page.waitForTimeout(800).catch(()=>{});
  }

  const attempts = 3;
  const fileBuffer = fs.readFileSync(filePath);
  const fileSpec = { name: desiredName, mimeType: 'video/mp4', buffer: fileBuffer };

  let uploadedTrigger = false;

  for (let i = 1; i <= attempts; i++) {
    try {
      await openNewMenu(page, 25000);
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 25000 });
      await clickUploadFileItem(page);

      let fileChooser = null;
      try { fileChooser = await chooserPromise; } catch { console.log('⏱️ Sin filechooser; probamos Shift+u…'); }

      if (!fileChooser) {
        await page.keyboard.press('Shift+u').catch(()=>{});
        try {
          fileChooser = await page.waitForEvent('filechooser', { timeout: 4000 });
          console.log('⌨️  filechooser vía Shift+u');
        } catch {}
      }

      if (!fileChooser) {
        const ok = await trySetInputFilesFallback(page, fileSpec, 7000);
        if (!ok) throw new Error('Ni filechooser ni input[type=file] disponibles.');
      } else {
        await fileChooser.setFiles(fileSpec);
      }

      uploadedTrigger = true;
      console.log('⬆️ Subida iniciada…');

      if (!DELETE_BEFORE_UPLOAD) await handleUploadConflictDialog(page, 20000);
      break;
    } catch (e) {
      console.log(`⚠️ Fallo al iniciar subida (intento ${i}/${attempts}): ${e.message}`);
      await page.keyboard.press('Escape').catch(()=>{});
      await page.waitForTimeout(600);
    }
  }

  if (!uploadedTrigger) throw new Error('No se pudo iniciar la subida tras varios intentos.');
  if (!DELETE_BEFORE_UPLOAD) await handleUploadConflictDialog(page, 8000).catch(()=>{});

  const { fileId: maybeId, row } =
    await waitUntilUploadedUsingSameDOM(page, DESIRED_NAME, { maxMs: 5*60*1000, pollMs: 300 });

  const fileId = maybeId || await ensureFileIdFromRow(page, row);
  if (!fileId) console.warn('⚠️ No se pudo extraer fileId (continuamos).');

  let displayedName = DESIRED_NAME;
  try {
    displayedName = (await getDisplayedNameFromRow(page, row).catch(()=>null)) || DESIRED_NAME;
  } catch {}

  let shareLink = null;
  if (MAKE_LINK_PUBLIC && row) {
    try { shareLink = await makeAnyoneWithLinkViewer(page, row); } catch {}
  }

  const result = {
    ok: true,
    name: DESIRED_NAME,
    displayedName,
    verified: true,
    verifyMethod: 'same-dom-loop',
    id: fileId || null
  };
  if (fileId) {
    result.webViewLink    = `https://drive.google.com/file/d/${fileId}/view`;
    result.webContentLink = `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  result.shareLink = shareLink || null;

  console.log('🏁 Final:', result);

  if (opts && opts.keepDriveOpen) {
    return { ...result, context, page };   // ← devolvemos handles vivos
  } else {
    try { await context.close(); } catch {}
    return result;
  }
}

/* ================== NUEVO: cambiar a pestaña Videos ================== */
async function switchToVideosTab(context) {
  let page = context.pages().find(p => !p.isClosed() && p.url().includes('drive.google.com'));
  if (!page) page = await context.newPage();
  const target = FIXED_FOLDER_URL.includes('?') ? `${FIXED_FOLDER_URL}&hl=es` : `${FIXED_FOLDER_URL}?hl=es`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForDriveReady(page);
  await page.bringToFront();
  console.log('📁 Pestaña Drive posicionada en carpeta "Videos".');
  return page;
}

/* ================== DESCARGA MÉTODO ANTIGUO (via fileId) ================== */
async function downloadAndTrashFile(page, fileName, { destDir = os.tmpdir(), timeoutMs = 120000 } = {}) {
  await waitForDriveReady(page);
  const row = await findRowByName(page, fileName);
  if (!row) throw new Error(`No se encontró "${fileName}" en la carpeta.`);
  const fileId = await ensureFileIdFromRow(page, row);
  if (!fileId) throw new Error(`No se pudo obtener fileId de "${fileName}".`);

  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  console.log(`⬇️ Descargando "${fileName}" desde ${url}`);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: timeoutMs }),
    page.evaluate(u => { const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel='noopener'; document.body.appendChild(a); a.click(); a.remove(); }, url)
  ]);

  const suggested = download.suggestedFilename();
  const targetPath = path.join(destDir, suggested || fileName);
  await download.saveAs(targetPath);
  console.log('💾 Guardado en:', targetPath);

  await trashExistingFile(page, fileName).catch(()=>{});
  console.log(`🗑️ "${fileName}" enviado a la papelera en Drive.`);

  return { path: targetPath, fileId };
}

/* ================== NUEVO: DESCARGA POR MENÚ “Descargar” ================== */
async function clickDownloadInMenu(page) {
  const candidates = [
    // Item de menú contextual / overflow
    'div[role="menuitem"]:has-text("Descargar")',
    'div[role="menuitem"]:has-text("Download")',
    // aria-label o data-tooltip en item
    'div.a-v-T[aria-label="Descargar"]',
    'div.a-v-T[data-tooltip="Descargar"]',
    'div.a-v-T[aria-label="Download"]',
    'div.a-v-T[data-tooltip="Download"]',
    // Botón en toolbar cuando hay fila seleccionada
    'div[aria-label="Descargar"]:not([aria-disabled="true"])',
    'div[aria-label="Download"]:not([aria-disabled="true"])',
    'button:has-text("Descargar")',
    'button:has-text("Download")',
  ];
  const loc = page.locator(candidates.join(', ')).first();
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  await loc.scrollIntoViewIfNeeded().catch(()=>{});
  await loc.click();
  console.log('⬇️  Click en "Descargar" (menú).');
}

async function downloadAndTrashFileViaMenu(page, fileName, { destDir = os.tmpdir(), timeoutMs = 120000 } = {}) {
  await waitForDriveReady(page);

  // 1) localizar la fila
  const row = await findRowByName(page, fileName);
  if (!row) throw new Error(`No se encontró "${fileName}" en la carpeta.`);

  await row.scrollIntoViewIfNeeded().catch(()=>{});
  // Seleccionar la fila (habilita toolbar por si overflow falla)
  await row.click({ position: { x: 10, y: 10 } }).catch(()=>{});

  // 2) abrir el menú “kebab” o menú contextual
  const opened = await openRowOverflowMenu(page, row);
  if (!opened) {
    // si el kebab falla, intenta desde toolbar directa “Descargar”
    console.log('⚠️ No se pudo abrir overflow; probamos toolbar directa.');
  }

  // 3) preparar espera de descarga y pulsar “Descargar”
  const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
  try {
    await clickDownloadInMenu(page);
  } catch (e) {
    // si no hubo item en overflow, reintenta con la toolbar
    console.log('↪️ Reintento: buscar botón de "Descargar" en toolbar…');
    await clickDownloadInMenu(page); // mismo helper cubre toolbar
  }

  const download = await downloadPromise; // espera el archivo
  const suggested = download.suggestedFilename();
  const targetPath = path.join(destDir, suggested || fileName);
  await download.saveAs(targetPath);
  console.log('💾 Guardado en:', targetPath);

  // 4) enviar a papelera el archivo (reutiliza tu lógica)
  await trashExistingFile(page, fileName).catch(()=>{});
  console.log(`🗑️ "${fileName}" enviado a la papelera.`);

  return { path: targetPath, fileId: null, via: 'menu' };
}

/** Alias compatible; siempre carpeta fija u/1 */
async function uploadFileToDriveUI(filePath, opts = {}) {
  return uploadFileToSpecificFolderUI(filePath, opts);
}

module.exports = {
  attemptGoogleLogin,
  handleGoogleLogin,
  createUndetectableBrowser,
  gotoWithRetry,
  uploadFileToSpecificFolderUI,
  uploadFileToDriveUI,
  // pestaña / descarga
  switchToVideosTab,
  downloadAndTrashFile,          // método antiguo
  downloadAndTrashFileViaMenu,   // ← NUEVO método por menú
  clickDownloadInMenu,           // opcional export
  // consts
  FIXED_FOLDER_URL,
  // Helpers exportados:
  waitForDriveReady,
  waitForUploadedRowSameDOM,
  ensureFileIdFromRow,
  findRowByName,
  waitUntilUploadedUsingSameDOM,
  trashExistingFile,
};
