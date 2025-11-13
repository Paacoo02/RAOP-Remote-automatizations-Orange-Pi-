// reservaClase.js
import { newStealthContext, humanLikeBehavior, stealthInitScript } from './Stealth.js';
import { chromium as pwChromium } from 'playwright-core';
import chrome from '@sparticuz/chromium';
import { DateTime } from 'luxon';
import 'dotenv/config';
import path from 'path';
import fs from 'fs';


const PROXY_SCRAPE_URL = 'https://api.proxyscrape.com/?request=getproxies&proxytype=socks5&timeout=1000&country=all';

let proxyList = [];
let lastFetch = 0;
const PROXY_TTL = 1000 * 60 * 5; // 5 minutos

async function refreshProxies() {
  const now = Date.now();
  if (now - lastFetch < PROXY_TTL && proxyList.length) return;
  try {
    const res = await fetch(PROXY_SCRAPE_URL);
    const text = await res.text();
    proxyList = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    lastFetch = now;
    console.log(`ProxyScrape: cargados ${proxyList.length} proxies`);
  } catch (err) {
    console.warn('Error al descargar lista de ProxyScrape', err);
  }
}

function pickRandomProxy() {
  if (!proxyList.length) return null;
  return proxyList[Math.floor(Math.random() * proxyList.length)];
}


// ---------- HELPERS ----------
const nextWorkday = (now) => now.plus({ days: 1 });
const weekdayES = (dt) => dt.setLocale("es").toFormat("cccc");

export async function disableOverlay(page) {
  await page.evaluate(() => {
    const ov = document.getElementById("lock-overlay");
    if (ov) ov.remove();
  });
}

export async function launchBrowser() {

  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      proxy ? `--proxy-server=socks5://${proxy}` : ''
    ].filter(Boolean)
  };

  if (process.platform === 'linux') {
    launchOpts.executablePath = await chrome.executablePath();
    launchOpts.args.push(...chrome.args);
    launchOpts.ignoreDefaultArgs = chrome.ignoreDefaultArgs;
  }

  const browser = await pwChromium.launch(launchOpts);
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  // Inyectar evasión
  await page.addInitScript(stealthInitScript);

  // Simular movimientos random iniciales
  await humanLikeBehavior(page);

  return browser;
}


export function saveCredentials(user, pass) {
  if (!user || !pass) throw new Error("user/pass obligatorios");
  setConfig("DEPORSITE_USER", user);
  setConfig("DEPORSITE_PASSWORD", pass);
  process.env.DEPORSITE_USER = user;
  process.env.DEPORSITE_PASSWORD = pass;
}

export function saveClass(className, classTime) {
  setConfig("CLASS_NAME", className);
  setConfig("CLASS_TIME", classTime);
  process.env.CLASS_NAME = className;
  process.env.CLASS_TIME = classTime;
}

export function updateDeporsiteEnv(
  user,
  password,
  envFile = path.resolve(process.cwd(), ".env")
) {
  if (!user || !password) throw new Error("user y password son obligatorios");

  let lines = [];
  if (fs.existsSync(envFile)) {
    // Leemos y conservamos saltos de línea
    const raw = fs.readFileSync(envFile, "utf8");
    lines = raw.split(/\r?\n/);
  }

  // Flags para saber si ya existían
  let hasUser = false;
  let hasPass = false;

  // Recorremos y reemplazamos en memoria
  lines = lines.map((line) => {
    if (/^\s*DEPORSITE_USER\s*=/.test(line)) {
      hasUser = true;
      return `DEPORSITE_USER=${user}`;
    }
    if (/^\s*DEPORSITE_PASSWORD\s*=/.test(line)) {
      hasPass = true;
      return `DEPORSITE_PASSWORD=${password}`;
    }
    return line;
  });

  // Si no estaban, los añadimos al final
  if (!hasUser) lines.push(`DEPORSITE_USER=${user}`);
  if (!hasPass) lines.push(`DEPORSITE_PASSWORD=${password}`);

  // Eliminamos líneas vacías duplicadas al final (opcional)
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(""); // terminamos con salto de línea

  // Guardamos
  fs.writeFileSync(envFile, lines.join("\n"), "utf8");
  console.log(`.env actualizado en ${envFile}`);
}

