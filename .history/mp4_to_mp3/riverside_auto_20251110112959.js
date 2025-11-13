const fs = require("fs");
const os = require("os");
const path = require("path");

// Reutilizamos el navegador "indetectable" persistente del proyecto
const { createUndetectableBrowser } = require("./auto_log_in.js");

/* ==================== Utilidades de disco ==================== */
function findLatestMp3({ preferName = "video.mp3", extraDirs = [] } = {}) {
  const dirs = Array.from(
    new Set([
      os.tmpdir(),
      "/tmp",
      "/app/downloads",
      "/root/Downloads",
      ...extraDirs.filter(Boolean),
    ])
  );

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

  const exact = hits.find(
    (h) => path.basename(h.file).toLowerCase() === preferName.toLowerCase()
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
    if (!clicked) { await page.mouse.wheel(0, 700).catch(() => {}); }

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
  try { await plusPath.scrollIntoViewIfNeeded().catch(() => {}); } catch {}
  const parentBtn = plusPath.locator("xpath=ancestor::button[1]");
  if (await parentBtn.count()) { await parentBtn.click({ force: true }).catch(() => {}); return true; }
  const parentAny = plusPath.locator("xpath=ancestor::*[self::button or self::div][1]");
  if (await parentAny.count()) { await parentAny.click({ force: true }).catch(() => {}); return true; }
  return false;
}

/* ⛔ IMPORTANTE: ya NO vaciamos ni ocultamos el input tras subir */
async function closeUploaderUI(page) {
  console.log("🧹 Cerrando overlays/modales de subida (sin tocar el input)…");
  for (const sel of [
    'button[aria-label="Close"]',
    'button:has-text("Close")',
    'button:has-text("Done")',
    'button:has-text("Cancel")',
    '[role="dialog"] button[aria-label="Close"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) await el.click({ timeout: 1000 }).catch(() => {});
    } catch {}
  }
  try { await page.keyboard.press("Escape"); } catch {}
  try { await page.mouse.click(10, 10); } catch {}
  await page.waitForTimeout(250);
}

/* ====== Click fiable ====== */
async function reliableClick(page, selector) {
  const el = page.locator(selector).first();
  if (!(await el.count())) return false;
  try { await el.scrollIntoViewIfNeeded(); } catch {}
  await page.waitForTimeout(100);

  try { await el.click({ timeout: 1500 }); return true; } catch {}
  try {
    const handle = await el.elementHandle();
    if (handle) { await page.evaluate((n)=>n.click(), handle); return true; }
  } catch {}
  try {
    const box = await el.boundingBox();
    if (box) { await page.mouse.click(box.x + box.width/2, box.y + box.height/2, { delay: 60 }); return true; }
  } catch {}
  return false;
}

/* ====== Cambiar idioma ====== */
async function setLanguageTo(page, target = "spanish") {
  console.log(`🌐 Cambiando idioma a: ${target}`);
  let opened = await reliableClick(page, "#lang-btn");
  if (!opened) {
    await page.evaluate(() => document.querySelector("#lang-btn")?.click()).catch(()=>{});
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
      const node = all.find(n => (n.textContent||"").trim().toLowerCase() === tgt.toLowerCase());
      if (node) node.click();
    }, target).catch(()=>{});
  }
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => {
    const el = document.querySelector("#selected-lang-name");
    return el ? (el.textContent||"").trim().toLowerCase() : null;
  }).catch(()=>null);

  const ok = shown === target.toLowerCase();
  console.log(ok ? `✅ Idioma seleccionado: ${shown}` : `❌ No se pudo confirmar idioma (mostrado: ${shown})`);
  return ok;
}

