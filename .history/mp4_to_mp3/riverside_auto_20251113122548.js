// riverside_auto.js
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
const READY_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

/* ==================== Navegador limpio para Riverside ==================== */
async function createRiversideBrowser() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    acceptDownloads: true,         // necesario para capturar descargas
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

// Wrapper compatible con tu uso en app.js
function findLatestMp3(opts = {}) {
  const { preferName = null, preferNames = null, extraDirs = [] } = opts || {};
  const names = preferNames || (preferName ? [preferName] : ["video.mp3"]);
  return findLatestMedia({
    preferNames: names,
    exts: [".mp3"],
    extraDirs,
  });
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
  try { await el.scrollIntoViewIfNeeded({ timeout: 1200 }); } catch {}
  await page.waitForTimeout(80);
  try { await el.click({ timeout: 1200 }); return true; } catch {}
  try { const handle = await el.elementHandle(); if (handle) { await page.evaluate((n) => n.click(), handle); return true; } } catch {}
  try {
    const box = await el.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 40 });
      return true;
    }
  } catch {}
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

/* ====== DEBUG CHECKBOX ====== */
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

/* ====== ESTRATEGIAS MEJORADAS PARA MARCAR EL CHECKBOX (NON-FATAL) ====== */
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
  } catch (e) {
    console.log("ℹ️ .check() no interactuable (seguimos).");
  }

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
  if (jsSuccess) {
    console.log("✅ Marcado con JavaScript directo");
    return true;
  }

  try {
    const label = page.locator('label[for="human-verification"]').first();
    if (await label.count()) {
      await label.click({ force: true, timeout: 1200 });
      await page.waitForTimeout(200);
      if (await checkbox.isChecked().catch(() => false)) {
        console.log("✅ Marcado a través del label");
        return true;
      }
    }
  } catch {}

  try {
    const box = await checkbox.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.waitForTimeout(50); await page.mouse.up();
      await page.waitForTimeout(200);
      if (await checkbox.isChecked().catch(() => false)) {
        console.log("✅ Marcado con simulación de mouse");
        return true;
      }
    }
  } catch {}

  console.log("⚠️ No se pudo marcar el checkbox (continuamos sin abortar).");
  return false;
}

/* ====== Cloudflare Turnstile (best-effort, non-fatal) ====== */
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

/* ====== ACTIVACIÓN DEL BOTÓN START ====== */
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

/* ====== ESPERAR PROCESADO DE SUBIDA ====== */
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
/* ================== ESPERA Y DESCARGA SIN DELAYS ====================== */
/* ===================================================================== */

const BTN_TRANSLATE = [/^Translate$/i, /^Translate text$/i, /^Traducir$/i, /^Traducir texto$/i];
const BTN_DOWNLOAD  = [/^Download$/i, /^Descargar$/i, /^Export$/i, /^Exportar$/i];
const MENU_TRANSCRIPT = [/^Transcript$/i, /^Transcripci[oó]n$/i];

async function waitForTranslateAndDownloadReady(page, { timeoutMs = 0 } = {}) {
  // timeoutMs = 0 → espera indefinida hasta que ambos estén visibles/habilitados
  const ok = await page.waitForFunction(
    ({ BTN_TRANSLATE, BTN_DOWNLOAD }) => {
      function isVisibleEnabled(el) {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
        if (cs.pointerEvents === "none") return false;
        return !!el.offsetParent || cs.position === "fixed";
      }
      function toRegexes(list) { return list.map(s => new RegExp(s.slice(1, -2), "i")); }
      function findButtonByRegexes(regexes) {
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        nodes.sort((a, b) => {
          const ta = a.tagName.toLowerCase(), tb = b.tagName.toLowerCase();
          const ra = ta === "button" ? 0 : (a.getAttribute("role") === "button" ? 1 : 2);
          const rb = tb === "button" ? 0 : (b.getAttribute("role") === "button" ? 1 : 2);
          return ra - rb;
        });
        for (const n of nodes) {
          const txt = (n.textContent || n.getAttribute("aria-label") || "").trim();
          if (!txt) continue;
          if (regexes.some(re => re.test(txt)) && isVisibleEnabled(n)) return n;
        }
        const divs = Array.from(document.querySelectorAll('div, span'));
        for (const n of divs) {
          const txt = (n.textContent || "").trim();
          if (!txt) continue;
          if (regexes.some(re => re.test(txt)) && isVisibleEnabled(n)) return n;
        }
        return null;
      }
      const regsT = toRegexes(BTN_TRANSLATE);
      const regsD = toRegexes(BTN_DOWNLOAD);
      const t = findButtonByRegexes(regsT);
      const d = findButtonByRegexes(regsD);
      return !!(t && d);
    },
    { BTN_TRANSLATE: BTN_TRANSLATE.map(String), BTN_DOWNLOAD: BTN_DOWNLOAD.map(String) },
    { timeout: timeoutMs, polling: 'raf' }
  ).then(() => true).catch(() => false);

  if (ok) console.log("✅ Detectados botones Translate y Download (visibles y habilitados).");
  return ok;
}