function updateEnvVariable(
  key,
  value,
  envFile = path.resolve(process.cwd(), ".env")
) {
  if (!key) throw new Error("La clave es obligatoria");
  // Escapamos saltos de línea en value
  const safeValue = String(value).replace(/\r?\n/g, "");
  let lines = [];
  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  }
  let found = false;
  lines = lines.map((line) => {
    // Coincide KEY= o KEY =
    const regex = new RegExp(`^\\s*${key}\\s*=`);
    if (regex.test(line)) {
      found = true;
      return `${key}=${safeValue}`;
    }
    return line;
  });
  if (!found) {
    lines.push(`${key}=${safeValue}`);
  }
  // Limpiar líneas vacías al final
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push("");
  fs.writeFileSync(envFile, lines.join("\n"), "utf8");
}

export async function loginIfNeeded(page, user, pass) {
  const emailField = page.locator('input[name="email"]');

  // Si no hay campo de email, asumimos que ya estamos logueados
  if ((await emailField.count()) === 0) {
    console.log("Login no necesario");
    return false;
  }

  console.log("Iniciando sesión…");
  try {
    await emailField.fill(user);
    await page.fill('input[name="password"]', pass);
    await disableOverlay(page);

    const loginBtn = page.locator('div#enviarFormulario:has-text("Acceder")');
    await loginBtn.waitFor({ state: "visible", timeout: 5_000 });

    await Promise.all([
      loginBtn.click(),
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 15_000 }),
    ]);

    console.log("Sesión iniciada con éxito");
    return true;
  } catch (err) {
    console.error("Error durante login:", err);
    return false;
  }
}

async function confirmReservation(page) {
  await disableOverlay(page);

  // 1) Localizar botón de reservar
  const confirmBtn = page.locator('div.btn-siguiente:has-text("Reservar")');
  await confirmBtn.waitFor({ state: "visible", timeout: 1000 });

  console.log("Pulsando Reservar...");
  // 2) Hacer clic y esperar a que cambie la página
  await Promise.all([
    confirmBtn.click(),
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }),
  ]);

  // 3) Pausa extra de 10 segundos en la página resultante
  console.log("Esperando 5 segundos para asegurar el refresco...");
  await page.waitForTimeout(3_000);

  console.log("¡Reserva confirmada!");
}

export async function waitUntilExact(zone, hh, mm, ss = 0) {
  const now = DateTime.now().setZone(zone);
  let target = now.set({ hour: hh, minute: mm, second: ss, millisecond: 0 });
  if (now >= target) target = target.plus({ days: 1 });

  let diff = target.diffNow().as("milliseconds");

  // ① Esperas gruesas (≥ 60 s) en tramos de 30 s
  while (diff > 60_000) {
    console.log(`…quedan ${Math.round(diff / 1000)} s`);
    await new Promise((r) => setTimeout(r, 30_000));
    diff = target.diffNow().as("milliseconds");
  }

  // ② Últimos 60 s: un único setTimeout hasta 1 s antes
  if (diff > 1_000) await new Promise((r) => setTimeout(r, diff - 1_000));

  // ③ Último segundo: timeout específico
  diff = target.diffNow().as("milliseconds");
  if (diff > 0) await new Promise((r) => setTimeout(r, diff));

  // ④ Busy-wait < 8 ms para afinar (opcional)
  while (Date.now() < target.toMillis() - 3) {
    /* no-op */
  }

  // Punto exacto alcanzado
}

