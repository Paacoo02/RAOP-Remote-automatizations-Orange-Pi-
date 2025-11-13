// riverside_auto.js — Sube /tmp/video.mp3 (o el MP3 más reciente) a Riverside y dispara transcripción
const fs = require("fs");
const os = require("os");
const path = require("path");

// Reutilizamos el navegador "indetectable" persistente del proyecto
const { createUndetectableBrowser } = require("./auto_log_in.js");

/* ==================== Utilidades de disco ==================== */
function findLatestMp3({ preferName = "video.mp3", extraDirs = [] } = {}) {
  const dirs = Array.from(new Set([
    os.tmpdir(),
    "/tmp",
    "/app/downloads",
    "/root/Downloads",
    ...extraDirs.filter(Boolean),
  ]));

  const hits = [];
  for (const d of dirs) {
    try {
      const items = fs.readdirSync(d);
      for (const it of items) {
        if (!/\.mp3$/i.test(it)) continue;
        const p = path.join(d, it);
        const st = fs.statSync(p);
        hits.push({ file: p, mtime: st.mtimeMs });
      }
    } catch {}
  }
  if (!hits.length) return null;

  const exact = hits.find(h => path.basename(h.file).toLowerCase() === preferName.toLowerCase());
  if (exact) return exact.file;

  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].file;
}

/* ==================== Helpers UI ==================== */
async function acceptCookiesIfAny(page) {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    'text=Accept all',
    'text=Accept',
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        console.log("🍪 Aceptando cookies…");
        await btn.click({ timeout: 2000 }).catch(()=>{});
        await page.waitForTimeout(300);
        break;
      }
    } catch {}
  }
}

async function isUploadUIReady(page) {
  if ((await page.locator('input[type="file"]').count()) > 0) return true;
  if ((await page.locator('svg path[d^="M10.0003 4.16602V15.8327"]').count()) > 0) return true;
  return false;
}

async function clickTranscribeNowAndWaitUploadUI(page) {
  console.log("🔘 Pulsando 'Transcribe now' antes de subir…");
  const candidates = [
    '#transcribe-main',
    'button:has-text("Transcribe now")',
    'button:has-text("Transcribe Now")',
    'a:has-text("Transcribe now")',
    'a:has-text("Transcribe Now")',
    '[data-testid="transcribe-now"]',
  ];

  for (let round = 1; round <= 3; round++) {
    let clicked = false;
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(()=>{});
        await page.waitForTimeout(120);
        await el.click({ force: true });
        console.log(`✅ Click en '${sel}' (ronda ${round})`);
        clicked = true;
        break;
      } catch (e) {
        console.log(`⚠️ Fallo al pulsar '${sel}': ${e.message}`);
      }
    }
    if (!clicked) { await page.mouse.wheel(0, 700).catch(()=>{}); }

    for (let i = 0; i < 10; i++) {
      if (await isUploadUIReady(page)) {
        console.log("🟢 UI de subida detectada.");
        return true;
      }
      await page.waitForTimeout(300);
    }
  }
  console.log("⚠️ No se confirmó la UI de subida tras 'Transcribe now'. Seguimos igualmente.");
  return false;
}

async function clickNearestClickableOfPlusIcon(page) {
  let plusPath = page.locator('svg path[d^="M10.0003 4.16602V15.8327"]').first();
  if (!(await plusPath.count())) return false;
  try { await plusPath.scrollIntoViewIfNeeded().catch(()=>{}); } catch {}
  const parentBtn = plusPath.locator('xpath=ancestor::button[1]');
  if (await parentBtn.count()) { await parentBtn.click({ force: true }).catch(()=>{}); return true; }
  const parentAny = plusPath.locator('xpath=ancestor::*[self::button or self::div][1]');
  if (await parentAny.count()) { await parentAny.click({ force: true }).catch(()=>{}); return true; }
  return false;
}

async function closeUploaderUI(page) {
  console.log("🧹 Cerrando adjuntador/overlay tras la subida…");
  try {
    await page.evaluate(() => {
      const input = document.querySelector('input[type="file"]');
      if (input) {
        input.value = "";
        input.style.display = "none";
        input.style.opacity = "0";
        input.setAttribute("hidden", "true");
        input.blur();
      }
    });
  } catch {}
  for (const sel of [
    'button[aria-label="Close"]',
    'button:has-text("Close")',
    'button:has-text("Done")',
    'button:has-text("Cancel")',
    '[role="dialog"] button[aria-label="Close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 1000 }).catch(()=>{}); }
    } catch {}
  }
  try { await page.keyboard.press("Escape"); } catch {}
  try { await page.mouse.click(10, 10); } catch {}
  await page.waitForTimeout(250);
}

