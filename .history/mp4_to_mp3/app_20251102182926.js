// app.js (secuencial: Drive -> GPU Colab -> Python local)
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

// Subidas a /tmp
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
      reject(new Error(`Script salió con código ${code}. STDERR: ${err || "(vacío)"}`));
    });
  });
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

// ===== Detección básica de tipo =====
function guessMediaKind(originalName, mimetype) {
  const ext = (path.extname(originalName || "").toLowerCase());
  const typeRoot = (mimetype || "").split("/")[0];

  const videoExts = new Set([".mp4",".mov",".mkv",".webm",".avi",".m4v",".mpg",".mpeg",".wmv"]);
  const audioExts = new Set([".mp3",".wav",".m4a",".aac",".flac",".ogg",".oga",".wma",".opus",".amr",".aiff",".aif"]);

  const isVideo = typeRoot === "video" || videoExts.has(ext);
  const isAudio = typeRoot === "audio" || audioExts.has(ext);

  return { isVideo, isAudio, ext };
}

// ===== Endpoint: orden estricto Drive -> GPU -> Python =====
app.post("/match", uploadFields, async (req, res) => {
  console.log("📥 POST /match recibido");
  let browserToClose = null; // para cerrar el navegador del gpu_enabler si se abrió

  try {
    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({ error: "Falta archivo. Usa uno de: file | imageFile | video | audio" });
    }

    const localPath    = f.path;
    const originalName = f.originalname || f.filename;
    const mimetype     = f.mimetype || "";
    const { isVideo, isAudio } = guessMediaKind(originalName, mimetype);

    // === 1) Subir a Drive por UI (bloqueante) ===
    console.log("① Subiendo archivo a Drive (UI)...");
    const uploaded = await uploadFileToDriveUI(localPath, { folderName: "Videos" });
    console.log("✅ Subida finalizada:", uploaded?.name || originalName);

    // === 2) Arrancar GPU en Colab (bloqueante) ===
    console.log("② Arrancando GPU en Colab (gpu_enabler)...");
    let gpuUrl = "NONE";
    try {
      const { result, browser } = await enableGpuAndRun();
      browserToClose = browser || null; // lo cerraremos en finally
      gpuUrl = result || "NONE";
      console.log("✅ GPU URL:", gpuUrl);
    } catch (e) {
      console.error("⚠️ Falló el arranque de GPU:", e.message);
    }

    // === 3) Ejecutar script Python local (bloqueante) ===
    console.log("③ Ejecutando script Python local...");

    // Construimos la ruta de salida MP3 (mismo /tmp)
    const baseName = path.parse(originalName).name || path.parse(localPath).name;
    const mp3Local = path.join(path.dirname(localPath), `${baseName}.mp3`);

    let pipelineOutput = null;
    try {
      // Orden correcto: input_path, output_path, server_base_or_NONE
      pipelineOutput = await runPythonScript("mp4_to_mp3.py", [
        localPath,        // 1º: input
        mp3Local,         // 2º: output
        gpuUrl || "NONE", // 3º: URL Colab (trycloudflare) o "NONE"
      ]);
      console.log("✅ Conversión a MP3 terminada:", mp3Local);
    } catch (e) {
      console.error("🔥 Error en pipeline Python:", e.message);
    }

    // === 4) (Opcional) Subir MP3 resultante a Drive (UI) ===
    let uploadedMp3 = null;
    try {
      if (fs.existsSync(mp3Local)) {
        uploadedMp3 = await uploadFileToDriveUI(mp3Local, { folderName: "Videos" });
        console.log("📤 MP3 subido a Drive:", uploadedMp3?.name || path.basename(mp3Local));
      } else {
        console.warn("⚠️ mp3Local no existe; se omite subida del MP3.");
      }
    } catch (e) {
      console.error("⚠️ Fallo subiendo MP3 a Drive:", e.message);
    }

    // Limpieza del archivo local subido (elimina original; MP3 lo dejamos si falló la subida)
    try { if (fs.existsSync(localPath)) fs.rmSync(localPath, { force: true }); } catch {}

    // Respuesta clara
    return res.json({
      ok: true,
      type: isVideo ? "video" : (isAudio ? "audio" : "other"),
      drive: {
        original: uploaded,   // resultado de la subida del original
        mp3: uploadedMp3,     // resultado de la subida del mp3 (si hubo)
      },
      gpu: { url: gpuUrl },   // URL de Cloudflare (o "NONE")
      pipeline: { output: pipelineOutput } // salida del script Python (JSON string)
    });

  } catch (err) {
    console.error("🔥 Error en /match:", err);
    return res.status(500).json({ error: err.message || String(err) });
  } finally {
    // Cerrar navegador de gpu_enabler si quedó abierto
    if (browserToClose) {
      try {
        if (browserToClose.isConnected()) await browserToClose.close();
      } catch (e) {
        console.error("⚠️ Error cerrando el navegador de gpu_enabler:", e.message);
      }
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video|audio|other)`);
});
