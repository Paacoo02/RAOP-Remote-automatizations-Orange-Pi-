// riverside.js
const fs = require("fs");
const os = require("os");
const path = require("path");

// Reutilizamos el navegador "indetectable" persistente del proyecto
const { createUndetectableBrowser } = require("./auto_log_in.js");

/* ==================== CONFIG DEBUG ==================== */
const DEBUG_NET = true;
const DEBUG_FETCH_XHR = true;
const BLOCK_SERVICE_WORKERS = false;
const UPLOAD_STUCK_TIMEOUT = 20000;
const UPLOAD_TOTAL_TIMEOUT = 180000;

/* ==================== Navegador limpio para Riverside ==================== */
async function createRiversideBrowser() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/* ==================== Utilidades de disco ==================== */
function findLatestMedia({
  preferNames = ["video.mp4", "video.mp3"],
  exts = [".mp3", ".wav", ".m4a", ".mp4", ".mov", ".mkv"],
  extraDirs = [],
} = {}) {
  const dirs = Array.from(
    new Set([os.tmpdir(), "/tmp", "/app/downloads", "/root/Downloads", ...extraDirs.filter(Boolean)])
  );

  const hits = [];
  for (const d of dirs) {
    try {
      const items = fs.readdirSync(d);
      for (const it of items) {
        if (!exts.some((e) => it.toLowerCase().endsWith(e))) continue;
        const p = path.join(d, it);
        const st = fs.statSync(p);
        hits.push({ file: p, mtime: st.mtimeMs });
      }
    } catch {}
  }
  if (!hits.length) return null;

  const exact = hits.find((h) =>
    preferNames.some((n) => path.basename(h.file).toLowerCase() === n.toLowerCase())
  );
  if (exact) return exact.file;

  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].file;
}

/* ==================== Helper genérico: parar en el primero que funcione ==================== */
async function runUntilTrue(tasks, { desc = "Tarea" } = {}) {
  for (const [name, fn] of tasks) {
    try {
      const res = await fn();
      if (res) {
        console.log(`✅ ${desc} completada con el método: ${name}`);
        return true;
      } else {
        console.log(`➡️  ${name}: sin efecto, probamos siguiente…`);
      }
    } catch (e) {
      console.log(`⚠️ ${name}: error → ${e.message}`);
    }
  }
  console.log(`⛔ ${desc}: ningún método tuvo éxito.`);
  return false;
}

