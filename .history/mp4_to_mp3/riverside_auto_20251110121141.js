// riverside.js
// ———————————————————————————————————————————————————————————————
// Flujo completo para subir y transcribir con Riverside, usando
// un navegador específico con Service Workers habilitados.
// Incluye depuración de red, parcheo de fetch/XHR, watchdog de
// progreso y trazas de Playwright.
// ———————————————————————————————————————————————————————————————

const fs = require("fs");
const os = require("os");
const path = require("path");

// Usamos el navegador específico para Riverside (NO tocamos el existente)
const { createRiversideBrowser } = require("./auto_log_in.js");

/* ==================== CONFIG DEBUG ==================== */
const DEBUG_NET = true;               // Logs de red request/response/failure
const DEBUG_FETCH_XHR = true;         // Parchea fetch/XHR dentro de la página
const BLOCK_SERVICE_WORKERS = false;  // ⛔ NO desregistrar SW (el uploader los usa)
const UPLOAD_STUCK_TIMEOUT = 20000;   // ms sin progreso => volcamos diagnóstico
const UPLOAD_TOTAL_TIMEOUT = 180000;  // ms timeout total de subida

/* ==================== Utilidades de disco ==================== */
function findLatestMp3({ preferName = "video.mp3", extraDirs = [] } = {}) {
  const dirs = Array.from(
    new Set([os.tmpdir(), "/tmp", "/app/downloads", "/root/Downloads", ...extraDirs.filter(Boolean)])
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

  const exact = hits.find(h => path.basename(h.file).toLowerCase() === preferName.toLowerCase());
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

/* No tocamos el input tras subir; solo cerramos overlays si existen */
async function closeUploaderUI(page) {
  console.log("🧹 Cerrando overlays/modales (sin tocar el input)…");
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
    if (handle) { await page.evaluate(n => n.click(), handle); return true; }
  } catch {}
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
      const n = all.find(n => (n.textContent || "").trim().toLowerCase() === tgt.toLowerCase());
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

/* ====== Debug del Checkbox ====== */
async function debugCheckboxState(page) {
  console.log("🔍 DEBUG DETALLADO DEL CHECKBOX:");
  const checkbox = page.locator("#human-verification");
  if ((await checkbox.count()) === 0) {
    console.log("❌ Checkbox #human-verification no encontrado");
    return;
  }
  const state = await page
    .evaluate(() => {
      const cb = document.getElementById("human-verification");
      if (!cb) return null;
      return {
        checked: cb.checked,
        value: cb.value,
        attrs: Array.from(cb.attributes).map(a => [a.name, a.value]),
        disabled: cb.disabled,
        readOnly: cb.readOnly,
        inForm: !!cb.closest('form')
      };
    })
    .catch(() => null);
  console.log("📊 Estado del checkbox:", JSON.stringify(state, null, 2));
}

/* ====== Verificación humana (tu lógica actual, intacta) ====== */
async function markConsentCheckbox(page) {
  console.log("☑️ Intentando marcar el consentimiento…");
  const checkbox = page.locator('#human-verification');
  if (await checkbox.count() === 0) { console.log("❌ No existe #human-verification"); return false; }

  const jsMethods = [
    () => { const cb = document.getElementById('human-verification'); if (cb){ cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true})); cb.dispatchEvent(new Event('click',{bubbles:true})); cb.dispatchEvent(new Event('input',{bubbles:true})); } },
    () => { const cb = document.getElementById('human-verification'); if (cb){ cb.focus(); cb.checked=true; cb.blur(); cb.dispatchEvent(new Event('change',{bubbles:true})); } },
    () => { const cb = document.getElementById('human-verification'); if (cb){ try{ Object.defineProperty(cb,'checked',{ value:true }); }catch{} cb.dispatchEvent(new MouseEvent('click',{bubbles:true})); cb.dispatchEvent(new Event('change',{bubbles:true})); } },
  ];
  for (let i=0;i<jsMethods.length;i++){
    console.log(`🔄 Método JS ${i+1}…`);
    await page.evaluate(jsMethods[i]);
    await page.waitForTimeout(800);
    if (await checkbox.isChecked().catch(()=>false)) { console.log(`✅ Marcado con método JS ${i+1}`); return true; }
  }

  console.log("👤 Simulando interacción humana…");
  await checkbox.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
  const box = await checkbox.boundingBox();
  if (box) {
    const steps = 10; const startX = box.x + box.width/2; const startY = box.y - 100;
    for (let s=0;s<=steps;s++){ const x=startX; const y=startY + (box.y-startY)*(s/steps); await page.mouse.move(x,y); await page.waitForTimeout(50); }
    await page.mouse.click(
      box.x + box.width/2 + Math.random()*10 - 5,
      box.y + box.height/2 + Math.random()*10 - 5,
      { delay: 100 + Math.random()*100 }
    );
    await page.waitForTimeout(1000);
    if (await checkbox.isChecked().catch(()=>false)) { console.log("✅ Marcado con simulación humana"); return true; }
  }

  console.log("🏷️ Click en label asociado…");
  const label = page.locator('label[for="human-verification"]');
  if (await label.count() > 0) {
    await label.click({ force: true });
    await page.waitForTimeout(800);
    if (await checkbox.isChecked().catch(()=>false)) { console.log("✅ Marcado vía label"); return true; }
  }

  console.log("💥 Enfoque nuclear…");
  await page.evaluate(()=>{
    const cb = document.getElementById('human-verification');
    if (cb){
      cb.checked=true; cb.setAttribute('checked','checked'); cb.value='on';
      ['click','change','input','mousedown','mouseup','focus','blur'].forEach(t=>cb.dispatchEvent(new Event(t,{bubbles:true})));
      const form = cb.closest('form'); if (form){ form.dispatchEvent(new Event('change',{bubbles:true})); form.dispatchEvent(new Event('input',{bubbles:true})); }
    }
  });
  await page.waitForTimeout(1200);
  const ok = await checkbox.isChecked().catch(()=>false);
  console.log(`ℹ️ Estado final checkbox: ${ok ? 'MARCADO' : 'NO MARCADO'}`);
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
      return (t1 && t1.value && t1.value.length > 10 && t1.value) ||
             (t2 && t2.value && t2.value.length > 10 && t2.value) || null;
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