export async function listNextDayTags(page, url, zone = "Europe/Madrid") {
  console.log("=== listNextDayTags START ===");

  // 1) Navega y elimina el overlay
  await page.goto(url, { waitUntil: "networkidle" });
  await disableOverlay(page);

  // 2) Calcula hoy y mañana en la zona
  const now = DateTime.now().setZone(zone);
  const tomorrow = now.plus({ days: 1 });
  console.log(`→ Hoy: ${now.toISODate()}, Mañana: ${tomorrow.toISODate()}`);

  // 3) Si mañana “rebosa” la semana actual (domingo→lunes), avanza el calendario
  //    Por ejemplo, si tomorrow.weekday (1..7) ≤ now.weekday, estamos en nueva semana
  if (tomorrow.weekday <= now.weekday) {
    console.log(
      "→ Avanzando vista semanal para mostrar lunes de la próxima semana"
    );
    const icon = await page
      .locator("span.material-icons", { hasText: "arrow_forward_ios" })
      .first()
      .elementHandle();
    if (icon) {
      await page.evaluate((el) => {
        const btn = el.closest("[onclick]") || el;
        btn.click();
      }, icon);

      await page.waitForLoadState("networkidle");
      await disableOverlay(page);
    }
  }

  // 4) Ahora extrae tiles de “tomorrow”
  const targetDate = tomorrow.toFormat("yyyy-MM-dd");
  console.log(`→ Extrayendo tiles de data-idfecha="${targetDate}"`);

  try {
    await page.waitForSelector(`div[data-idfecha="${targetDate}"]`, {
      timeout: 5000,
    });
  } catch {
    console.warn(`✖ No apareció div[data-idfecha="${targetDate}"]`);
    return [];
  }

  const tiles = page.locator(`div[data-idfecha="${targetDate}"]`);
  const count = await tiles.count();
  console.log(`→ Encontrados ${count} tiles para mañana`);

  const actividades = [];
  for (let i = 0; i < count; i++) {
    const tile = tiles.nth(i);

    const title = (await tile.locator("div.nombre div").textContent()).trim();
    const schedule = (await tile.locator("div.hora").textContent()).trim();
    const tituloTxt = await tile
      .locator(".pop-up-content .titulo")
      .first()
      .textContent();
    const [, libres, total] = tituloTxt.match(/(\d+)\/(\d+)/) || ["", "0", "0"];
    const monitor = (
      await tile
        .locator(".pop-up-content .info-box .row div.col-sm-offset-4 .texto")
        .textContent()
    ).trim();
    const description = (
      await tile.locator(".pop-up-content .descripcion").first().textContent()
    ).trim();

    // extrae color de background
    const color = await tile.evaluate((el) => {
      const bg = window.getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        return (
          "#" +
          [m[1], m[2], m[3]]
            .map((x) => parseInt(x, 10).toString(16).padStart(2, "0"))
            .join("")
        );
      }
      return bg;
    });

    actividades.push({
      title,
      schedule,
      spots: parseInt(libres, 10),
      total: parseInt(total, 10),
      monitor,
      description,
      color,
    });

    console.log(
      `• ${title} [${color}] Horario: ${schedule} Plazas: ${libres}/${total}`
    );
  }

  console.log("=== listNextDayTags END ===");
  return actividades;
}

