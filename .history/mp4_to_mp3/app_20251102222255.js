// app.js (secuencial: Drive -> GPU Colab -> Python remoto)
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const cors = require("cors");

// Helpers externos (ya existentes en tu proyecto)
const { uploadFileToDriveUI } = require("./auto_log_in.js"); // UI Drive
const { enableGpuAndRun } = require("./gpu_enabler.js");     // Colab GPU

// Helpers de túnel
const axios = require("axios");
const dns = require("dns").promises;
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  "https://pacoweb.pages.dev",
  "http://127.0.0.1:8788",
  "http://localhost:8788",
];

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Subidas a /tmp (solo para la subida UI a Drive)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// ===== Helpers Python =====
function resolvePythonExecutable() {
  const candidates = [
    path.resolve(__dirname, "venv", "bin", "python"),
    "/app/venv/bin/python",
    process.env.PYTHON_BIN,
    "python3",
    "python",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if ((c === "python3" || c === "python") || fs.existsSync(c)) return c;
    } catch {}
  }
  throw new Error("No se encontró Python del venv. Verifica __dirname/venv o /app/venv.");
}

function runPythonScript(scriptRelPath, args) {
  return new Promise((resolve, reject) => {
    const pythonExecutable = resolvePythonExecutable();
    const scriptPath = path.resolve(__dirname, scriptRelPath);
    console.log(`🐍 Python: ${pythonExecutable} -X utf8 ${scriptPath} ${args.map(a => JSON.stringify(a)).join(" ")}`);

    const p = spawn(pythonExecutable, ["-X", "utf8", scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "", err = "";
    p.stdout.on("data", d => { const s=d.toString("utf8"); process.stdout.write(`[PY_STDOUT] ${s}`); out += s; });
    p.stderr.on("data", d => { const s=d.toString("utf8"); process.stderr.write(`[PY_STDERR] ${s}`); err += s; });

    p.on("error", (e) => reject(new Error(`Fallo al ejecutar Python: ${e.message}`)));
    p.on("close", (code) => {
      console.log(`🐍 Python terminó con código: ${code}`);
      if (code === 0) return resolve(out.trim());
      reject(new Error(`Script salió con código ${code}. STDERR: ${err || "(vacío)"}\nSTDOUT: ${out || "(vacío)"}`));
    });
  });
}

// ===== Helpers de Túnel (espera activa a Cloudflare/worker) =====
async function waitForTunnelReady(baseUrl, { maxWaitMs = 45000, stepMs = 800 } = {}) {
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("gpuUrl inválida");
  const u = new URL(baseUrl);
  const deadline = Date.now() + maxWaitMs;
  let lastErr = "unknown";

  // probamos http y https por si el worker solo expuso uno
  const candidates = Array.from(new Set([
    baseUrl.replace(/^http:/i, "https:"),
    baseUrl.replace(/^https:/i, "http:")
  ])).map(x => x.replace(/\/+$/,""));

  while (Date.now() < deadline) {
    for (const cand of candidates) {
      try {
        // 1) DNS
        await dns.lookup(u.hostname);

        // 2) /health
        const health = await axios.get(cand + "/health", { timeout: 2500, validateStatus: () => true });
        if (health.status === 200) return cand;

        // 3) /execute (eco) — prueba real de endpoint
        const exec = await axios.post(
          cand + "/execute",
          { script_content: "import json; print(json.dumps({'ok': True,'ping':'pong'}))", params: [] },
          { timeout: 2500, validateStatus: () => true }
        );
        if (exec.status === 200) return cand;

        lastErr = `health=${health.status} exec=${exec.status}`;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error("tunnel_not_ready: " + lastErr);
}

// ===== Multer fields =====
const uploadFields = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "imageFile", maxCount: 1 },
  { name: "video", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);

function pickUploadedFile(req) {
  return (
    (req.files?.file?.[0]) ||
    (req.files?.imageFile?.[0]) ||
    (req.files?.video?.[0]) ||
    (req.files?.audio?.[0]) ||
    null
  );
}

// ===== Detección básica de tipo (solo informativa) =====
function guessMediaKind(originalName, mimetype) {
  const ext = (path.extname(originalName || "").toLowerCase());
  const typeRoot = (mimetype || "").split("/")[0];

  const videoExts = new Set([".mp4",".mov",".mkv",".webm",".avi",".m4v",".mpg",".mpeg",".wmv"]);
  const audioExts = new Set([".mp3",".wav",".m4a",".aac",".flac",".ogg",".oga",".wma",".opus",".amr",".aiff",".aif"]);

  const isVideo = typeRoot === "video" || videoExts.has(ext);
  const isAudio = typeRoot === "audio" || audioExts.has(ext);

  return { isVideo, isAudio, ext };
}

// ===== Endpoint: orden estricto Drive -> GPU -> Python (solo URL) =====
app.post("/match", uploadFields, async (req, res) => {
  console.log("📥 POST /match recibido");
  let browserToClose = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({ error: "Falta archivo. Usa uno de: file | imageFile | video | audio" });
    }

    const localPath    = f.path;
    const originalName = f.originalname || f.filename;
    const mimetype     = f.mimetype || "";
    const { isVideo, isAudio } = guessMediaKind(originalName, mimetype);

    // === 1) Subir ORIGINAL a Drive por UI (bloqueante) ===
    console.log("① Subiendo archivo a Drive (UI)...");
    const uploadedOriginal = await uploadFileToDriveUI(localPath, { folderName: "Videos" });
    console.log("✅ Subida finalizada:", uploadedOriginal?.name || originalName);

    // === 2) Arrancar GPU en Colab y ESPERAR túnel (bloqueante) ===
    console.log("② Arrancando GPU en Colab (gpu_enabler)...");
    let gpuUrl = "";
    try {
      const { result, browser } = await enableGpuAndRun();
      browserToClose = browser || null;
      const rawUrl = result || "";
      console.log("⏳ Verificando disponibilidad del túnel...", rawUrl);
      gpuUrl = await waitForTunnelReady(rawUrl, { maxWaitMs: 45000, stepMs: 800 });
      console.log("✅ GPU URL lista:", gpuUrl);
    } catch (e) {
      console.error("⚠️ GPU no lista:", e.message);
      return res.status(502).json({ ok: false, error: "gpu_url_unavailable", detail: e.message });
    }

    // === 3) Ejecutar script Python REMOTO (solo le pasamos LA URL) ===
    console.log("③ Ejecutando script Python remoto (solo GPU URL)...");
    let pythonOutput = null;
    try {
      pythonOutput = await runPythonScript("mp4_to_mp3.py", [gpuUrl]);
      console.log("✅ Python remoto OK");
    } catch (e) {
      console.error("🔥 Error en ejecución Python remota:", e.message);
      return res.status(500).json({ ok: false, error: "python_remote_failed", detail: e.message });
    }

    // Limpieza del archivo local subido
    try { if (fs.existsSync(localPath)) fs.rmSync(localPath, { force: true }); } catch {}

    // Respuesta clara (el Python devuelve JSON en stdout; aquí lo enviamos tal cual + info extra)
    let pipeline = {};
    try { pipeline = JSON.parse(pythonOutput); } catch (_) { pipeline = { raw: pythonOutput }; }

    return res.json({
      ok: true,
      type: isVideo ? "video" : (isAudio ? "audio" : "other"),
      drive: {
        original: uploadedOriginal   // resultado de la subida del original
      },
      gpu: { url: gpuUrl },         // URL Cloudflare lista
      pipeline                       // salida del script Python remoto (incluye rutas en Drive)
    });

  } catch (err) {
    console.error("🔥 Error en /match:", err);
    return res.status(500).json({ error: err.message || String(err) });
  } finally {
    if (browserToClose) {
      try { if (browserToClose.isConnected()) await browserToClose.close(); }
      catch (e) { console.error("⚠️ Error cerrando el navegador de gpu_enabler:", e.message); }
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video|audio|other)`);
});
