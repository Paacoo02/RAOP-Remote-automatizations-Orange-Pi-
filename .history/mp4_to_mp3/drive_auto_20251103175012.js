// drive_auto.js
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const { attemptGoogleLogin } = require("./auto_log_in.js"); // { browser, context, page }

const stealth = StealthPlugin();
puppeteer.use(stealth);

const COLAB_NOTEBOOK_URL =
  "https://colab.research.google.com/drive/1WjbE6Cez95NnBn4AhLgisCHG2FJuDrmk?usp=sharing";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mod = process.platform === "darwin" ? "Meta" : "Control";

// Credenciales (mismas que auto_log_in.js)
const EMAIL = process.env.GOOGLE_USER || "pacoplanestomas@gmail.com";
const PASS  = process.env.GOOGLE_PASS || "392002Planes0.";

/* ────────────────────────────────────────────────────────────────────────────
 * Botón “Connect to Google Drive / Conectar …” (DOM + shadow) → focus
 * ──────────────────────────────────────────────────────────────────────────── */
async function waitAndFocusConnectButton(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const focused = await page.evaluate(() => {
      const RX = /(Connect to Google Drive|Conectar con Google Drive)/i;
      const collect = (root, acc) => {
        acc.push(root);
        const q = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of q) {
          acc.push(el);
          if (el.shadowRoot) collect(el.shadowRoot, acc);
        }
      };
      const nodes = [];
      collect(document, nodes);
      const txt = (el) => (el.innerText || el.textContent || "").trim();

      // slot primaryAction primero
      for (const n of nodes) {
        if (n.getAttribute?.("slot") === "primaryAction" && RX.test(txt(n))) {
          const t = n.shadowRoot?.querySelector("button") || n.querySelector?.("button") || n;
          t?.focus?.();
          return !!t && (document.activeElement === t || t.contains(document.activeElement));
        }
      }
      // cualquier botón con ese texto
      for (const n of nodes) {
        if (n.matches?.("button, md-text-button, mwc-button, paper-button, [role='button']") && RX.test(txt(n))) {
          const t = n.shadowRoot?.querySelector("button") || n.querySelector?.("button") || n;
          t?.focus?.();
          return !!t && (document.activeElement === t || t.contains(document.activeElement));
        }
      }
      return false;
    });
    if (focused) return true;
    await sleep(100);
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Manejo del pop-up OAuth:
 *  - Selecciona la cuenta por email si hay tarjeta
 *  - Si aparece formulario: rellena email + pass
 *  - Hace click en “Continuar/Continue/Permitir/Allow/Aceptar” las veces necesarias
 * ──────────────────────────────────────────────────────────────────────────── */