/* ====== Verificación humana ====== */
async function clickConsentBySpinnerWrapper(page) {
  console.log("☑️ Buscando '.spinner-wrapper'…");
  const spinner = page.locator('.spinner-wrapper').first();
  if (!(await spinner.count())) return false;

  const clickable = spinner.locator('xpath=ancestor::*[self::button or @role="button" or self::label or @role="checkbox" or self::div][1]');
  try {
    if (await clickable.count()) {
      await clickable.scrollIntoViewIfNeeded().catch(()=>{});
      await page.waitForTimeout(100);
      await clickable.click({ force: true });
      console.log("✅ Click en contenedor de '.spinner-wrapper'.");
      return true;
    }
  } catch (e) { console.log("⚠️ Error clicando contenedor spinner:", e.message); }

  try {
    await spinner.scrollIntoViewIfNeeded().catch(()=>{});
    await page.waitForTimeout(80);
    await spinner.click({ force: true });
    console.log("✅ Click directo en '.spinner-wrapper'.");
    return true;
  } catch (e) { console.log("⚠️ Error clicando spinner:", e.message); }

  try {
    const box = await spinner.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      console.log("✅ Click por coordenadas sobre '.spinner-wrapper'.");
      return true;
    }
  } catch (e) { console.log("⚠️ Error en click por coordenadas spinner:", e.message); }

  return false;
}

async function clickTurnstileOrHCaptcha(page, { attempts = 2 } = {}) {
  for (let round = 1; round <= attempts; round++) {
    console.log(`🧩 Intentando resolver checkbox en iframe (round ${round})…`);
    const frameLoc = page.frameLocator(
      'iframe[title*="Turnstile" i], iframe[src*="challenges.cloudflare.com"], iframe[title*="checkbox" i], iframe[src*="hcaptcha.com"]'
    ).first();

    if (!(await frameLoc.count())) {
      console.log("ℹ️ No se encontró iframe de verificación.");
      return false;
    }

    try {
      const candidates = [
        'input[type="checkbox"]',
        '[role="checkbox"]',
        '#cf-stage',
        '.ctp-checkbox',
        'label',
        'div',
      ];
      let clicked = false;
      for (const sel of candidates) {
        const el = frameLoc.locator(sel).first();
        if (!(await el.count())) continue;
        try {
          await el.click({ force: true, timeout: 2000 });
          console.log(`✅ Click dentro del iframe en '${sel}'.`);
          clicked = true;
          break;
        } catch {}
      }
      if (!clicked) {
        const frameHandle = await frameLoc.elementHandle();
        if (frameHandle) {
          const box = await frameHandle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            console.log("✅ Click centrado sobre el iframe (fallback).");
            clicked = true;
          }
        }
      }

      // Espera token
      const tokenSel =
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="h-captcha-response"], textarea[name="g-recaptcha-response"]';
      const token = await page
        .waitForFunction(
          (sel) => {
            const el = document.querySelector(sel);
            return el && el.value && el.value.length > 10 ? el.value : null;
          },
          tokenSel,
          { timeout: 8000 }
        )
        .catch(() => null);

      if (token) {
        console.log(`🔑 Token de verificación presente (len=${String(token).length}).`);
        return true;
      }

      await page.waitForTimeout(1200);
    } catch (e) {
      console.log("⚠️ Error interactuando con iframe:", e.message);
    }
  }
  console.log("❌ No se pudo obtener token de verificación del iframe.");
  return false;
}

