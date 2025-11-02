// auto_log_in.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// === Carpeta fija (u/1) ===
const FIXED_FOLDER_URL = 'https://drive.google.com/drive/u/1/folders/1YROi4erJExtApAxCPbm9G0gjAHPPs8ir';
const DELETE_BEFORE_UPLOAD = true;        // borrar antes para evitar diálogo
const MAKE_LINK_PUBLIC = false;           // si quieres poner “Cualquiera con enlace”

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
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--mute-audio','--disable-gpu','--disable-quic','--no-first-run',
      '--no-default-browser-check','--window-size=1920,1080',
      '--force-dark-mode','--enable-features=WebUIDarkMode',
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

// ---------- login ----------
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
  await passBox.type(PASS, { delay: 50 });

  const nextPwd = authPage.locator('#passwordNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible').first();
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

/* ========================================================================== */
/* ==================== UTILIDADES DE DRIVE (UI) ============================ */
/* ========================================================================== */
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
    'div.a-v-T[aria-label="Subir archivo"]:visible', 'div.a-v-T[data-tooltip="Subir archivo"]:visible'
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

/* === 3 puntos → mover a papelera === */
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
  const kebab = rowLoc.locator('div.pYTkkf-c-RLmnJb').first();
  const fallbacks = [
    rowLoc.locator('[aria-label*="Más acciones"], [aria-label*="More actions"]').first(),
    rowLoc.locator('button[aria-haspopup="menu"]').first(),
  ];
  try { await kebab.waitFor({ state: 'visible', timeout: 1500 }); await kebab.click(); return true; } catch {}
  for (const fb of fallbacks) { try { await fb.waitFor({ state: 'visible', timeout: 1200 }); await fb.click(); return true; } catch {} }
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
  await clickMoveToTrashInMenu(page).catch(async () => { const reopen = await openRowOverflowMenu(page, row); if (reopen) await clickMoveToTrashInMenu(page).catch(()=>{}); });
  return true;
}