async function clickButtonByRegexes(page, regexes) {
  // 1) ARIA-first
  for (const re of regexes) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.count().catch(()=>0)) {
      try { await btn.click({ timeout: 15000 }); return true; } catch {}
    }
  }
  // 2) Fallback DOM
  const clicked = await page.evaluate(({ regexes }) => {
    function isVisibleEnabled(el) {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return false;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
      if (cs.pointerEvents === "none") return false;
      return !!el.offsetParent || cs.position === "fixed";
    }
    function findButtonByRegexes(regexes) {
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      nodes.sort((a, b) => {
        const ta = a.tagName.toLowerCase(), tb = b.tagName.toLowerCase();
        const ra = ta === "button" ? 0 : (a.getAttribute("role") === "button" ? 1 : 2);
        const rb = tb === "button" ? 0 : (b.getAttribute("role") === "button" ? 1 : 2);
        return ra - rb;
      });
      for (const n of nodes) {
        const txt = (n.textContent || n.getAttribute("aria-label") || "").trim();
        if (!txt) continue;
        if (regexes.some(re => re.test(txt)) && isVisibleEnabled(n)) { n.click(); return true; }
      }
      const divs = Array.from(document.querySelectorAll('div, span'));
      for (const n of divs) {
        const txt = (n.textContent || "").trim();
        if (!txt) continue;
        if (regexes.some(re => re.test(txt)) && isVisibleEnabled(n)) { n.click(); return true; }
      }
      return false;
    }
    const regs = regexes.map(s => new RegExp(s.slice(1, -2), "i"));
    return findButtonByRegexes(regs);
  }, { regexes: regexes.map(String) }).catch(() => false);

  return clicked;
}

async function downloadTranscriptFromMenuI18N(page, {
  outName = "video.txt",
  destDir = os.tmpdir(),
  timeoutMs = 0, // espera indefinida al evento download
} = {}) {
  const outPath = path.join(destDir, outName);

  // Abre el menú de descarga (Download/Descargar/Export/Exportar)
  const opened = await clickButtonByRegexes(page, BTN_DOWNLOAD);
  if (!opened) throw new Error("No pude abrir el menú de descarga.");

  // Espera ítem Transcript/Transcripción y dispara la descarga
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs }),
    (async () => {
      await page.waitForFunction(
        ({ MENU_TRANSCRIPT }) => {
          function isVisibleEnabled(el) {
            if (!el) return false;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") return false;
            const r = el.getBoundingClientRect();
            if (!r || r.width === 0 || r.height === 0) return false;
            if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
            if (cs.pointerEvents === "none") return false;
            return !!el.offsetParent || cs.position === "fixed";
          }
          function findButtonByRegexes(regexes) {
            const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], li, div, span'));
            for (const n of nodes) {
              const txt = (n.textContent || n.getAttribute("aria-label") || "").trim();
              if (!txt) continue;
              if (regexes.some(re => re.test(txt)) && isVisibleEnabled(n)) return n;
            }
            return null;
          }
          const regs = MENU_TRANSCRIPT.map(s => new RegExp(s.slice(1, -2), "i"));
          return !!findButtonByRegexes(regs);
        },
        { MENU_TRANSCRIPT: MENU_TRANSCRIPT.map(String) },
        { timeout: timeoutMs, polling: 'raf' }
      );

      const ok = await clickButtonByRegexes(page, MENU_TRANSCRIPT);
      if (!ok) throw new Error("No pude pulsar la opción de Transcript.");
    })()
  ]);

  await download.saveAs(outPath);
  console.log("✅ Transcript guardado en:", outPath);
  return outPath;
}


