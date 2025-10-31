// auto_log_in.js
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
    delete Object.getPrototypeOf(navigator).webdriver;
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
  // --- COMIENZA EL BLOQUE CORREGIDO ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
await sleep(5000);
console.log('✅ Login completado, buscando la pestaña final de Drive...');
const allPages = await context.pages();
let drivePage = allPages.find(p => p.url().includes('drive.google.com'));

if (!drivePage) {
  // Si no se encuentra, puede que aún esté navegando, damos un momento
  await pageRef.page.waitForTimeout(2000);
  drivePage = (await context.pages()).find(p => p.url().includes('drive.google.com'));
}

if (!drivePage) {
    throw new Error('No se pudo encontrar la página de Google Drive después del login.');
}

// Cierra todas las pestañas EXCEPTO la de Drive para limpiar
for (const page of allPages) {
    if (page !== drivePage && !page.isClosed()) {
        await page.close().catch(() => {});
    }
}
console.log('🧹 Pestañas innecesarias cerradas.');

// Devuelve la pestaña correcta y logueada de Google Drive
return { browser, context, page: drivePage };
// --- TERMINA EL BLOQUE CORREGIDO ---
}

module.exports = {
  attemptGoogleLogin,
  handleGoogleLogin,
  createUndetectableBrowser,
  gotoWithRetry,          // 👈 exportado
  
};