/* === diálogo conflicto (por si no borras antes) === */
async function handleUploadConflictDialog(page, totalTimeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < totalTimeoutMs) {
    const dialog = page.locator('div[role="dialog"]:visible')
      .filter({ hasText: /Opciones de subida|Upload options|ya está en esta ubicación|already exists/i }).first();
    if (await dialog.count()) {
      try { const replaceRadio = dialog.locator('label:has-text("Reemplazar archivo actual"), label:has-text("Replace existing file")').first(); if (await replaceRadio.count()) await replaceRadio.click().catch(()=>{}); } catch {}
      try { const uploadBtn = dialog.locator('button:has-text("Subir"), div[role="button"]:has-text("Subir"), button:has-text("Upload"), div[role="button"]:has-text("Upload")').last(); await uploadBtn.click(); console.log('✅ “Subir” confirmado'); return true; } catch {}
      await dialog.focus().catch(()=>{}); await page.keyboard.press('Enter').catch(()=>{}); return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

/* === ESPERA ROBUSTA DE FIN DE SUBIDA === */
async function waitForUploadFinishRobust(page, name, maxMs = 5 * 60 * 1000) {
  const start = Date.now();

  // Funciones helper usadas dentro del bucle
  const isProgressActive = async () => {
    // chips de progreso / barras / textos “Subiendo…”
    return await page.evaluate(() => {
      const q = (sel)=>Array.from(document.querySelectorAll(sel));
      const chips = q('[aria-live="polite"], [aria-live="assertive"], [role="progressbar"], [class*="upload"]');
      const txt = chips.some(el => /subiendo|uploading|cargando/i.test(el.textContent || ''));
      const bars = q('[role="progressbar"]');
      return txt || bars.length > 0;
    }).catch(()=>false);
  };
  const rowExists = async () => {
    const loc = page.locator(`div[role="gridcell"][aria-label*="${name}"], div[role="row"]:has([aria-label*="${name}"]), div[aria-label*="${name}"]`).first();
    try { await loc.waitFor({ state: 'visible', timeout: 800 }); return loc; } catch { return null; }
  };

  // 1) Espera activa mientras haya progreso; si aparece el toast, mejor
  while (Date.now() - start < maxMs) {
    // ¿apareció el toast de completado?
    const toast = page.locator('div[role="alert"]:has-text("Subida completada"), div[role="alert"]:has-text("Upload complete")').first();
    if (await toast.count()) { console.log('🔔 Toast de completado visto'); break; }

    // ¿ya está la fila?
    const row = await rowExists();
    if (row) { console.log('🧩 Fila encontrada sin toast'); return row; }

    // ¿sigue el progreso?
    if (!(await isProgressActive())) {
      // no parece haber progreso: refuerza con “Recientes” → volver
      console.log('🔄 No hay progreso visible, refrescando vista…');
      await openRecentAndComeBack(page).catch(()=>{});
      const r2 = await rowExists();
      if (r2) return r2;
    }

    await page.waitForTimeout(1000);
  }

  // 2) Último intento: hard refresh de la carpeta
  console.log('♻️  Refrescando carpeta para forzar listado…');
  await page.keyboard.press('ControlOrMeta+R').catch(()=>{});
  await waitForDriveReady(page);
  const last = await rowExists();
  if (last) return last;

  throw new Error('No se encontró el archivo tras la subida.');
}

/* Navega a “Recientes” y vuelve a la carpeta para forzar re-render */
async function openRecentAndComeBack(page) {
  // Abre “Recientes”
  const recent = page.locator('a[aria-label*="Recientes"], a[aria-label*="Recent"]').first();
  if (await recent.count()) {
    await recent.click().catch(()=>{});
    await page.waitForLoadState('domcontentloaded').catch(()=>{});
    await page.waitForTimeout(800).catch(()=>{});
  }
  // Vuelve usando la URL actual de la carpeta
  await page.goto(FIXED_FOLDER_URL + '?hl=es', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  await waitForDriveReady(page);
}

/* === detalles → fileId === (se mantiene, pero ya no se usa en el flujo "rápido") */
async function getFileIdFromDetails(page, row) {
  await row.click({ button: 'right' }).catch(()=>{});
  const detailsBtn = page.locator([
    'div[role="menuitem"]:has-text("Ver detalles")',
    'div[role="menuitem"]:has-text("Detalles")',
    'div[role="menuitem"]:has-text("View details")',
    'div[role="menuitem"]:has-text("Details")'
  ].join(', ')).first();
  if (await detailsBtn.count()) await detailsBtn.click().catch(()=>{});
  const link = page.locator('a[href*="/file/d/"]').first();
  try {
    await link.waitFor({ state: 'visible', timeout: 6000 });
    const href = await link.getAttribute('href');
    const m = href && href.match(/\/file\/d\/([^/]+)/);
    if (m) return m[1];
  } catch {}
  const href = await page.evaluate(()=>{ const a=document.querySelector('a[href*="/file/d/"]'); return a?a.getAttribute('href'):null; }).catch(()=>null);
  const m = href && href.match(/\/file\/d\/([^/]+)/);
  return (m && m[1]) || null;
}

/* (opcional) compartir → cualquiera con enlace (lector) */
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
  const accessBtn = page.locator('button:has-text("Restringido"), div[role="button"]:has-text("Restringido"), button:has-text("Restricted"), div[role="button"]:has-text("Restricted")').first();
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

/* === utilidades de verificación ligera === */
async function getDisplayedNameFromRow(page, row) {
  // Intenta leer un aria-label o texto cercano para devolver el nombre tal como lo pinta Drive
  try {
    const name = await row.evaluate((el) => {
      const attrName = el.getAttribute('aria-label') || '';
      if (attrName) return attrName;
      // Buscar texto de una celda hija
      const cell = el.querySelector('[role="gridcell"], [aria-label]');
      return (cell && (cell.getAttribute('aria-label') || cell.textContent || '')).trim();
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

/* ========================================================================== */
/* ======================== SUBIR ARCHIVO (UI) ============================== */
/* ========================================================================== */
async function uploadFileToSpecificFolderUI(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Archivo no existe: ${filePath}`);

  const { browser, context, page } = await attemptGoogleLogin();
  try {
    const targetUrl = FIXED_FOLDER_URL.includes('?') ? `${FIXED_FOLDER_URL}&hl=es` : `${FIXED_FOLDER_URL}?hl=es`;
    await gotoWithRetry(context, { page }, targetUrl);
    console.log('📌 En carpeta fija u/1');
    await waitForDriveReady(page);
    await clearOverlays(page);

    const desiredName = 'Video.mp4';

    if (DELETE_BEFORE_UPLOAD) {
      await trashExistingFile(page, desiredName).catch(()=>{});
      await page.waitForTimeout(800).catch(()=>{});
    }

    const attempts = 3;
    const fileBuffer = fs.readFileSync(filePath);
    const fileSpec = { name: desiredName, mimeType: 'video/mp4', buffer: fileBuffer };

    let uploaded = false;
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

        uploaded = true;
        console.log('⬆️ Subida iniciada…');

        if (!DELETE_BEFORE_UPLOAD) await handleUploadConflictDialog(page, 20000);
        break;
      } catch (e) {
        console.log(`⚠️ Fallo al iniciar subida (intento ${i}/${attempts}): ${e.message}`);
        await page.keyboard.press('Escape').catch(()=>{});
        await page.waitForTimeout(600);
      }
    }

    if (!uploaded) throw new Error('No se pudo iniciar la subida tras varios intentos.');
    if (!DELETE_BEFORE_UPLOAD) await handleUploadConflictDialog(page, 8000).catch(()=>{});

    // ✅ ESPERA ROBUSTA Y **RETURN RÁPIDO** TRAS VER LA FILA
    const row = await waitForUploadFinishRobust(page, desiredName, 5 * 60 * 1000);
    console.log('✅ Subida detectada y fila localizada');

    // Leer nombre mostrado en UI (mejora de verificación) — best effort
    const displayedName = (await getDisplayedNameFromRow(page, row).catch(()=>null)) || desiredName;

    // (Opcional) doble verificación en “Recientes”
    let verifyMethod = 'row';
    try {
      const alsoInRecents = await verifyInRecents(page, desiredName).catch(()=>false);
      if (alsoInRecents) verifyMethod = 'row+recents';
    } catch {}

    const fastResult = {
      ok: true,
      name: desiredName,
      displayedName,          // cómo lo ve la UI
      verified: true,
      verifyMethod,           // 'row' o 'row+recents'
      id: null,
      webViewLink: null,
      webContentLink: null,
      shareLink: null
    };
    console.log('🏁 Final (fast return):', fastResult);
    return fastResult;

    // --- NOTA ---
    // Si en algún momento vuelves a necesitar el fileId, puedes
    // sustituir el bloque anterior por la lógica “lenta”:
    // const fileId = await getFileIdFromDetails(page, row).catch(()=>null);
    // ... construir enlaces y devolverlos.
    // ----------------

  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/** Alias compatible; siempre carpeta fija u/1 */
async function uploadFileToDriveUI(filePath, _opts = {}) { return uploadFileToSpecificFolderUI(filePath); }

module.exports = {
  attemptGoogleLogin,
  handleGoogleLogin,
  createUndetectableBrowser,
  gotoWithRetry,
  uploadFileToSpecificFolderUI,
  uploadFileToDriveUI,
};