/* ==================== ESPERA ACTIVA HASTA "READY!" ==================== */
async function waitForReadyUI(page, { timeoutMs = READY_WAIT_TIMEOUT_MS, dumpOnReady = true } = {}) {
  console.log("⏳ Esperando a que la transcripción llegue a estado Ready!…");
  const ok = await page
    .waitForFunction(() => {
      const bodyText = (document.body.textContent || "").toLowerCase();
      const hasReadyText = bodyText.includes("ready!") ||
                           bodyText.includes("your transcripts are ready") ||
                           bodyText.includes("transcripts are ready") ||
                           bodyText.includes("listo") ||
                           bodyText.includes("tus transcripciones están listas");
      const hasDownloadBtn = !!Array.from(document.querySelectorAll("button,a,[role='button']"))
        .find(n => /^(download|descargar|export|exportar)$/i.test((n.textContent || n.getAttribute("aria-label") || "").trim()));
      const hasFileRow = !!Array.from(document.querySelectorAll("div,span,li"))
        .find(n => /\.(mp3|wav|m4a|mp4|mov|mkv)$/i.test((n.textContent || "").trim()));
      const step5 = document.querySelector(".step5-active, .ts-ready-wrapper, .tr-ready-heading");
      return hasReadyText || (hasDownloadBtn && hasFileRow) || !!step5;
    }, { timeout: timeoutMs, polling: 800 })
    .then(() => true)
    .catch(() => false);

  if (!ok) {
    console.log("⚠️ Timeout esperando estado Ready!");
    return false;
  }
  console.log("✅ Detectado estado Ready!");
  if (dumpOnReady) await dumpFullDOM(page, "DOM_READY_STATE", { saveToFile: true });
  return true;
}

/* ==================== FLUJO PRINCIPAL ==================== */
async function transcribeFromTmpOrPath({
  mediaPath = null,
  keepOpen = true,
  useUndetectableBrowser = false,
  postStartDomDumpSec = 10,   // dump intermedio opcional a los N segundos
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

  // Para controlar cierre condicional
  let savedPath = null;

  try {
    console.log("🌍 Cargando página de Riverside…");
    await page
      .goto("https://riverside.fm/transcription", { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => page.goto("https://riverside.com/transcription", { waitUntil: "domcontentloaded", timeout: 60000 }));

    await acceptCookiesIfAny(page);
    await setLanguageTo(page, "spanish").catch(() => {});

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

      // Dump intermedio opcional (a los N s desde el inicio)
      if (postStartDomDumpSec > 0) {
        console.log(`⏳ Esperando ${postStartDomDumpSec}s tras iniciar para volcar DOM intermedio…`);
        await page.waitForTimeout(postStartDomDumpSec * 1000);
        await dumpFullDOM(page, `DOM_${postStartDomDumpSec}s_AFTER_START`, { saveToFile: true });
      }
    } else {
      console.log("ℹ️ No se pudo activar Start (continuamos igualmente).");
    }

    // 8) Espera ACTIVA a "Ready!" (no seguimos hasta que aparezca esa UI)
    const readyOk = await waitForReadyUI(page, { timeoutMs: READY_WAIT_TIMEOUT_MS, dumpOnReady: true });
    if (!readyOk) return { ok: false, reason: "ready_timeout" };

    // 9) Descargar Transcript/Transcripción
    savedPath = await downloadTranscriptFromMenuI18N(page, {
      outName: "video.txt",
      destDir: os.tmpdir(),
      timeoutMs: 0, // espera indefinida a evento download
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
  findLatestMp3,
  createRiversideBrowser,
  dumpFullDOM,
  waitForReadyUI,
};