export async function reserveClass({
  url,
  user,
  pass,
  className,
  classTime,
  zone = 'Europe/Madrid',
  daysAhead = 1
}) {
  if (!user || !pass) throw new Error('Faltan credenciales (user/pass)');

  const startOverall = DateTime.now().setZone(zone);
  console.log(`→ [${startOverall.toISO()}] Iniciando reserveClass()`);

  try {
    const now    = DateTime.now().setZone(zone);
    const target = nextWorkday(now.plus({ days: daysAhead - 1 }));
    const label  = weekdayES(target);
    console.log(`→ Reservando ${className} (${classTime}) para ${label}`);

    const browser = await launchBrowser();
    const page    = await browser.newPage();

    // 1) Ir a la URL y quitar overlay
    await page.goto(url, { waitUntil: 'networkidle' });
    // 2) Domingo → avanzar semana
    if (now.weekday === 7) {
      console.log('→ Domingo: avanzando a la siguiente semana…');
      const iconHandle = await page
        .locator('span.material-icons', { hasText: 'arrow_forward_ios' })
        .first()
        .elementHandle();
      if (iconHandle) {
        await page.evaluate(el => {
          const btn = el.closest('[onclick]') || el;
          btn.click();
        }, iconHandle);
        await page.waitForLoadState('networkidle');
        console.log('   → Semana avanzada y recargada');
      } else {
        console.warn('   ⚠ Icono ➔ no encontrado');
      }
    }

    // 3) Seleccionar pestaña del día de la clase
    await page.evaluate(label => {
  const tab = [...document.querySelectorAll('[role="tab"]')]
    .find(el => new RegExp(`^${label}$`, 'i').test(el.textContent.trim()));
  if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
}, label);

// 4) Buscar y abrir modal de la clase
const startTime = classTime.split(' - ')[0];
const tile = page.locator(
  `div[data-horainicio="${startTime}:00"]`,
  { hasText: className }
).first();

await tile.waitFor({ timeout: 7000 });

// 4) Click en el tile para abrir el modal
console.log('→ Clicando tile…');
await tile.click();

// (Opcional) cuantos modales hay en este momento
const totalModals = await page.locator('div.modal-detalle-actividad').count();
console.log(`→ Hay ${totalModals} modales en el DOM`);

// 5) Localizamos el modal que contenga TÍTULO y HORARIO, y que pase a visible
const modal = page
  .locator('div.modal-detalle-actividad')
  // filtro por título exacto
  .filter({ has: page.locator('.title-pop-up', { hasText: className }) })
  // filtro por horario dentro del modal
  .filter({ has: page.locator('.texto',       { hasText: classTime   }) })
  .first();

console.log('→ Esperando a que el modal correcto sea visible…');
await modal.waitFor({ state: 'visible', timeout: 10000 });

// 6) Pulsar "Inscribirme" dentro de ese modal
const enrollBtn = modal.locator('a.btn-reservar', { hasText: 'Inscribirme' });
await enrollBtn.waitFor({ state: 'visible', timeout: 5000 });
console.log('→ Clic en Inscribirme…');
await Promise.all([
  enrollBtn.click(),
  page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
    .catch(() => {})
]);


    // 6) Si pide login, hacemos login
    await loginIfNeeded(page, user, pass);

    // 7) Esperar hora exacta y confirmar
    await waitUntilExact(zone, 22, 30, 50);
    await confirmReservation(page);

    await browser.close();

    const endOverall = DateTime.now().setZone(zone);
    console.log(`→ [${endOverall.toISO()}] reserveClass() completado`);
    return true;

  } catch (err) {
    console.error('❌ Error en reserveClass():', err);
    return false;
  }
}


export async function longWait() {
  console.log("Executant longWait");
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return true;
}

