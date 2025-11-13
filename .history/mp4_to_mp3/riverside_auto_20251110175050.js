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
    acceptDownloads: true, // ← necesario para capturar descargas
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
  try { await plusPath.scrollIntoViewIfNeeded().catch(() => {}); } catch {}
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

/* ====== Scroll seguro (sin bloquear) ====== */
async function safeScrollIntoView(locator, timeout = 1200) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout });
    return true;
  } catch {
    try {
      const handle = await locator.elementHandle();
      if (handle) {
        await handle.evaluate((el) => {
          try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
          let p = el.parentElement;
          while (p) {
            const cs = getComputedStyle(p);
            const canScroll = /(auto|scroll)/.test(cs.overflowY + cs.overflowX);
            if (canScroll) {
              const r = el.getBoundingClientRect();
              const pr = p.getBoundingClientRect();
              p.scrollTop += (r.top - pr.top) - (p.clientHeight / 2 - r.height / 2);
              p.scrollLeft += (r.left - pr.left) - (p.clientWidth / 2 - r.width / 2);
              break;
            }
            p = p.parentElement;
          }
        });
        return true;
      }
    } catch {}
  }
  return false;
}

/* ====== DEBUG CHECKBOX / TURNSTILE / START ====== */
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
      visible: !!(cb.offsetParent),
    };
  }).catch(() => null);
  console.log("📊 Estado del checkbox:", JSON.stringify(state, null, 2));
}

async function markConsentCheckboxEnhanced(page) {
  console.log("🎯 INICIANDO ESTRATEGIAS MEJORADAS PARA EL CHECKBOX");
  const checkbox = page.locator("#human-verification");
  if ((await checkbox.count()) === 0) {
    console.log("❌ Checkbox #human-verification no encontrado (posible Turnstile invisible).");
    return false;
  }
  await safeScrollIntoView(checkbox, 1200).catch(() => {});
  await page.waitForTimeout(250).catch(()=>{});
  try {
    if (await checkbox.isChecked({ timeout: 500 }).catch(() => false)) {
      console.log("✅ Checkbox ya estaba marcado");
      return true;
    }
  } catch {}
  try {
    await checkbox.check({ force: true, timeout: 1200 });
    if (await checkbox.isChecked().catch(() => false)) {
      console.log("✅ Marcado con .check() nativo");
      return true;
    }
  } catch {}
  try {
    await checkbox.click({ force: true, timeout: 1200 });
    await page.waitForTimeout(200);
    if (await checkbox.isChecked().catch(() => false)) {
      console.log("✅ Marcado con click force");
      return true;
    }
  } catch {}
  const jsSuccess = await page.evaluate(() => {
    try {
      const cb = document.getElementById("human-verification");
      if (!cb) return false;
      cb.checked = true;
      cb.setAttribute("checked", "checked");
      ["click", "change", "input"].forEach(t =>
        cb.dispatchEvent(new Event(t, { bubbles: true }))
      );
      const form = cb.closest("form");
      if (form) ["change", "input"].forEach(t => form.dispatchEvent(new Event(t, { bubbles: true })));
      return cb.checked;
    } catch { return false; }
  }).catch(() => false);
  if (jsSuccess) return true;
  try {
    const label = page.locator('label[for="human-verification"]').first();
    if (await label.count()) {
      await label.click({ force: true, timeout: 1200 });
      await page.waitForTimeout(200);
      if (await checkbox.isChecked().catch(() => false)) return true;
    }
  } catch {}
  try {
    const box = await checkbox.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.waitForTimeout(50); await page.mouse.up();
      await page.waitForTimeout(200);
      if (await checkbox.isChecked().catch(() => false)) return true;
    }
  } catch {}
  console.log("⚠️ No se pudo marcar el checkbox (continuamos sin abortar).");
  return false;
}