// Reemplaza la función markConsentCheckbox con esta versión mejorada
async function markConsentCheckbox(page) {
  console.log("☑️ Intentando marcar el consentimiento…");

  // Estrategia 1: Buscar por texto relacionado con consentimiento
  try {
    const consentSelectors = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      'label:has-text("consent")',
      'label:has-text("agree")',
      'label:has-text("terms")',
      'label:has-text("I agree")',
      '.consent-checkbox',
      '[data-testid*="consent"]',
      '[id*="consent"]',
      '[name*="consent"]'
    ];

    for (const selector of consentSelectors) {
      try {
        const element = page.locator(selector).first();
        if (await element.count() > 0) {
          console.log(`✅ Encontrado checkbox con selector: ${selector}`);
          
          // Scroll y espera
          await element.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
          
          // Verificar si ya está marcado
          const isChecked = await element.isChecked().catch(() => false);
          if (!isChecked) {
            // Intentar múltiples métodos de click
            try {
              await element.check({ force: true, timeout: 2000 });
              console.log(`✅ Checkbox marcado con .check(): ${selector}`);
            } catch {
              await element.click({ force: true, timeout: 2000 });
              console.log(`✅ Checkbox marcado con .click(): ${selector}`);
            }
            
            // Disparar eventos
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) {
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('click', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }, selector);
            
            return true;
          } else {
            console.log("ℹ️ Checkbox ya estaba marcado");
            return true;
          }
        }
      } catch (e) {
        console.log(`⚠️ Error con selector ${selector}:`, e.message);
      }
    }
  } catch (err) {
    console.log("⚠️ Error en búsqueda de checkbox:", err.message);
  }

  // Estrategia 2: Buscar label que contenga texto de consentimiento y encontrar su checkbox asociado
  try {
    const labelTexts = [
      "consent",
      "agree", 
      "terms",
      "conditions",
      "I agree",
      "I accept"
    ];
    
    for (const text of labelTexts) {
      const label = page.locator(`label:has-text("${text}")`).first();
      if (await label.count() > 0) {
        console.log(`✅ Encontrado label con texto: ${text}`);
        
        // Intentar encontrar el input asociado
        const forAttr = await label.getAttribute('for');
        if (forAttr) {
          const input = page.locator(`#${forAttr}`);
          if (await input.count() > 0) {
            await input.scrollIntoViewIfNeeded();
            await input.click({ force: true });
            console.log(`✅ Checkbox marcado via label for="${forAttr}"`);
            return true;
          }
        }
        
        // Si no tiene for, buscar input dentro del label
        const inputInLabel = label.locator('input[type="checkbox"]');
        if (await inputInLabel.count() > 0) {
          await inputInLabel.click({ force: true });
          console.log(`✅ Checkbox marcado dentro del label`);
          return true;
        }
        
        // Click directo en el label
        await label.click({ force: true });
        console.log(`✅ Click directo en label`);
        return true;
      }
    }
  } catch (e) {
    console.log("⚠️ Error buscando por labels:", e.message);
  }

  // Estrategia 3: Buscar por atributos ARIA
  try {
    const ariaSelectors = [
      '[aria-label*="consent"]',
      '[aria-label*="agree"]',
      '[aria-labelledby*="consent"]'
    ];
    
    for (const selector of ariaSelectors) {
      const element = page.locator(selector).first();
      if (await element.count() > 0) {
        await element.scrollIntoViewIfNeeded();
        await element.click({ force: true });
        console.log(`✅ Elemento marcado via ARIA: ${selector}`);
        return true;
      }
    }
  } catch (e) {
    console.log("⚠️ Error con selectores ARIA:", e.message);
  }

  // Estrategia 4: Buscar en iframes de verificación (Turnstile/hCaptcha)
  console.log("🧩 Intentando resolver verificación en iframe…");
  const iframeSolved = await clickTurnstileOrHCaptcha(page, { attempts: 3 });
  if (iframeSolved) {
    return true;
  }

  console.log("❌ No se pudo encontrar/marcar el checkbox de consentimiento");
  return false;
}