export async function cancelReservation({
  user,
  pass,
  className,
  classTime,
  daysAhead = 1,
  zone = "Europe/Madrid",
  loginUrl = "https://eduardolatorre.deporsite.net/loginmenu",
  misReservasUrl = "https://eduardolatorre.deporsite.net/mis-reservas?zona=area-usuario",
}) {
  if (!user || !pass) throw new Error("Faltan credenciales (user/pass)");

  // 1) Launch browser and new context/page con bypassCSP
  const browser = await launchBrowser();
  const page    = await browser.newPage();
  page.removeAllListeners("console");
  page.on("console", (msg) => console.log(`↑ Browser console: ${msg.text()}`));

  // 2) Login
  console.log("→ Abriendo login…");
  await page.goto(loginUrl, { waitUntil: "networkidle" });
  await disableOverlay(page);
  await loginIfNeeded(page, user, pass);

  // 3) Compute target date & format
  const target = nextWorkday(
    DateTime.now()
      .setZone(zone)
      .plus({ days: daysAhead - 1 })
  );
  const fechaAttr = target.toFormat("yyyyLLdd");
  const classDate = target.toFormat("dd/LL/yyyy");
  const normTime = classTime.trim().replace(/\s+/g, "");
  console.log(`→ Buscando reserva para ${classDate} a las ${normTime}…`);

  // 4) Navigate to Mis Reservas
  await Promise.all([
    page.goto(misReservasUrl, { waitUntil: "networkidle" }),
    page.waitForSelector("tr.linea", { timeout: 10000 }),
  ]);
  await disableOverlay(page);

  // 5) DEBUG: list all responsive cells
  const allCells = page.locator("td.visible-xs.visible-sm");
  const totalCells = await allCells.count();
  console.log(`→ Encontradas ${totalCells} celdas responsivas en total:`);
  for (let i = 0; i < totalCells; i++) {
    const txt = (await allCells.nth(i).textContent())?.trim() ?? "";
    console.log(`  cell[${i}]: "${txt}"`);
  }

  // 6) Try locate row first
  const selector = `tr.linea[data-fecha="${fechaAttr}"]:has-text("${className}"):has-text("${normTime}")`;
  const row = page.locator(selector).first();
  if ((await row.count()) === 0) {
    console.log(
      `→ No se encontró la fila con selector ${selector}, usando primera fila disponible.`
    );
    const dateRows = page.locator(`tr.linea[data-fecha="${fechaAttr}"]`);
    if ((await dateRows.count()) > 0) {
      console.log("→ Usando primera fila con la fecha:", fechaAttr);
      await Promise.all([
        dateRows.first().click(),
        page
          .waitForSelector("#botonAnularReserva", { timeout: 10000 })
          .catch(() => {}),
      ]);
    } else {
      console.log("→ No hay filas para la fecha, usando primera fila general.");
      await Promise.all([
        page.locator("tr.linea").first().click(),
        page
          .waitForSelector("#botonAnularReserva", { timeout: 10000 })
          .catch(() => {}),
      ]);
    }
  } else {
    console.log(`→ Abriendo detalle de reserva con selector: ${selector}`);
    await Promise.all([
      row.click(),
      page
        .waitForSelector("#botonAnularReserva", { timeout: 10000 })
        .catch(() => {}),
    ]);
  }

  // 7) Pulsar botón "Anular" y luego "Anular Reserva"
  console.log('→ Intentando pulsar botón "Anular"...');
  // Si existe un contenedor/modal concreto, úsa su locator en lugar de page
  const contextLocator = page; // o: page.locator('selector-de-tu-modal');

  // Localiza el primer botón "Anular"
  const btnAnularReserva = contextLocator
    .locator("#botonAnularReserva")
    .first();
  if ((await btnAnularReserva.count()) === 0) {
    console.log("→ No se encontró ningún #botonAnularReserva en el contexto.");
  } else {
    // Scroll por si está fuera de vista
    try {
      await btnAnularReserva.scrollIntoViewIfNeeded();
    } catch {}
    let visible = false;
    try {
      visible = await btnAnularReserva.isVisible();
    } catch {}
    if (visible) {
      console.log('→ Botón "Anular" es visible, click normal.');
      await btnAnularReserva.click();
    } else {
      console.log(
        "→ Botón encontrado pero oculto. Intentaremos revelarlo y hacer click vía JS."
      );
      // Revelar mediante JavaScript
      await page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll("#botonAnularReserva")
        );
        btns.forEach((btn) => {
          btn.style.display = "block";
          btn.style.visibility = "visible";
          btn.style.opacity = "1";
          btn.removeAttribute("hidden");
        });
      });
      // Hacer click vía JS
      await page.evaluate(() => {
        const btn = document.querySelector("#botonAnularReserva");
        if (btn) btn.click();
      });
    }

    // Tras el click, esperar el botón de confirmación
    console.log('→ Esperando botón de confirmación "#botonAnular"...');
    const btnConfirmar = contextLocator.locator("#botonAnular").first();
    if ((await btnConfirmar.count()) === 0) {
      console.log("→ No se encontró ningún #botonAnular para confirmar.");
    } else {
      try {
        await btnConfirmar.scrollIntoViewIfNeeded();
      } catch {}
      let visible2 = false;
      try {
        visible2 = await btnConfirmar.isVisible();
      } catch {}
      if (visible2) {
        console.log('→ Botón "Anular Reserva" visible, click normal.');
        await btnConfirmar.click();
      } else {
        console.log("→ Botón confirmar oculto. Revelándolo y click vía JS.");
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("#botonAnular"));
          btns.forEach((btn) => {
            btn.style.display = "block";
            btn.style.visibility = "visible";
            btn.style.opacity = "1";
            btn.removeAttribute("hidden");
          });
        });
        await page.evaluate(() => {
          const btn = document.querySelector("#botonAnular");
          if (btn) btn.click();
        });
      }
      console.log('→ Click en "Anular Reserva" enviado.');
    }
  }

  // 8) final pause y cierre
  await page.waitForTimeout(5000);
  await browser.close();
}

export default {
  listNextDayTags,
  loginIfNeeded,
  reserveClass,
  cancelReservation,
  updateDeporsiteEnv,
  updateEnvVariable,
  disableOverlay,
  longWait,
};