/* ==================== Helpers UI ==================== */
async function acceptCookiesIfAny(page) {
  for (const sel of [
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    "text=Accept all",
    "text=Accept",
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        console.log("🍪 Aceptando cookies…");
        await btn.click({ timeout: 2000 }).catch(() => {});
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
    "#transcribe-main",
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
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(120);
        await el.click({ force: true });
        console.log(`✅ Click en '${sel}' (ronda ${round})`);
        clicked = true;
        break;
      } catch (e) {
        console.log(`⚠️ Fallo al pulsar '${sel}': ${e.message}`);
      }
    }
    if (!clicked) {
      await page.mouse.wheel(0, 700).catch(() => {});
    }

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
  try {
    await plusPath.scrollIntoViewIfNeeded().catch(() => {});
  } catch {}
  const parentBtn = plusPath.locator("xpath=ancestor::button[1]");
  if (await parentBtn.count()) {
    await parentBtn.click({ force: true }).catch(() => {});
    return true;
  }
  const parentAny = plusPath.locator("xpath=ancestor::*[self::button or self::div][1]");
  if (await parentAny.count()) {
    await parentAny.click({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

async function reliableClick(page, selector) {
  const el = page.locator(selector).first();
  if (!(await el.count())) return false;
  try { await el.scrollIntoViewIfNeeded(); } catch {}
  await page.waitForTimeout(100);
  try { await el.click({ timeout: 1500 }); return true; } catch {}
  try { const handle = await el.elementHandle(); if (handle) { await page.evaluate((n) => n.click(), handle); return true; } } catch {}
  try {
    const box = await el.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 60 });
      return true;
    }
  } catch {}
  return false;
}

/* ====== Cambiar idioma ====== */
async function setLanguageTo(page, target = "spanish") {
  console.log(`🌐 Cambiando idioma a: ${target}`);
  let opened = await reliableClick(page, "#lang-btn");
  if (!opened) {
    await page.evaluate(() => document.querySelector("#lang-btn")?.click()).catch(() => {});
    await page.waitForTimeout(150);
  }
  const optionCandidates = [
    `text=/^${target}$/i`,
    `//div[normalize-space(.)='${target}']`,
    `li:has-text("${target}")`,
    `button:has-text("${target}")`,
  ];
  let picked = false;
  for (const sel of optionCandidates) {
    try {
      const ok = await reliableClick(page, sel);
      if (ok) { picked = true; break; }
    } catch {}
  }
  if (!picked) {
    await page.evaluate((tgt) => {
      const all = Array.from(document.querySelectorAll("div,li,button,span"));
      const n = all.find((n) => (n.textContent || "").trim().toLowerCase() === tgt.toLowerCase());
      if (n) n.click();
    }, target).catch(() => {});
  }
  await page.waitForTimeout(200);
  const shown = await page
    .evaluate(() => document.querySelector("#selected-lang-name")?.textContent?.trim().toLowerCase() ?? null)
    .catch(() => null);
  const ok = shown === target.toLowerCase();
  console.log(ok ? `✅ Idioma seleccionado: ${shown}` : `❌ No se pudo confirmar idioma (mostrado: ${shown})`);
  return ok;
}

/* ====== MÉTODOS MEJORADOS PARA MARCAR EL CHECKBOX ====== */
async function debugCheckboxState(page) {
  console.log("🔍 DEBUG DETALLADO DEL CHECKBOX:");
  const checkbox = page.locator("#human-verification");
  if ((await checkbox.count()) === 0) {
    console.log("❌ Checkbox #human-verification no encontrado");
    return;
  }
  const state = await page.evaluate(() => {
    const cb = document.getElementById("human-verification");
    if (!cb) return null;
    return {
      checked: cb.checked,
      value: cb.value,
      attrs: Array.from(cb.attributes).map((a) => [a.name, a.value]),
      disabled: cb.disabled,
      readOnly: cb.readOnly,
      inForm: !!cb.closest("form"),
    };
  }).catch(() => null);
  console.log("📊 Estado del checkbox:", JSON.stringify(state, null, 2));
}

/* ====== ESTRATEGIAS MEJORADAS PARA MARCAR EL CHECKBOX ====== */
async function markConsentCheckboxEnhanced(page) {
  console.log("🎯 INICIANDO ESTRATEGIAS MEJORADAS PARA EL CHECKBOX");
  
  const checkbox = page.locator("#human-verification");
  if ((await checkbox.count()) === 0) {
    console.log("❌ Checkbox #human-verification no encontrado");
    return false;
  }

  // Estrategia 1: Scroll y verificación de visibilidad
  await checkbox.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  // Verificar estado inicial
  const initialState = await checkbox.isChecked().catch(() => false);
  if (initialState) {
    console.log("✅ Checkbox ya estaba marcado");
    return true;
  }

  // Estrategia 2: Método Playwright nativo
  console.log("🔄 Intentando método Playwright nativo...");
  try {
    await checkbox.check({ force: true, timeout: 3000 });
    if (await checkbox.isChecked().catch(() => false)) {
      console.log("✅ Marcado con .check() nativo");
      return true;
    }
  } catch (error) {
    console.log("⚠️ .check() nativo falló:", error.message);
  }

  // Estrategia 3: Click con force
  console.log("🔄 Intentando click con force...");
  try {
    await checkbox.click({ force: true, timeout: 3000 });
    await page.waitForTimeout(1000);
    if (await checkbox.isChecked().catch(() => false)) {
      console.log("✅ Marcado con click force");
      return true;
    }
  } catch (error) {
    console.log("⚠️ Click force falló:", error.message);
  }

  // Estrategia 4: JavaScript directo con eventos
  console.log("🔄 Intentando JavaScript directo...");
  const jsSuccess = await page.evaluate(() => {
    try {
      const cb = document.getElementById("human-verification");
      if (!cb) return false;
      
      // Método 1: Propiedad directa
      cb.checked = true;
      
      // Método 2: Atributo
      cb.setAttribute("checked", "checked");
      
      // Método 3: Dispatch todos los eventos posibles
      const events = ["click", "change", "input", "mousedown", "mouseup", "focus", "blur"];
      events.forEach(eventType => {
        cb.dispatchEvent(new Event(eventType, { bubbles: true }));
      });
      
      // Método 4: También en el formulario padre
      const form = cb.closest("form");
      if (form) {
        form.dispatchEvent(new Event("change", { bubbles: true }));
        form.dispatchEvent(new Event("input", { bubbles: true }));
      }
      
      return cb.checked;
    } catch (e) {
      return false;
    }
  }).catch(() => false);

  if (jsSuccess) {
    console.log("✅ Marcado con JavaScript directo");
    return true;
  }

  // Estrategia 5: Simulación de mouse real
  console.log("🔄 Intentando simulación de mouse real...");
  try {
    const box = await checkbox.boundingBox();
    if (box) {
      // Movimiento natural del mouse
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(200);
      await page.mouse.down();
      await page.waitForTimeout(100);
      await page.mouse.up();
      await page.waitForTimeout(500);
      
      if (await checkbox.isChecked().catch(() => false)) {
        console.log("✅ Marcado con simulación de mouse");
        return true;
      }
    }
  } catch (error) {
    console.log("⚠️ Simulación de mouse falló:", error.message);
  }

  // Estrategia 6: Label asociado
  console.log("🔄 Buscando label asociado...");
  const label = page.locator('label[for="human-verification"]');
  if (await label.count() > 0) {
    try {
      await label.click({ force: true, timeout: 2000 });
      await page.waitForTimeout(1000);
      if (await checkbox.isChecked().catch(() => false)) {
        console.log("✅ Marcado a través del label");
        return true;
      }
    } catch (error) {
      console.log("⚠️ Click en label falló:", error.message);
    }
  }

  // Estrategia 7: Método nuclear - modificación profunda
  console.log("💥 Intentando método nuclear...");
  const nuclearSuccess = await page.evaluate(() => {
    try {
      const cb = document.getElementById("human-verification");
      if (!cb) return false;
      
      // Acceso directo a propiedades
      Object.defineProperty(cb, 'checked', { value: true, writable: true });
      cb.checked = true;
      
      // Forzar actualización visual
      cb.style.setProperty('checked', 'true', 'important');
      cb.setAttribute('aria-checked', 'true');
      
      // Disparar TODOS los eventos posibles
      const allEvents = [
        'click', 'change', 'input', 'mousedown', 'mouseup', 
        'mouseover', 'mouseout', 'focus', 'blur', 'keydown', 'keyup'
      ];
      
      allEvents.forEach(eventType => {
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        cb.dispatchEvent(event);
      });
      
      // Forzar en el formulario completo
      const form = cb.closest('form');
      if (form) {
        ['change', 'input', 'submit'].forEach(eventType => {
          form.dispatchEvent(new Event(eventType, { bubbles: true }));
        });
      }
      
      return cb.checked;
    } catch (e) {
      return false;
    }
  }).catch(() => false);

  if (nuclearSuccess) {
    console.log("✅ Marcado con método nuclear");
    return true;
  }

  // Verificación final
  const finalState = await checkbox.isChecked().catch(() => false);
  console.log(`🔍 Estado final del checkbox: ${finalState ? 'MARCADO' : 'NO MARCADO'}`);
  
  return finalState;
}

/* ====== ACTIVACIÓN DEL BOTÓN START ====== */
async function activateStartButton(page) {
  console.log("🎯 Intentando activar botón Start Transcribing...");
  
  const startBtn = page.locator("#start-transcribing, button:has-text('Start transcribing')").first();
  
  if (!(await startBtn.count())) {
    console.log("❌ Botón Start no encontrado");
    return false;
  }

  // Verificar estado actual
  const isEnabled = await startBtn.isEnabled().catch(() => false);
  const isDisabled = await startBtn.getAttribute("disabled").catch(() => null);
  
  console.log(`🔍 Estado inicial - Enabled: ${isEnabled}, Disabled: ${isDisabled}`);
  
  if (isEnabled && !isDisabled) {
    console.log("✅ Botón ya está activado");
    return true;
  }

  // Estrategias para activar el botón
  console.log("🔄 Aplicando estrategias de activación...");

  // 1) Disparar eventos en todos los inputs
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, select, textarea');
    inputs.forEach(input => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  await page.waitForTimeout(1000);

  // 2) Forzar habilitación via JavaScript
  const forced = await page.evaluate(() => {
    const btn = document.querySelector('#start-transcribing') || 
                document.querySelector('button:has-text("Start transcribing")');
    if (!btn) return false;
    
    btn.removeAttribute('disabled');
    btn.disabled = false;
    
    // Disparar eventos de validación
    const form = btn.closest('form');
    if (form) {
      form.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    return !btn.disabled;
  }).catch(() => false);

  if (forced) {
    console.log("✅ Botón forzado via JavaScript");
  }

  // Verificación final
  const finalEnabled = await startBtn.isEnabled().catch(() => false);
  const finalDisabled = await startBtn.getAttribute("disabled").catch(() => null);
  
  console.log(`🔍 Estado final - Enabled: ${finalEnabled}, Disabled: ${finalDisabled}`);
  
  return finalEnabled && !finalDisabled;
}

// ... (mantener las funciones restantes igual: solveTurnstile, waitForVerificationTokenOrError, etc.)

/* ==================== FLUJO PRINCIPAL OPTIMIZADO ==================== */
async function transcribeFromTmpOrPath({
  mediaPath = null,
  keepOpen = true,
  useUndetectableBrowser = false,
} = {}) {
  // 1) Resolver ruta del archivo
  let resolved = mediaPath && fs.existsSync(mediaPath) ? mediaPath : null;
  if (!resolved) resolved = findLatestMedia();
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error("No se encontró ningún audio/vídeo en /tmp (ni ruta proporcionada).");
  }

  console.log("🎧 Archivo a subir:", resolved);

  // 2) Crear navegador
  let context, page, browser;
  if (useUndetectableBrowser) {
    const created = await createUndetectableBrowser();
    browser = created.browser;
    context = created.context;
    page = created.page;
  } else {
    const created = await createRiversideBrowser();
    browser = created.browser;
    context = created.context;
    page = created.page;
  }

  try {
    // Configuración de debug (mantener igual)
    // ...

    console.log("🌍 Cargando página de Riverside…");
    await page
      .goto("https://riverside.fm/transcription", { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => page.goto("https://riverside.com/transcription", { waitUntil: "domcontentloaded", timeout: 60000 }));

    await acceptCookiesIfAny(page);

    // Cambiar idioma ANTES de subir
    await setLanguageTo(page, "spanish").catch(() => {});

    // 3) Abrir UI de subida
    await clickTranscribeNowAndWaitUploadUI(page);

    // 4) SUBIDA DEL ARCHIVO (estrategias múltiples)
    console.log("📂 Subiendo archivo…");
    const fileSet = await runUntilTrue(
      [
        ["Filechooser + click en '+'", async () => {
          let chooserHandled = false;
          page.once("filechooser", async (fc) => {
            try {
              console.log("📎 Filechooser → setFiles:", resolved);
              await fc.setFiles(resolved);
              chooserHandled = true;
            } catch (e) {
              console.log("⚠️ Error en filechooser:", e.message);
            }
          });
          const clicked = await clickNearestClickableOfPlusIcon(page);
          if (clicked) await page.waitForTimeout(1200);
          return chooserHandled;
        }],
        ["Input directo", async () => {
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count()) {
            await fileInput.setInputFiles(resolved);
            return true;
          }
          return false;
        }]
      ],
      { desc: "Subida del archivo" }
    );

    if (!fileSet) {
      throw new Error("❌ No se pudo subir el archivo");
    }

    console.log("✅ Archivo subido exitosamente");
    await page.waitForTimeout(3000);

    // 5) **MARCAR CHECKBOX CON ESTRATEGIAS MEJORADAS**
    console.log("🎯 INICIANDO PROCESO DE MARCADO DEL CHECKBOX");
    
    // Debug inicial
    await debugCheckboxState(page).catch(() => {});
    
    // Intentar múltiples veces con diferentes estrategias
    let checkboxMarked = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`🔄 Intento ${attempt} de marcar checkbox...`);
      checkboxMarked = await markConsentCheckboxEnhanced(page);
      if (checkboxMarked) break;
      
      await page.waitForTimeout(2000);
      
      // Scroll adicional entre intentos
      await page.evaluate(() => {
        window.scrollBy(0, 100);
      });
    }

    if (!checkboxMarked) {
      console.log("❌ NO SE PUDO MARCAR EL CHECKBOX DESPUÉS DE 3 INTENTOS");
    } else {
      console.log("✅ CHECKBOX MARCADO EXITOSAMENTE");
    }

    // 6) ACTIVAR BOTÓN START
    console.log("🔄 Activando botón Start Transcribing...");
    const buttonActivated = await activateStartButton(page);
    
    if (buttonActivated) {
      console.log("✅ Botón Start activado - procediendo con click...");
      const startBtn = page.locator("#start-transcribing, button:has-text('Start transcribing')").first();
      await startBtn.click({ timeout: 5000 });
      console.log("🚀 Transcripción iniciada");
    } else {
      console.log("❌ No se pudo activar el botón Start");
    }

    // 7) ESPERAR RESULTADOS
    console.log("🕰️ Esperando transcripción...");
    let transcript = "";
    try {
      await page.waitForSelector('[data-testid="transcript"], .transcript, [class*="transcript"]', {
        timeout: 120000,
      });
      const block = page.locator('[data-testid="transcript"], .transcript, [class*="transcript"]').first();
      if (await block.count()) {
        transcript = await block.innerText({ timeout: 10000 }).catch(() => "");
        console.log("📜 Transcripción obtenida:");
        console.log(transcript.slice(0, 200));
      }
    } catch (e) {
      console.log("⚠️ No se pudo obtener transcripción:", e.message);
    }

    return {
      ok: checkboxMarked,
      usedFile: resolved,
      transcript,
      transcriptUrl: page.url(),
      started: buttonActivated,
      checkboxMarked: checkboxMarked,
    };

  } finally {
    if (keepOpen === false) {
      try { await context.close(); } catch {}
      try { await browser?.close(); } catch {}
    }
  }
}

module.exports = {
  transcribeFromTmpOrPath,
  findLatestMedia,
  createRiversideBrowser,
};