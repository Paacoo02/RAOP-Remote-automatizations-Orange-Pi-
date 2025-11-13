// riverside_auto.js — Sube /tmp/video.mp3 (o el MP3 más reciente) a Riverside y dispara transcripción
const fs = require("fs");
const os = require("os");
const path = require("path");

// Reutilizamos el navegador "indetectable" persistente del proyecto
const { createUndetectableBrowser } = require("./auto_log_in.js");

/* -------------------- Utilidades de disco -------------------- */
function findLatestMp3({ preferName = "video.mp3", extraDirs = [] } = {}) {
  const dirs = Array.from(
    new Set([
      os.tmpdir(),                // normalmente "/tmp" en Linux
      "/tmp",
      "/app/downloads",           // por si decides mover descargas
      "/root/Downloads",
      ...extraDirs.filter(Boolean),
    ])
  );

  /** recoge todos los .mp3 con su mtime */
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
    } catch (_) {}
  }
  if (hits.length === 0) return null;

  // Si existe exactamente preferName, devuélvelo
  const exact = hits.find(h => path.basename(h.file).toLowerCase() === preferName.toLowerCase());
  if (exact) return exact.file;

  // Si no, el más reciente
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].file;
}

/* -------------------- Flujo Riverside -------------------- */
async function transcribeFromTmpOrPath({ mp3Path = null, keepOpen = false } = {}) {
  // 1) Resolver ruta del MP3
  let resolved = mp3Path && fs.existsSync(mp3Path) ? mp3Path : null;
  if (!resolved) resolved = findLatestMp3({ preferName: "video.mp3" });
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error("No se encontró ningún .mp3 en /tmp (ni ruta proporcionada).");
  }

  // 2) Lanzar navegador persistente (mismo motor que Drive/Colab)
  const { context, page } = await createUndetectableBrowser();
  try {
    // 3) Abrir Riverside (dos dominios posibles)
    await page.goto("https://riverside.fm/transcription", { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => page.goto("https://riverside.com/transcription", { waitUntil: "domcontentloaded", timeout: 60000 }));

    // 4) Aceptar cookies (best-effort)
    for (const sel of [
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'text=Accept all',
      'text=Accept',
    ]) {
      const btn = await page.$(sel);
      if (btn) { await btn.click().catch(() => {}); break; }
    }

    // 5) Botón principal "Transcribe now"
    const goBtn =
      page.locator('#transcribe-main').first()
        .or(page.locator('a:has-text("Transcribe now"), button:has-text("Transcribe now")').first());
    if (await goBtn.count()) await goBtn.click().catch(() => {});
    await page.waitForTimeout(1000);

    // 6) Subir archivo: input[type=file]
    let fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count())) {
      // algunos flujos inyectan el input tras abrir modal
      await page.waitForTimeout(1500);
      fileInput = page.locator('input[type="file"]').first();
    }
    await fileInput.waitFor({ timeout: 20000 });
    await fileInput.setInputFiles(resolved);

    // 7) Checkbox de consentimiento (si aparece)
    try {
      const cb = page.locator('input[type="checkbox"]').first();
      if (await cb.count()) {
        if (!(await cb.isChecked().catch(() => false))) {
          await cb.check({ force: true }).catch(() => cb.click({ force: true }));
        }
      }
    } catch {}

    // 8) Botón "Start transcribing"
    const startBtn = page.locator('#start-transcribing').first()
      .or(page.locator('button:has-text("Start transcribing")').first());
    if (await startBtn.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {}),
        startBtn.click().catch(() => {}),
      ]);
    }

    // 9) Intento de obtener texto de transcripción (si aparece rápido)
    let transcript = "";
    try {
      await page.waitForTimeout(5000);
      const block = page.locator('[data-testid="transcript"], .transcript, [class*="transcript"]').first();
      if (await block.count()) transcript = await block.innerText({ timeout: 10000 }).catch(() => "");
    } catch {}

    return {
      ok: true,
      usedFile: resolved,
      transcript: transcript || "",
      transcriptUrl: page.url(),
      started: true,
    };
  } finally {
    // Mantener abierto solo si lo piden para depurar
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