async function solveTurnstile(page, { timeoutMs = 15000 } = {}) {
  console.log("🧩 Intentando resolver Cloudflare Turnstile (best-effort)…");
  try {
    const ifr = page.frameLocator('iframe[title*="Turnstile"], iframe[src*="challenges.cloudflare.com"]').first();
    const has = await ifr.locator("body").count();
    if (has) {
      await ifr
        .locator('input[type="checkbox"], div[role="checkbox"], [tabindex="0"]')
        .first()
        .click({ timeout: 3000 })
        .catch(()=>{});
      await page.waitForTimeout(500);
    }
  } catch {}
  try {
    await page.evaluate(async () => {
      // @ts-ignore
      if (window.turnstile && window.turnstile.execute) {
        try { /* @ts-ignore */ await window.turnstile.execute(); } catch {}
      }
    });
  } catch {}
  const ok = await Promise.race([
    page.waitForFunction(() => {
      const t1 = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
      const t2 = document.querySelector('input[name="h-captcha-response"], textarea[name="h-captcha-response"]');
      return (t1 && t1.value && t1.value.length > 10) || (t2 && t2.value && t2.value.length > 10);
    }, { timeout: timeoutMs }).then(() => true).catch(() => false),
    page.waitForResponse(
      (res) => /\/cdn-cgi\/challenge-platform\/.*\/pat\//.test(res.url()) && res.status() === 200,
      { timeout: timeoutMs }
    ).then(() => true).catch(() => false),
  ]);
  console.log(ok ? "✅ Turnstile resuelto (o ya válido)" : "ℹ️ Sin confirmación de Turnstile (seguimos).");
  return ok;
}

async function activateStartButton(page) {
  console.log("🎯 Intentando activar botón Start Transcribing...");
  const startBtn = page.locator("#start-transcribing, button:has-text('Start transcribing')").first();
  if (!(await startBtn.count())) {
    console.log("❌ Botón Start no encontrado");
    return false;
  }
  const isEnabled = await startBtn.isEnabled().catch(() => false);
  const isDisabled = await startBtn.getAttribute("disabled").catch(() => null);
  console.log(`🔍 Estado inicial - Enabled: ${isEnabled}, Disabled: ${isDisabled}`);
  if (isEnabled && !isDisabled) {
    console.log("✅ Botón ya está activado");
    return true;
  }

  console.log("🔄 Aplicando estrategias de activación...");
  await page.evaluate(() => {
    const inputs = document.querySelectorAll("input, select, textarea");
    inputs.forEach(input => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }).catch(()=>{});
  await page.waitForTimeout(600);

  const forced = await page.evaluate(() => {
    const btn = document.querySelector("#start-transcribing") ||
                Array.from(document.querySelectorAll("button")).find(b => (b.textContent||"").trim() === "Start transcribing");
    if (!btn) return false;
    btn.removeAttribute("disabled");
    btn.disabled = false;
    const form = btn.closest("form");
    if (form) {
      form.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return !btn.disabled;
  }).catch(() => false);

  if (forced) console.log("✅ Botón forzado via JavaScript");

  const finalEnabled = await startBtn.isEnabled().catch(() => false);
  const finalDisabled = await startBtn.getAttribute("disabled").catch(() => null);
  console.log(`🔍 Estado final - Enabled: ${finalEnabled}, Disabled: ${finalDisabled}`);
  return finalEnabled && !finalDisabled;
}

/* ====== Diagnóstico de subida ====== */
async function waitUploadProcessed(page, { totalTimeout = UPLOAD_TOTAL_TIMEOUT, stuckTimeout = UPLOAD_STUCK_TIMEOUT } = {}) {
  console.log("⏳ Esperando a que Riverside procese el archivo…");
  const t0 = Date.now();
  let lastPct = null, lastTick = Date.now();

  while (Date.now() - t0 < totalTimeout) {
    const pct = await page.evaluate(() => {
      const txt = document.body.textContent || "";
      const m = txt.match(/(\d{1,3})\s?%/);
      return m ? parseInt(m[1], 10) : null;
    }).catch(() => null);

    const replaceVisible = (await page.locator("text=Replace").count()) > 0;
    const fileNameVisible = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("div,span"));
      return !!nodes.find((n) => /\.mp3$|\.wav$|\.m4a$|\.mp4$|\.mov$|\.mkv$/i.test((n.textContent||"").trim()));
    }).catch(() => false);

    if (replaceVisible || (pct !== null && pct >= 100) || fileNameVisible) {
      console.log(`✅ Subida procesada (UI=${replaceVisible ? "Replace" : pct !== null ? pct + "%" : "filename"})`);
      return true;
    }

    if (pct !== null) {
      if (lastPct === null || pct > lastPct) { lastPct = pct; lastTick = Date.now(); }
      if (Date.now() - lastTick > stuckTimeout) {
        console.log(`🛑 Subida atascada en ${lastPct ?? 0}% durante > ${stuckTimeout} ms. Volcando diagnóstico…`);
        await dumpUploadDiagnosis(page);
        lastTick = Date.now();
      }
    } else {
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
      if (!inp) return { present: false };
      const f = inp.files && inp.files[0];
      return f ? { present: true, name: f.name, size: f.size, type: f.type, lastModified: f.lastModified } : { present: true, empty: true };
    });
    console.log("📁 input[type=file] info:", info);
  } catch {}
}