/* ====== DEBUG PROFUNDO de red ====== */
async function attachDeepNetDebug(page) {
  if (DEBUG_NET) {
    page.on('request', req => {
      const url = req.url();
      if (/riverside|amazonaws|cloudfront|upload|transcrib|s3/i.test(url)) {
        console.log(`🌐→ ${req.method()} ${url}`);
      }
    });
    page.on('response', async res => {
      const url = res.url();
      if (/riverside|amazonaws|cloudfront|upload|transcrib|s3/i.test(url)) {
        const ct = res.headers()['content-type'] || '';
        console.log(`🌐← ${res.status()} ${url} ${ct}`);
        if (res.status() >= 400) {
          const body = await res.text().catch(()=>"(no body)");
          console.log(`   ⤷ BODY[${body.length}]: ${body.slice(0,300)}…`);
        }
      }
    });
    page.on('requestfailed', req => {
      const f = req.failure(); const url = req.url();
      if (/riverside|amazonaws|cloudfront|upload|transcrib|s3/i.test(url)) {
        console.log(`❌ ${req.method()} ${url} — ${f?.errorText || 'unknown'}`);
      }
    });
  }
  page.on('console', msg => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') console.log(`🖥️  console.${t}:`, msg.text());
    else if (/^\[UPLOAD|^\[XHR|^\[FETCH|^\[SW\]/.test(msg.text())) console.log(msg.text());
  });
  page.on('pageerror', err => console.log("💥 pageerror:", err.message));
}

/* ====== Parchear fetch/XHR para ver progreso y errores ====== */
async function patchFetchAndXHR(page) {
  if (!DEBUG_FETCH_XHR) return;
  await page.addInitScript(() => {
    // XHR
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest){
      this.__method = method; this.__url = url;
      this.addEventListener('loadstart', ()=>console.log(`[XHR] loadstart ${method} ${url}`));
      this.addEventListener('progress', (e)=>console.log(`[XHR] progress ${method} ${url} len=${e.lengthComputable?'yes':'no'} loaded=${e.loaded} total=${e.total||0}`));
      this.addEventListener('loadend', ()=>console.log(`[XHR] loadend ${method} ${url} status=${this.status}`));
      this.upload && this.upload.addEventListener('progress', (e)=>console.log(`[UPLOAD] xhr ${url} loaded=${e.loaded} total=${e.total||0} len=${e.lengthComputable?'yes':'no'}`));
      return _open.apply(this,[method,url,...rest]);
    };
    XMLHttpRequest.prototype.send = function(body){
      if (body && body.size) console.log(`[XHR] send blob size=${body.size} to ${this.__url}`);
      return _send.apply(this,[body]);
    };
    // fetch
    const _fetch = window.fetch;
    window.fetch = async (...args)=>{
      const url = String(args[0]);
      console.log(`[FETCH] ${url}`);
      try {
        const res = await _fetch(...args);
        console.log(`[FETCH←] ${res.status} ${url}`);
        return res;
      } catch (e) {
        console.log(`[FETCH❌] ${url} ${e?.message||e}`);
        throw e;
      }
    };
  });
}

/* ====== (Opcional) Borrar Service Workers — aquí NO se usa ====== */
async function nukeServiceWorkers(page) {
  if (!BLOCK_SERVICE_WORKERS) return;
  try {
    await page.addInitScript(() => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(rs => {
          rs.forEach(r => r.unregister().then(()=>console.log('[SW] unregistered')));
        }).catch(()=>{});
      }
    });
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        const rs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map(r => r.unregister()));
        console.log('[SW] registrations cleared at runtime');
      }
    }).catch(()=>{});
  } catch (e) { console.log("SW error:", e.message); }
}