async function handleOAuthPopupByEmailOrForm(popupPage) {
  // 1) Intentar seleccionar tarjeta de cuenta por data-email o texto del correo
  try {
    let candidate = popupPage.locator(`[data-email="${EMAIL}"]`).first();
    if (!(await candidate.count())) {
      candidate = popupPage.locator(`div[role="button"]:has-text("${EMAIL}")`).first();
    }
    if (await candidate.count()) {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click();
      console.log(`🟢 Cuenta seleccionada por email: ${EMAIL}`);
    } else {
      console.log("ℹ️ No hay tarjeta de cuenta; puede ser formulario directo.");
    }
  } catch (e) {
    console.log("⚠️ Selección por email falló (seguimos con formulario si aparece):", e.message);
  }

  // 2) Si aparece formulario, meter email + pass
  try {
    // Email
    const emailBox = popupPage.locator(
      '#identifierId:visible, input[name="identifier"]:visible, input[type="email"]:visible'
    ).first();
    if (await emailBox.count()) {
      await emailBox.click({ timeout: 2000 }).catch(() => {});
      await emailBox.fill("", { timeout: 2000 }).catch(() => {});
      await emailBox.type(EMAIL, { delay: 40 });
      const nextId = popupPage.locator(
        '#identifierNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible'
      ).first();
      if (await nextId.count()) {
        await Promise.all([
          popupPage.waitForLoadState("domcontentloaded").catch(() => {}),
          nextId.click(),
        ]);
      } else {
        await popupPage.keyboard.press("Enter").catch(() => {});
      }
    }

    // Password
    await Promise.race([
      popupPage.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first().waitFor({ timeout: 15000 }),
      popupPage.waitForURL(/challenge\/pwd|signin\/v2\/sl\/pwd/i, { timeout: 15000 }).catch(() => {})
    ]).catch(() => {});
    const passBox = popupPage.locator('input[type="password"]:visible, input[name="Passwd"]:visible').first();
    if (await passBox.count()) {
      await passBox.click({ timeout: 2000 }).catch(() => {});
      await passBox.fill("", { timeout: 2000 }).catch(() => {});
      await passBox.type(PASS, { delay: 40 });
      const nextPwd = popupPage.locator(
        '#passwordNext:visible, div[role="button"]:has-text("Next"):visible, div[role="button"]:has-text("Siguiente"):visible'
      ).first();
      if (await nextPwd.count()) {
        await Promise.all([
          popupPage.waitForLoadState("domcontentloaded").catch(() => {}),
          nextPwd.click(),
        ]);
      } else {
        await popupPage.keyboard.press("Enter").catch(() => {});
      }
      console.log("🟢 Password enviado.");
    }
  } catch (e) {
    console.log("⚠️ Flujo de formulario no necesario o no crítico:", e.message);
  }

  // 3) Pantallas de consentimiento (1 o 2). Click hasta que no salgan más.
  for (let i = 0; i < 4; i++) {
    try {
      const cont = popupPage.locator(
        [
          'button:has-text("Continuar")',
          'button:has-text("Continue")',
          'button:has-text("Permitir")',
          'button:has-text("Allow")',
          'button:has-text("Aceptar")'
        ].join(", ")
      ).first();
      await cont.waitFor({ state: "visible", timeout: 15000 });
      await cont.click();
      await popupPage.waitForTimeout(600);
      console.log(`➡️ Consent #${i + 1}`);
    } catch {
      break; // no hay más consent
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Espera robusta a que el pop-up se cierre
 * ──────────────────────────────────────────────────────────────────────────── */
async function waitForPopupClose(popupPage, timeoutMs = 60000) {
  if (popupPage.isClosed()) return true;
  return await Promise.race([
    new Promise((res) => popupPage.once("close", () => res(true))),
    popupPage.waitForTimeout(timeoutMs).then(() => false)
  ]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Orquesta el flujo OAuth con 0/1/2 pop-ups:
 *  - Captura el primer pop-up
 *  - Lo maneja y espera a cierre
 *  - Si aparece un segundo pop-up en unos segundos, repite
 * ──────────────────────────────────────────────────────────────────────────── */
async function runOAuthConsentFlow(context) {
  let totalPopups = 0;

  // Intenta capturar el primer pop-up (algunos casos no muestran ninguno)
  let popupPage = await context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
  if (!popupPage) {
    console.log("ℹ️ No apareció pop-up OAuth (posible sesión ya autorizada).");
    return totalPopups;
  }

  while (popupPage) {
    totalPopups += 1;
    await popupPage.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await popupPage.bringToFront().catch(() => {});
    console.log(`🔓 Popup OAuth #${totalPopups} cargada:`, popupPage.url());

    await handleOAuthPopupByEmailOrForm(popupPage);

    const closed = await waitForPopupClose(popupPage, 90000);
    console.log(closed ? `✅ Popup #${totalPopups} cerrada.` : `⚠️ Timeout esperando cierre popup #${totalPopups} (seguimos).`);

    // ¿aparece otro pop-up casi inmediatamente? (segundo consent)
    popupPage = await context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  }

  console.log(`✅ Consents completados: ${totalPopups}`);
  return totalPopups;
}

/* ──────────────────────────────────────────────────────────────────────────── */
async function drive_auto() {
  console.log("🚀 Iniciando el flujo en Google Colab...");
  let browser, context, page;

  ({ browser, context, page } = await attemptGoogleLogin());
  if (!page || page.isClosed() || !page.url().includes("drive.google.com")) {
    throw new Error("Login process failed to land on Google Drive.");
  }
  console.log(`[Main] Confirmada página en Google Drive: ${page.url()}`);

  // Abrir Colab
  console.log(`🌍 Navegando al notebook: ${COLAB_NOTEBOOK_URL}`);
  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: "load", timeout: 180000 });
  await page.locator(".cell.code").first().waitFor({ state: "visible", timeout: 120000 });
  console.log("✅ Editor visible.");

  // Limpieza rápida (best-effort)
  try {
    const runAnyway = page.locator('colab-dialog button:has-text("Run anyway")').first();
    if (await runAnyway.isVisible({ timeout: 2000 })) await runAnyway.click();
    await page.locator("#edit-menu-button").click();
    await page.locator("#edit-menu .goog-menuitem").first().waitFor({ state: "visible", timeout: 4000 });
    await page.locator('.goog-menuitem:has-text("Clear all outputs")').first().click();
    await page.locator("#edit-menu").waitFor({ state: "hidden", timeout: 4000 });
  } catch {}

  // Celda 0 (activar)
  console.log("1️⃣ Ejecutando primera celda…");
  await page.locator(".cell.code >> nth=0 >> colab-run-button").first().click();

  // Reiniciar runtime (confirmar con Enter)
  console.log("🔌 Reiniciando runtime…");
  await page.click('[aria-label*="Additional connection options"]', { timeout: 15000 });
  await page.waitForSelector(".goog-menu.goog-menu-vertical", { visible: true, timeout: 5000 });
  const ok = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".goog-menuitem, .goog-menuitem-content"));
    const it = items.find((n) => /disconnect and delete runtime/i.test(n.textContent || ""));
    if (!it) return false;
    (it.closest(".goog-menuitem") || it).click();
    return true;
  });
  if (!ok) throw new Error("No se encontró 'Disconnect and delete runtime'.");
  await page.keyboard.press("Enter");
  await sleep(1200);
  console.log("✅ Runtime reiniciado.");

  // Re-ejecuta celda 0 rápido
  {
    const editor1 = await page.locator(".cell.code").nth(0).locator(".monaco-editor").first();
    await editor1.click();
    await page.keyboard.down(mod); await page.keyboard.press("Enter"); await page.keyboard.up(mod);
    await sleep(800);
  }

  // Celda 1 (montaje)
  console.log("2️⃣ Ejecutando Celda 2 (montaje Drive)...");
  const editor2 = await page.locator(".cell.code").nth(1).locator(".monaco-editor").first();
  await editor2.click();

  // Lanza la celda (mod+Enter) y espera un poco
  await page.keyboard.down(mod); await page.keyboard.press("Enter"); await page.keyboard.up(mod);
  console.log("⏳ Celda 2 lanzada. Esperando ~5s…");
  await sleep(5000);

  // Detectar y enfocar el botón “Conectar…”, luego ENTER
  const focused = await waitAndFocusConnectButton(page, 30000);
  if (!focused) console.warn("⚠️ No se pudo enfocar el botón; ENTER igualmente.");
  await page.keyboard.press("Enter");
  console.log("↩️ ENTER enviado al diálogo de Colab.");

  // Ejecutar el flujo de consentimiento con 0/1/2 pop-ups y esperar a sus cierres
  const count = await runOAuthConsentFlow(context);
  console.log(`📑 Total pop-ups procesados: ${count}`);

  // Pequeña espera para que Colab termine de montar /content/drive
  await sleep(8000);

  // Celda 3
  console.log("3️⃣ Ejecutando Celda 3…");
  const editor3 = await page.locator(".cell.code").nth(2).locator(".monaco-editor").first();
  await editor3.click();
  await page.keyboard.down(mod); await page.keyboard.press("Enter"); await page.keyboard.up(mod);

  console.log("👂 Esperando enlace trycloudflare…");
  const link = await page
    .locator("colab-static-output-renderer a[href*='trycloudflare.com']")
    .first()
    .waitFor({ timeout: 300000 })
    .then((h) => page.evaluate((a) => a.href, h));
  console.log("✅ URL:", link);

  return { result: link, page, browser };
}

// Runner
if (require.main === module) {
  drive_auto()
    .then(({ result /*, browser*/ }) => {
      console.log("\n📊 RESULTADO FINAL (URL):\n", result);
      // await browser.close();
    })
    .catch((err) => {
      console.error("🔥 Error:", err?.stack || err?.message);
      process.exit(1);
    });
}

module.exports = { drive_auto };