async function dumpUploadDiagnosis(page) {
  await logInputFileInfo(page);
  try {
    const nav = await page.evaluate(() => ({
      onLine: navigator.onLine,
      ua: navigator.userAgent,
      lang: navigator.language,
      sw: !!navigator.serviceWorker,
      conn: (navigator.connection && {
        downlink: navigator.connection.downlink,
        effectiveType: navigator.connection.effectiveType,
        saveData: navigator.connection.saveData,
      }) || null,
    }));
    console.log("🌍 navigator:", nav);
  } catch {}
  try {
    const recent = await page.evaluate(() => {
      const now = performance.now();
      return performance
        .getEntriesByType("resource")
        .filter((e) => now - e.startTime < 15000)
        .map((e) => ({ name: e.name, initiatorType: e.initiatorType, transferSize: e.transferSize || null }))
        .slice(-20);
    });
    console.log("📈 Recursos recientes:", recent);
  } catch {}
}

/* ===================================================================== */
/* ============ MONITORIZACIÓN LIGERA CADA 5s + CLICK SMART ============ */
/* ===================================================================== */

/* Botones objetivo (texto visible) */
const BTN_TRANSLATE   = [/^Translate$/i, /^Translate text$/i, /^Traducir$/i, /^Traducir texto$/i];
const BTN_DOWNLOAD    = [/^Download$/i, /^Descargar$/i, /^Export$/i, /^Exportar$/i];
const MENU_TRANSCRIPT = [/^Transcript$/i, /^Transcripci[oó]n$/i];