// También mejora la función clickTurnstileOrHCaptcha
async function clickTurnstileOrHCaptcha(page, { attempts = 3 } = {}) {
  for (let round = 1; round <= attempts; round++) {
    console.log(`🔄 Intento ${round}/${attempts} de resolver captcha…`);
    
    const frameLocator = page.frameLocator(
      'iframe[title*="turnstile" i], iframe[src*="challenges.cloudflare.com"], iframe[title*="checkbox" i], iframe[src*="hcaptcha.com"], iframe[src*="captcha"]'
    ).first();

    if (await frameLocator.count() === 0) {
      console.log("ℹ️ No se encontró iframe de verificación en este intento");
      await page.waitForTimeout(1000);
      continue;
    }

    try {
      // Intentar diferentes selectores dentro del iframe
      const selectors = [
        'input[type="checkbox"]',
        '[role="checkbox"]',
        '.mark',
        '.checkbox',
        'label',
        'div[tabindex]',
        '#cf-stage',
        '.ctp-checkbox',
        '.hcaptcha-box'
      ];

      let clicked = false;
      for (const selector of selectors) {
        try {
          const element = frameLocator.locator(selector).first();
          if (await element.count() > 0) {
            await element.click({ force: true, timeout: 3000 });
            console.log(`✅ Click en elemento del iframe: ${selector}`);
            clicked = true;
            
            // Esperar a que aparezca el token
            await page.waitForTimeout(2000);
            break;
          }
        } catch (e) {
          // Continuar con el siguiente selector
        }
      }

      if (!clicked) {
        // Fallback: click en el centro del iframe
        const frameHandle = await frameLocator.elementHandle();
        if (frameHandle) {
          const box = await frameHandle.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            console.log("✅ Click en centro del iframe (fallback)");
            clicked = true;
          }
        }
      }

      // Verificar si se generó token
      const tokenSelectors = [
        'input[name="cf-turnstile-response"]',
        'textarea[name="cf-turnstile-response"]', 
        'input[name="h-captcha-response"]',
        'textarea[name="h-captcha-response"]'
      ];

      for (const selector of tokenSelectors) {
        const token = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && el.value && el.value.length > 10 ? el.value : null;
        }, selector).catch(() => null);

        if (token) {
          console.log(`🔑 Token de verificación obtenido (longitud: ${token.length})`);
          return true;
        }
      }

      // Esperar antes del siguiente intento
      await page.waitForTimeout(2000);

    } catch (e) {
      console.log(`⚠️ Error en intento ${round}:`, e.message);
    }
  }

  return false;
}

async function waitForVerificationTokenOrError(page, timeoutMs = 15000) {
  const start = Date.now();
  const tokenSel =
    'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="h-captcha-response"], textarea[name="g-recaptcha-response"]';
  while (Date.now() - start < timeoutMs) {
    const failed = await page.locator('text=Verification failed').count();
    if (failed) return { failed: true, token: null };
    const token = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.value && el.value.length > 10 ? el.value : null;
    }, tokenSel);
    if (token) return { failed: false, token };
    await page.waitForTimeout(300);
  }
  return { failed: false, token: null };
}

async function waitForHumanSolve(page, maxMs = 120000) {
  console.log("⏸️ Esperando verificación humana manual (hasta 120s)…");
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { failed, token } = await waitForVerificationTokenOrError(page, 1500);
    if (token && !failed) {
      console.log("🙌 Verificación manual detectada (token presente).");
      return true;
    }
    await page.waitForTimeout(500);
  }
  console.log("⏱️ No se detectó verificación manual dentro del tiempo.");
  return false;
}