/* ====== Debug del Checkbox ====== */
async function debugCheckboxState(page) {
  console.log("🔍 DEBUG DETALLADO DEL CHECKBOX:");
  const checkbox = page.locator("#human-verification");
  if ((await checkbox.count()) === 0) { console.log("❌ Checkbox #human-verification no encontrado"); return; }
  const state = await page.evaluate(() => {
    const cb = document.getElementById("human-verification");
    if (!cb) return null;
    return {
      checked: cb.checked,
      value: cb.value,
      attributes: Array.from(cb.attributes).map(a=>({name:a.name,value:a.value})),
      disabled: cb.disabled,
      readOnly: cb.readOnly,
      style: cb.style.cssText,
      parentHTML: cb.parentElement ? cb.parentElement.outerHTML.slice(0,200) : "no parent",
      eventListeners: { click: cb.onclick ? "present" : "none", change: cb.onchange ? "present" : "none" },
    };
  }).catch(()=>null);
  console.log("📊 Estado del checkbox:", JSON.stringify(state, null, 2));
}

/* ====== Verificación: método 3 estabilizado e idempotente (igual que tenías) ====== */
async function markConsentCheckbox(page) {
  console.log("☑️ Intentando marcar el consentimiento…");
  const checkbox = page.locator('#human-verification');
  if (await checkbox.count() === 0) { console.log("❌ No existe #human-verification"); return false; }

  const jsMethods = [
    () => { const cb = document.getElementById('human-verification'); if (cb){ cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); cb.dispatchEvent(new Event('click',{bubbles:true})); cb.dispatchEvent(new Event('input',{bubbles:true})); } },
    () => { const cb = document.getElementById('human-verification'); if (cb){ cb.focus(); cb.checked = true; cb.blur(); cb.dispatchEvent(new Event('change',{bubbles:true})); } },
    () => { const cb = document.getElementById('human-verification'); if (cb){ try{ Object.defineProperty(cb,'checked',{ value:true }); }catch{} cb.dispatchEvent(new MouseEvent('click',{bubbles:true})); cb.dispatchEvent(new Event('change',{bubbles:true})); } },
  ];
  for (let i=0;i<jsMethods.length;i++){
    console.log(`🔄 Intentando método JavaScript ${i+1}...`);
    await page.evaluate(jsMethods[i]);
    await page.waitForTimeout(800);
    if (await checkbox.isChecked().catch(()=>false)) { console.log(`✅ Checkbox marcado con método JS ${i+1}`); return true; }
  }

  console.log("👤 Simulando interacción humana…");
  await checkbox.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const box = await checkbox.boundingBox();
  if (box) {
    const steps = 10;
    const startX = box.x + box.width/2, startY = box.y - 100;
    for (let s=0;s<=steps;s++){ const x=startX; const y=startY + (box.y-startY)*(s/steps); await page.mouse.move(x,y); await page.waitForTimeout(50); }
    await page.mouse.click(box.x + box.width/2 + Math.random()*10 - 5, box.y + box.height/2 + Math.random()*10 - 5, { delay: 100 + Math.random()*100 });
    await page.waitForTimeout(1000);
    if (await checkbox.isChecked().catch(()=>false)) { console.log("✅ Checkbox marcado con simulación humana"); return true; }
  }

  console.log("🏷️ Buscando label asociado…");
  const label = page.locator('label[for="human-verification"]');
  if (await label.count() > 0) {
    await label.click({ force: true });
    await page.waitForTimeout(800);
    if (await checkbox.isChecked().catch(()=>false)) { console.log("✅ Checkbox marcado a través del label"); return true; }
  }

  console.log("💥 Enfoque nuclear…");
  await page.evaluate(()=>{
    const cb = document.getElementById('human-verification');
    if (cb){
      cb.checked = true; cb.setAttribute('checked','checked'); cb.value='on';
      ['click','change','input','mousedown','mouseup','focus','blur'].forEach(t=>cb.dispatchEvent(new Event(t,{bubbles:true})));
      const form = cb.closest('form'); if (form){ form.dispatchEvent(new Event('change',{bubbles:true})); form.dispatchEvent(new Event('input',{bubbles:true})); }
    }
  });
  await page.waitForTimeout(1200);
  const ok = await checkbox.isChecked().catch(()=>false);
  console.log(`ℹ️ Estado final del checkbox: ${ok ? 'MARCADO' : 'NO MARCADO'}`);
  return ok;
}