/* —— SMART DETECTION: ¿existe un objetivo clickeable asociado a un texto? —— */
async function hasClickableByLabel(page, regexes) {
  const sources = regexes.map(re => re.source);
  return await page.evaluate((sources) => {
    const regs = sources.map(s => new RegExp(s, "i"));

    const isVisible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    };
    const isEnabled = (el) =>
      !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true" &&
      getComputedStyle(el).pointerEvents !== "none";
    const isClickable = (el) => isVisible(el) && isEnabled(el);

    const textNodes = Array.from(document.querySelectorAll(
      'button,[role="button"],a,div,span,p,h1,h2,h3,h4,h5,h6'
    ));

    // 1) Directo: un botón/enlace con ese texto
    for (const el of textNodes) {
      const txt = (el.textContent || el.getAttribute?.("aria-label") || "").trim();
      if (!txt) continue;
      if (regs.some(re => re.test(txt)) && isClickable(el)) return true;
    }

    // 2) Patrón dropdown: texto en un div y el verdadero objetivo es el toggle cercano
    for (const label of textNodes) {
      const txt = (label.textContent || label.getAttribute?.("aria-label") || "").trim();
      if (!txt || !regs.some(re => re.test(txt))) continue;

      // contenedor típico: .ts-dropdown (como en tu captura)
      const dd = label.closest('.ts-dropdown, [class*="dropdown"], [aria-haspopup="menu"]');
      if (dd) {
        const toggle = dd.querySelector('.ts-dropdown-toggle, [class*="toggle"], button,[role="button"],a');
        if (toggle && isClickable(toggle)) return true;
      }

      // ancestro clickeable
      const anc = label.closest('button,[role="button"],a');
      if (anc && isClickable(anc)) return true;

      // hermanos cercanos clickeables (el toggle al lado del texto)
      const sibs = [label.previousElementSibling, label.nextElementSibling]
        .filter(Boolean)
        .flatMap(s => [s, ...s.querySelectorAll?.('*') || []]);
      for (const s of sibs) {
        if (isClickable(s) && (
          s.matches?.('button,[role="button"],a,.ts-dropdown-toggle,[class*="toggle"]')
        )) return true;
      }
    }
    return false;
  }, sources);
}

/* —— SMART CLICK: usa el texto como ancla y clica el objetivo correcto —— */
async function clickSmartByLabel(page, regexes) {
  // 1) intento ARIA por nombre
  for (const re of regexes) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.count().catch(()=>0)) {
      try { await btn.click({ timeout: 8000 }); return true; } catch {}
    }
  }
  // 2) DOM: texto → contenedor dropdown/ancestro/hermano
  const sources = regexes.map(re => re.source);
  const clicked = await page.evaluate((sources) => {
    const regs = sources.map(s => new RegExp(s, "i"));
    const isVisible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    };
    const isEnabled = (el) =>
      !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true" &&
      getComputedStyle(el).pointerEvents !== "none";
    const isClickable = (el) => isVisible(el) && isEnabled(el);
    const tryClick = (el) => { el.click(); return true; };

    const nodes = Array.from(document.querySelectorAll(
      'button,[role="button"],a,div,span,p,h1,h2,h3,h4,h5,h6'
    ));

    // 1) directo por texto
    for (const el of nodes) {
      const txt = (el.textContent || el.getAttribute?.("aria-label") || "").trim();
      if (!txt) continue;
      if (regs.some(re => re.test(txt)) && isClickable(el)) return tryClick(el);
    }

    // 2) texto → toggle en dropdown, ancestro o hermano
    for (const label of nodes) {
      const txt = (label.textContent || label.getAttribute?.("aria-label") || "").trim();
      if (!txt || !regs.some(re => re.test(txt))) continue;

      const dd = label.closest('.ts-dropdown, [class*="dropdown"], [aria-haspopup="menu"]');
      if (dd) {
        const toggle = dd.querySelector('.ts-dropdown-toggle, [class*="toggle"], button,[role="button"],a');
        if (toggle && isClickable(toggle)) return tryClick(toggle);
      }

      const anc = label.closest('button,[role="button"],a');
      if (anc && isClickable(anc)) return tryClick(anc);

      const sibs = [label.previousElementSibling, label.nextElementSibling]
        .filter(Boolean)
        .flatMap(s => [s, ...s.querySelectorAll?.('*') || []]);
      for (const s of sibs) {
        if (isClickable(s) && (
          s.matches?.('button,[role="button"],a,.ts-dropdown-toggle,[class*="toggle"]')
        )) return tryClick(s);
      }
    }
    return false;
  }).catch(() => false);

  // 3) último recurso: click físico centrado en el texto visible
  if (!clicked) {
    const pattern = new RegExp(sources.join("|"), "i");
    const el = page.locator(`:text-matches("${pattern.source}", "i")`).first();
    if (await el.count().catch(()=>0)) {
      try {
        await el.scrollIntoViewIfNeeded();
        const box = await el.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
          return true;
        }
      } catch {}
    }
  }
  return clicked;
}