/* ====== Watchdog/espera de procesamiento de subida ====== */
async function waitUploadProcessed(page, { totalTimeout = UPLOAD_TOTAL_TIMEOUT, stuckTimeout = UPLOAD_STUCK_TIMEOUT } = {}) {
  console.log("⏳ Esperando a que Riverside procese el archivo…");
  const t0 = Date.now();
  let lastPct = null, lastTick = Date.now();

  while (Date.now() - t0 < totalTimeout) {
    // % en la UI
    const pct = await page.evaluate(() => {
      const txt = document.body.textContent || "";
      const m = txt.match(/(\d{1,3})\s?%/);
      return m ? parseInt(m[1],10) : null;
    }).catch(()=>null);

    // señales de UI lista
    const replaceVisible = (await page.locator('text=Replace').count()) > 0;
    const fileNameVisible = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("div,span"));
      return !!nodes.find(n => /\.mp3$|\.wav$|\.m4a$|\.mp4$|\.mov$|\.mkv$/i.test((n.textContent||"").trim()));
    }).catch(()=>false);

    if (replaceVisible || (pct !== null && pct >= 100) || fileNameVisible) {
      console.log(`✅ Subida procesada (UI=${replaceVisible?'Replace':fileNameVisible?'filename':'100%'})`);
      return true;
    }

    // Watchdog de “atasco”
    if (pct !== null) {
      if (lastPct === null || pct > lastPct) { lastPct = pct; lastTick = Date.now(); }
      if (Date.now() - lastTick > stuckTimeout) {
        console.log(`🛑 Subida atascada en ${lastPct ?? 0}% durante > ${stuckTimeout} ms. Volcando diagnóstico…`);
        await dumpUploadDiagnosis(page);
        lastTick = Date.now(); // evita spam
      }
    } else {
      // Si ni siquiera hay %, intenta confirmar que el input tiene el file
      await logInputFileInfo(page);
    }

    await page.waitForTimeout(500);
  }
  console.log("⚠️ Timeout general esperando procesamiento de subida.");
  await dumpUploadDiagnosis(page);
  return false;
}

async function logInputFileInfo(page) {
  try {
    const info = await page.evaluate(() => {
      const inp = document.querySelector('input[type="file"]');
      if (!inp) return { present:false };
      const f = inp.files && inp.files[0];
      return f ? { present:true, name:f.name, size:f.size, type:f.type, lastModified:f.lastModified } : { present:true, empty:true };
    });
    console.log("📁 input[type=file] info:", info);
  } catch {}
}

async function dumpUploadDiagnosis(page) {
  // 1) Info del input
  await logInputFileInfo(page);

  // 2) Estado navigator/red
  try {
    const nav = await page.evaluate(() => ({
      onLine: navigator.onLine,
      ua: navigator.userAgent,
      lang: navigator.language,
      sw: !!(navigator.serviceWorker),
      conn: (navigator.connection && {
        downlink: navigator.connection.downlink,
        effectiveType: navigator.connection.effectiveType,
        saveData: navigator.connection.saveData
      }) || null
    }));
    console.log("🌍 navigator:", nav);
  } catch {}

  // 3) Últimos errores de consola ya vienen por page.on('console')

  // 4) Intento listar recursos recientes (por si vemos S3/CloudFront)
  try {
    const recent = await page.evaluate(() => {
      const now = performance.now();
      return performance.getEntriesByType('resource')
        .filter(e => now - e.startTime < 15000)
        .map(e => ({ name: e.name, initiatorType: e.initiatorType, transferSize: e.transferSize || null }))
        .slice(-20);
    });
    console.log("📈 Recursos recientes:", recent);
  } catch {}
}