/* ====== Señalización de verificación ====== */
async function waitForVerificationTokenOrError(page, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const failed =
      (await page.locator("text=Verification failed").count()) > 0 ||
      (await page.locator("text=verification failed").count()) > 0 ||
      (await page.locator("text=Human verification failed").count()) > 0 ||
      (await page.locator(".verification-error").count()) > 0;
    if (failed) return { failed: true, token: null };

    const token = await page.evaluate(() => {
      const t1 = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
      const t2 = document.querySelector('input[name="h-captcha-response"], textarea[name="h-captcha-response"]');
      return (t1 && t1.value && t1.value.length > 10 && t1.value) || (t2 && t2.value && t2.value.length > 10 && t2.value) || null;
    }).catch(()=>null);
    if (token) return { failed: false, token };

    const visualOk =
      (await page.locator(".verification-success, .success, [class*='success']").count()) > 0 ||
      (await page.locator("text=Verification successful").count()) > 0;
    if (visualOk) return { failed: false, token: "visual_success" };

    await page.waitForTimeout(200);
  }
  return { failed: false, token: null };
}

async function isVerificationFailedPersistently(page, windowMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const failed =
      (await page.locator("text=Verification failed").count()) > 0 ||
      (await page.locator("text=verification failed").count()) > 0 ||
      (await page.locator("text=Human verification failed").count()) > 0 ||
      (await page.locator(".verification-error").count()) > 0;
    if (!failed) return false;
    await page.waitForTimeout(150);
  }
  return true;
}

/* ====== Espera robusta al procesamiento de subida ====== */
async function waitUploadProcessed(page, { timeoutMs = 120000 } = {}) {
  console.log("⏳ Esperando a que Riverside procese el archivo…");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // 1) Señal de “archivo reconocido”
    const hasReplace = (await page.locator('text=Replace').count()) > 0;
    const filenameShown = await page.evaluate(() => {
      const panels = Array.from(document.querySelectorAll("div,span"));
      const hit = panels.find(n => /\.mp3$|\.wav$|\.m4a$|\.mp4$|\.mov$|\.mkv$/i.test((n.textContent||"").trim()));
      return !!hit;
    }).catch(()=>false);

    // 2) Porcentaje de progreso
    const pct = await page.evaluate(() => {
      const m = (document.body.textContent||"").match(/(\d{1,3})\s?%/);
      return m ? parseInt(m[1],10) : null;
    }).catch(()=>null);

    if (hasReplace || filenameShown || (pct !== null && pct >= 1)) {
      console.log(`🔹 Progreso detectado: ${pct !== null ? pct + '%' : (hasReplace ? 'Replace visible' : 'nombre visible')}`);
    }
    // Consideramos “listo” cuando:
    //  - aparece “Replace”, o
    //  - porcentaje llega a 100% o deja de cambiar durante ~3s (estabilizado)
    if (hasReplace || (pct !== null && pct >= 100)) {
      console.log("✅ Archivo reconocido/procesado por la UI.");
      return true;
    }

    await page.waitForTimeout(500);
  }
  console.log("⚠️ Timeout esperando procesamiento de subida.");
  return false;
}