/* —— Estado de botones usando el detector SMART —— */
async function getButtonsState(page) {
  const tReady = await hasClickableByLabel(page, BTN_TRANSLATE).catch(()=>false);
  const dReady = await hasClickableByLabel(page, BTN_DOWNLOAD).catch(()=>false);
  // muestreo opcional para log
  const sampleText = async (reArr) => {
    const rx = new RegExp(reArr.map(r=>r.source).join("|"), "i");
    const n = page.locator(`:text-matches("${rx.source}", "i")`).first();
    try { return await n.innerText({ timeout: 500 }).catch(()=> ""); } catch { return ""; }
  };
  const tSample = await sampleText(BTN_TRANSLATE);
  const dSample = await sampleText(BTN_DOWNLOAD);
  return { tReady, dReady, tSample, dSample };
}

/* —— Monitor ligero: esperar 5 s y luego sondear cada 5 s —— */
async function monitorButtonsEveryFewSeconds(page, {
  firstDelayMs = 5000,
  intervalMs = 5000,
  requireTranslate = true,
  requireDownload = true,
  hardTimeoutMs = 0, // 0 = sin límite
} = {}) {
  if (firstDelayMs > 0) await page.waitForTimeout(firstDelayMs);
  const t0 = Date.now();
  let round = 0;

  while (true) {
    round++;
    const st = await getButtonsState(page);
    console.log(`👀 round#${round} translate=${st.tReady} download=${st.dReady} (T:'${st.tSample}' D:'${st.dSample}')`);

    const okT = requireTranslate ? st.tReady : true;
    const okD = requireDownload  ? st.dReady : true;
    if (okT && okD) return true;

    if (hardTimeoutMs > 0 && Date.now() - t0 > hardTimeoutMs) {
      console.log("⏱️ Timeout del monitor de botones.");
      return false;
    }
    await page.waitForTimeout(intervalMs);
  }
}

/* —— Descarga robusta del Transcript/Transcripción —— */
async function downloadTranscriptFromMenuI18N(page, {
  outName = "video.txt",
  destDir = os.tmpdir(),
  timeoutMs = 0, // sin límite
} = {}) {
  const outPath = path.join(destDir, outName);

  // Abre el menú (soporta patrón .ts-dropdown con toggle sin texto)
  const opened = await clickSmartByLabel(page, BTN_DOWNLOAD);
  if (!opened) throw new Error("No pude abrir el menú de descarga.");

  // Espera hasta que exista una opción “Transcript/Transcripción” clickeable y haz click.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs }),
    (async () => {
      await page.waitForFunction(
        (sources) => {
          const regs = sources.map(s => new RegExp(s, "i"));
          const isVisible = el => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") return false;
            const r = el.getBoundingClientRect();
            return !!r && r.width > 0 && r.height > 0;
          };
          const isEnabled = el =>
            !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true" &&
            getComputedStyle(el).pointerEvents !== "none";
          const isClickable = el => isVisible(el) && isEnabled(el);

          const nodes = Array.from(document.querySelectorAll('button,[role="button"],a,div,span,li'));
          return nodes.some(n => {
            const txt = (n.textContent || n.getAttribute?.("aria-label") || "").trim();
            return txt && regs.some(re => re.test(txt)) && isClickable(n);
          });
        },
        { timeout: timeoutMs, polling: "raf" },
        MENU_TRANSCRIPT.map(re => re.source)
      );
      const ok = await clickSmartByLabel(page, MENU_TRANSCRIPT);
      if (!ok) throw new Error("No pude pulsar la opción de Transcript.");
    })()
  ]);

  await download.saveAs(outPath);
  console.log("✅ Transcript guardado en:", outPath);
  return outPath;
}