/* ====== (Opcional) Esperar Turnstile/hCaptcha antes de subir ====== */
async function waitTurnstileToken(page, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const token = await page.evaluate(() => {
      const el1 = document.querySelector('input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"]');
      const el2 = document.querySelector('input[name="h-captcha-response"],textarea[name="h-captcha-response"]');
      return (el1 && el1.value && el1.value.length > 10 && el1.value) ||
             (el2 && el2.value && el2.value.length > 10 && el2.value) || null;
    }).catch(()=>null);
    if (token) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/* ==================== FLUJO PRINCIPAL ==================== */
async function transcribeFromTmpOrPath({ mp3Path = null, keepOpen = false } = {}) {
  // 1) Resolver ruta del MP3
  let resolved = mp3Path && fs.existsSync(mp3Path) ? mp3Path : null;
  if (!resolved) resolved = findLatestMp3({ preferName: "video.mp3" });
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error("No se encontró ningún .mp3 en /tmp (ni ruta proporcionada).");
  }

  console.log("🎧 Archivo a subir:", resolved);
  const { context, page } = await createRiversideBrowser();

  try {
    await attachDeepNetDebug(page);
    await patchFetchAndXHR(page);

    // Tracing Playwright global (diagnóstico)
    try {
      const art = '/app/artifacts';
      try { fs.mkdirSync(art, { recursive: true }); } catch {}
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    } catch {}

    console.log("🌍 Cargando página de Riverside…");
    await page
      .goto("https://riverside.fm/transcription#", { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => page.goto("https://riverside.com/transcription#", { waitUntil: "domcontentloaded", timeout: 60000 }));

    await acceptCookiesIfAny(page);
    // NO desregistrar Service Workers (clave para upload moderno)
    // if (BLOCK_SERVICE_WORKERS) await nukeServiceWorkers(page);

    // 2) Abrir UI de subida
    await clickTranscribeNowAndWaitUploadUI(page);

    // (Opcional) Espera breve de Turnstile/hCaptcha
    const hasToken = await waitTurnstileToken(page, 8000);
    console.log(hasToken ? '✅ Turnstile listo' : '⚠️ Sin token Turnstile (continuamos best-effort)');

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
                try {
                  console.log("📎 Filechooser → setFiles:", resolved);
                  await fc.setFiles(resolved);
                  chooserHandled = true;
                } catch (e) {
                  console.log("⚠️ Error asignando en filechooser:", e.message);
                }
              });
              const clicked = await clickNearestClickableOfPlusIcon(page);
              if (clicked) await page.waitForTimeout(1200);
              return chooserHandled;
            } catch {
              return false;
            }
          },
        ],
        [
          "setInputFiles en input[type=file]",
          async () => {
            let fileInput = page.locator('input[type="file"]').first();
            for (let i = 0; i < 10 && !(await fileInput.count()); i++) {
              await page.waitForTimeout(350);
              fileInput = page.locator('input[type="file"]').first();
            }
            if (await fileInput.count()) {
              console.log("✅ Input localizado. Subiendo vía setInputFiles…");
              await fileInput.setInputFiles(resolved).catch(() => {});
              await logInputFileInfo(page);
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
              await logInputFileInfo(page);
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

    // 3.1) Esperar a progreso real o diagnóstico si se queda a 0 %
    const processed = await waitUploadProcessed(page, {
      totalTimeout: UPLOAD_TOTAL_TIMEOUT,
      stuckTimeout: UPLOAD_STUCK_TIMEOUT,
    });
    if (!processed) console.log("⚠️ Continuamos aunque no confirmó procesamiento UI (puede haber lag).");

    // 4) Idioma y checkbox (según tu flujo)
    await closeUploaderUI(page);
    await setLanguageTo(page, "spanish").catch(() => {});

    console.log("🔍 Debug inicial del checkbox...");
    await debugCheckboxState(page).catch(() => {});
    await markConsentCheckbox(page);

    // 5) Verificación
    let { failed } = await waitForVerificationTokenOrError(page, 2000);
    if (failed) {
      const checkedNow = await page.locator("#human-verification").isChecked().catch(() => false);
      if (!checkedNow) {
        console.log("↪️ Reintento de marcado…");
        await markConsentCheckbox(page);
      }
    }

    const stillFailed = await isVerificationFailedPersistently(page, 2500);
    console.log(stillFailed ? "⛔ FALLO persistente de verificación" : "🟢 Sin fallo persistente (ok para continuar)");

    // 6) Start (si procede)
    console.log("▶️ Buscando botón 'Start transcribing'…");
    const startBtn = page
      .locator("#start-transcribing")
      .or(page.locator('button:has-text("Start transcribing")'))
      .first();
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

    // 7) Espera best-effort de transcripción
    console.log("🕰️ Esperando transcripción (máx 2 min)...");
    let transcript = "";
    try {
      await page.waitForSelector(
        '[data-testid="transcript"], .transcript, [class*="transcript"]',
        { timeout: 120000 }
      );
      const block = page
        .locator('[data-testid="transcript"], .transcript, [class*="transcript"]')
        .first();
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
    // Guardamos el trace siempre (no cerramos el navegador)
    try { await context.tracing.stop({ path: '/app/artifacts/riverside-trace.zip' }); } catch {}
    // Por tu petición: no cerramos el browser/context aquí
  }
}

module.exports = { transcribeFromTmpOrPath, findLatestMp3 };