/* ==================== Flujo principal ==================== */
async function transcribeFromTmpOrPath({
  mp3Path = null,
  keepOpen = false,
} = {}) {
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
      .goto("https://riverside.com/transcription#", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch(() =>
        page.goto("https://riverside.fm/transcription#", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        })
      );

    await acceptCookiesIfAny(page);

    // 2) Abrir UI de subida
    await clickTranscribeNowAndWaitUploadUI(page);

    // 3) SUBIDA (parar en el primero que funcione)
    console.log("📂 Subiendo archivo…");
    const fileSet = await runUntilTrue(
      [
        [
          "Filechooser + click en '+'",
          async () => {
            let chooserHandled = false;
            try {
              page.once("filechooser", async (fc) => {
                try { console.log("📎 Filechooser → setFiles:", resolved); await fc.setFiles(resolved); chooserHandled = true; }
                catch (e) { console.log("⚠️ Error asignando en filechooser:", e.message); }
              });
              const clicked = await clickNearestClickableOfPlusIcon(page);
              if (clicked) await page.waitForTimeout(1200);
              return chooserHandled;
            } catch { return false; }
          },
        ],
        [
          "setInputFiles en input[type=file]",
          async () => {
            let fileInput = page.locator('input[type="file"]').first();
            for (let i = 0; i < 8 && !(await fileInput.count()); i++) {
              await page.waitForTimeout(350);
              fileInput = page.locator('input[type="file"]').first();
            }
            if (await fileInput.count()) {
              console.log("✅ Input localizado. Subiendo vía setInputFiles…");
              await fileInput.setInputFiles(resolved).catch(() => {});
              return true;
            }
            return false;
          },
        ],
        [
          "ElementHandle cercano al '+' → setInputFiles",
          async () => {
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
              if (!handle) return false;
              console.log("🔎 Input cercano localizado via DOM → setInputFiles(handle)…");
              await handle.setInputFiles(resolved).catch(() => {});
              return true;
            } catch (e) {
              console.log("⚠️ No se pudo setear vía ElementHandle:", e.message);
              return false;
            }
          },
        ],
      ],
      { desc: "Subida del archivo" }
    );

    if (!fileSet) throw new Error("❌ No se pudo subir el archivo: ni filechooser ni input[type=file] disponibles.");

    // ⏱️ Esperar a que la app reconozca/procese el archivo
    const processed = await waitUploadProcessed(page, { timeoutMs: 120000 });
    if (!processed) console.log("⚠️ Continuamos aunque no confirmó procesamiento UI (puede haber lag).");

    // (si hay overlays de diálogo, cerrarlos sin tocar el input)
    await closeUploaderUI(page);

    // 4) Primero cambiar el idioma (tu requisito)
    await setLanguageTo(page, "spanish").catch(()=>{});

    // 5) Luego marcar el checkbox tal cual lo tienes montado
    console.log("🔍 Debug inicial del checkbox (opcional)...");
    await debugCheckboxState(page).catch(() => {});
    await markConsentCheckbox(page);

    // 6) Señalización/verificación
    let { failed } = await waitForVerificationTokenOrError(page, 2000);
    if (failed) {
      const checkedNow = await page.locator("#human-verification").isChecked().catch(() => false);
      if (!checkedNow) { console.log("↪️ Reintento de marcado tras fallo…"); await markConsentCheckbox(page); }
    }

    const stillFailed = await isVerificationFailedPersistently(page, 2500);
    console.log(stillFailed ? "⛔ FALLO persistente de verificación" : "🟢 Sin fallo persistente (ok para continuar)");

    // 7) Opcional: pulsar Start si está habilitado
    console.log("▶️ Buscando botón 'Start transcribing'…");
    const startBtn = page.locator("#start-transcribing").or(page.locator('button:has-text("Start transcribing")')).first();
    if (await startBtn.count()) {
      await startBtn.scrollIntoViewIfNeeded().catch(() => {});
      const disabledAttr = await startBtn.getAttribute("disabled").catch(() => null);
      console.log(`🔎 Estado Start → disabled=${!!disabledAttr}`);
      if (!disabledAttr && !stillFailed) {
        console.log("✅ Pulsando 'Start transcribing'…");
        await Promise.all([
          page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {}),
          startBtn.click().catch(() => {}),
        ]);
      } else {
        console.log("ℹ️ Start deshabilitado o verificación fallida; no clico.");
      }
    } else {
      console.log("ℹ️ No se encontró botón de inicio (algunos flujos arrancan solos).");
    }

    // 8) Espera best-effort de transcripción
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
      ok: !stillFailed,
      usedFile: resolved,
      transcript,
      transcriptUrl: page.url(),
      started: !stillFailed,
      humanVerificationPassed: !stillFailed,
    };
  } finally {
    // No cerramos el navegador aunque falle.
  }
}

module.exports = {
  transcribeFromTmpOrPath,
  findLatestMp3,
};