/* ==================== Flujo principal ==================== */
async function transcribeFromTmpOrPath({ mp3Path = null, keepOpen = false } = {}) {
  // 1) Resolver ruta del MP3
  let resolved = mp3Path && fs.existsSync(mp3Path) ? mp3Path : null;
  if (!resolved) resolved = findLatestMp3({ preferName: "video.mp3" });
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error("No se encontró ningún .mp3 en /tmp (ni ruta proporcionada).");
  }

  console.log("🎧 Archivo a subir:", resolved);
  const { context, page } = await createUndetectableBrowser();
  try {
    console.log("🌍 Cargando página de Riverside…");
    await page
      .goto("https://riverside.com/transcription#", { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => page.goto("https://riverside.fm/transcription#", { waitUntil: "domcontentloaded", timeout: 60000 }));

    await acceptCookiesIfAny(page);

    // 2) “Transcribe now”
    await clickTranscribeNowAndWaitUploadUI(page);

    // ===== SUBIDA =====
    let fileSet = false;

    // A) Interceptar filechooser
    try {
      console.log("📂 Preparando listener de filechooser y clic en '+'…");
      let chooserHandled = false;
      page.once("filechooser", async (fc) => {
        try { console.log("📎 Filechooser → setFiles:", resolved); await fc.setFiles(resolved); chooserHandled = true; }
        catch (e) { console.log("⚠️ Error asignando en filechooser:", e.message); }
      });
      const clicked = await clickNearestClickableOfPlusIcon(page);
      if (clicked) { await page.waitForTimeout(1200); }
      if (chooserHandled) { fileSet = true; console.log("✅ Archivo asignado vía filechooser."); }
    } catch (e) { console.log("ℹ️ Listener/Click chooser no disponible:", e.message); }

    // B) setInputFiles directo
    if (!fileSet) {
      console.log("📎 Buscando input[type=file]…");
      let fileInput = page.locator('input[type="file"]').first();
      for (let i = 0; i < 8 && !(await fileInput.count()); i++) {
        await page.waitForTimeout(350);
        fileInput = page.locator('input[type="file"]').first();
      }
      if (await fileInput.count()) {
        console.log("✅ Input localizado. Subiendo vía setInputFiles…");
        await fileInput.setInputFiles(resolved).catch(()=>{});
        fileSet = true;
      } else {
        // C) input cerca del “+”
        try {
          const handle = await page.evaluateHandle(() => {
            const plus = document.querySelector('svg path[d^="M10.0003 4.16602V15.8327"]');
            let el = plus ? plus.parentElement : null;
            while (el && el !== document.body) {
              const inp = el.querySelector('input[type="file"]');
              if (inp) return inp;
              el = el.parentElement;
            }
            return document.querySelector('input[type="file"]') || null;
          });
          if (handle) {
            console.log("🔎 Input cercano localizado via DOM → setInputFiles(handle)...");
            await handle.setInputFiles(resolved).catch(()=>{});
            fileSet = true;
          }
        } catch (e) { console.log("⚠️ No se pudo setear vía ElementHandle:", e.message); }
      }
    }

    if (!fileSet) throw new Error("❌ No se pudo subir el archivo: ni filechooser ni input[type=file] disponibles.");

    // Cerrar adjuntador
    await closeUploaderUI(page);

    // 3) Consentimiento (incluye Turnstile/hCaptcha)
    let consentOk = await markConsentCheckbox(page);

    // Comprobar estado de verificación
    let { failed, token } = await waitForVerificationTokenOrError(page, 5000);
    if (failed) {
      console.log("⚠️ Aparece 'Verification failed'. Reintentando verificación una vez…");
      consentOk = (await markConsentCheckbox(page)) || consentOk;
      ({ failed, token } = await waitForVerificationTokenOrError(page, 6000));
    }

    // Si sigue fallando, esperamos entrada humana (noVNC/VNC)
    if (failed || !token) {
      console.log("❗ Persisten errores de verificación o no hay token. Espera manual…");
      const human = await waitForHumanSolve(page, 120000);
      if (!human) {
        console.log("⛔ No se pudo completar la verificación humana. No pulsamos Start.");
      }
    }

    // 4) Start transcribing (solo si ya no falla)
    const stillFailed = (await page.locator('text=Verification failed').count()) > 0;
    console.log("▶️ Buscando botón 'Start transcribing'…");
    const startBtn = page.locator('#start-transcribing')
      .or(page.locator('button:has-text("Start transcribing")')).first();

    if (await startBtn.count()) {
      await startBtn.scrollIntoViewIfNeeded().catch(()=>{});
      const disabledAttr = await startBtn.getAttribute("disabled").catch(() => null);
      if (disabledAttr) {
        console.log("⌛ Start transcribing deshabilitado. Esperando breve…");
        await page.waitForTimeout(1500);
      }
      if (!stillFailed) {
        console.log("✅ Pulsando 'Start transcribing'…");
        await Promise.all([
          page.waitForLoadState("networkidle", { timeout: 90000 }).catch(()=>{}),
          startBtn.click().catch(()=>{}),
        ]);
      } else {
        console.log("⛔ No se pulsa Start por verificación fallida visible.");
      }
    } else {
      console.log("ℹ️ No se encontró botón de inicio (algunos flujos arrancan solos).");
    }

    // 5) Espera best-effort de transcripción
    console.log("🕰️ Esperando transcripción (máx 2 min)...");
    let transcript = "";
    try {
      await page.waitForSelector('[data-testid="transcript"], .transcript, [class*="transcript"]', { timeout: 120000 });
      const block = page.locator('[data-testid="transcript"], .transcript, [class*="transcript"]').first();
      if (await block.count()) {
        transcript = await block.innerText({ timeout: 10000 }).catch(() => "");
        console.log("📜 Fragmento transcrito:", transcript.slice(0, 150));
      } else {
        console.log("⚠️ Bloque de transcripción no encontrado.");
      }
    } catch (e) {
      console.warn("⌛ Timeout esperando transcripción:", e.message);
    }

    return {
      ok: true,
      usedFile: resolved,
      transcript,
      transcriptUrl: page.url(),
      started: !stillFailed,
      humanVerificationPassed: !stillFailed,
    };
  } finally {
    if (!keepOpen) {
      try { await context.close(); } catch {}
      try { await page.context().browser()?.close(); } catch {}
    }
  }
}

module.exports = {
  transcribeFromTmpOrPath,
  findLatestMp3,
};