/* ==================== FLUJO PRINCIPAL ==================== */
async function transcribeFromTmpOrPath({
  mediaPath = null,
  keepOpen = true,
  useUndetectableBrowser = false,
} = {}) {
  // 1) Resolver archivo
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

  // Para cierre condicional
  let savedPath = null;

  try {
    console.log("🌍 Cargando página de Riverside…");
    await page
      .goto("https://riverside.fm/transcription", { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => page.goto("https://riverside.com/transcription", { waitUntil: "domcontentloaded", timeout: 60000 }));

    await acceptCookiesIfAny(page);

    // 3) Abrir UI de subida
    await clickTranscribeNowAndWaitUploadUI(page);

    // 4) SUBIDA DEL ARCHIVO
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
          if (clicked) await page.waitForTimeout(800);
          return chooserHandled;
        }],
        ["Input directo", async () => {
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.count()) {
            await fileInput.setInputFiles(resolved).catch(()=>{});
            return true;
          }
          return false;
        }]
      ],
      { desc: "Subida del archivo" }
    );

    if (!fileSet) {
      console.log("❌ No se pudo subir el archivo (continuar no tiene sentido).");
      return { ok: false, reason: "upload_failed" };
    }

    console.log("✅ Archivo subido exitosamente");
    await page.waitForTimeout(1200);

    // 5) Checkbox (NON-FATAL)
    try {
      await debugCheckboxState(page).catch(() => {});
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`🔄 Intento ${attempt} de marcar checkbox...`);
        const ok = await markConsentCheckboxEnhanced(page);
        if (ok) break;
        await page.waitForTimeout(600);
      }
    } catch (e) {
      console.log("ℹ️ Error manejando checkbox (ignorado):", e.message);
    }

    // 6) Turnstile (best-effort)
    await solveTurnstile(page, { timeoutMs: 20000 }).catch(()=>{});

    // 7) START
    const buttonActivated = await activateStartButton(page).catch(()=>false);
    if (buttonActivated) {
      console.log("✅ Botón Start activado - procediendo con click...");
      const startBtn = page.locator("#start-transcribing, button:has-text('Start transcribing')").first();
      await startBtn.click({ timeout: 5000 }).catch(()=>{});
      console.log("🚀 Transcripción iniciada");
    } else {
      console.log("ℹ️ No se pudo activar Start (continuamos igualmente).");
    }

    /* ====== 8) MONITORIZACIÓN LIGERA (5s tras iniciar, luego cada 5s) ====== */
    const bothReady = await monitorButtonsEveryFewSeconds(page, {
      firstDelayMs: 5000,      // empezar a analizar a los 5 s
      intervalMs:   5000,      // sondeo suave cada 5 s
      requireTranslate: true,  // exige Translate/Traducir
      requireDownload:  true,  // exige Download/Descargar/Exportar
      hardTimeoutMs:    0,     // sin límite; pon p.ej. 45*60*1000 si quieres tope
    });

    if (!bothReady) {
      return { ok: false, reason: "buttons_not_ready" };
    }

    /* ====== 9) Descarga Transcript/Transcripción con click SMART ====== */
    savedPath = await downloadTranscriptFromMenuI18N(page, {
      outName: "video.txt",
      destDir: os.tmpdir(),
      timeoutMs: 0, // espera al evento download sin límite
    });

    let transcript = "";
    if (savedPath) {
      try { transcript = fs.readFileSync(savedPath, "utf8"); } catch {}
    }

    return {
      ok: !!savedPath,
      usedFile: resolved,
      transcriptPath: savedPath,
      transcript,
      transcriptUrl: page.url(),
      started: !!buttonActivated,
    };

  } finally {
    // Solo cerramos si keepOpen === false y realmente descargamos
    if (keepOpen === false && savedPath) {
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
