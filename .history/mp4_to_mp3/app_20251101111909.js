// app.js (unificado)
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const cors = require("cors");

// Helpers externos
const { transcribeMp3 } = require("./riverside_auto.js");
const { summarizeWithGemini } = require("./gemini_auto.js");
const { uploadFileToDriveUI } = require("./auto_log_in.js");
const { enableGpuAndRun } = require("./gpu_enabler.js");

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

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// ===== Python helpers =====
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

// ===== Detección robusta de tipo =====
function guessMediaKind(originalName, mimetype) {
  const ext = (path.extname(originalName || "").toLowerCase());
  const typeRoot = (mimetype || "").split("/")[0];

  const videoExts = new Set([".mp4",".mov",".mkv",".webm",".avi",".m4v",".mpg",".mpeg",".wmv"]);
  const audioExts = new Set([".mp3",".wav",".m4a",".aac",".flac",".ogg",".oga",".wma",".opus",".amr",".aiff",".aif"]);

  const isVideo = typeRoot === "video" || videoExts.has(ext);
  const isAudio = typeRoot === "audio" || audioExts.has(ext);

  return { isVideo, isAudio, ext };
}

// ===== Endpoint =====
app.post("/match", uploadFields, async (req, res) => {
  console.log("📥 POST /match recibido");
  let browserToClose = null;

  try {
    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({ error: "Falta archivo. Usa uno de: file | imageFile | video | audio" });
    }

    const localPath = f.path;
    const originalName = f.originalname || f.filename;
    const mimetype = f.mimetype || "";

    const { isVideo, isAudio } = guessMediaKind(originalName, mimetype);
    const base = path.parse(originalName).name || path.parse(localPath).name;

    if (isVideo || isAudio) {
      // 1) Subir ORIGINAL a Drive (UI)
      const uploadedOriginal = await uploadFileToDriveUI(localPath, { folderName: "Videos" });

      // 2) Convertir a MP3 si hace falta
      const mp3Local = isAudio && mimetype === "audio/mpeg"
        ? localPath
        : path.join(path.dirname(localPath), `${base}.mp3`);

      if (!(isAudio && mimetype === "audio/mpeg")) {
        await runPythonScript("mp4_to_mp3.py", [localPath, mp3Local, "NONE"]);
      }

      // 3) Subir MP3 a Drive (UI)
      const uploadedMp3 = await uploadFileToDriveUI(mp3Local, { folderName: "Videos" });

      // 4) Riverside (opcional)
      console.log("🎙️ Enviando MP3 a Riverside para transcripción…");
      let riverside = { started: true };
      try {
        riverside = await transcribeMp3(mp3Local); // { transcript, transcriptUrl, jobId }
      } catch (e) {
        console.error("⚠️ Riverside falló:", e.message);
      }

      // 5) Gemini (opcional)
      console.log("🧠 Enviando transcripción a Gemini para resumen…");
      let gemini = null;
      try {
        const prompt = "Resúmeme diciéndome lo más importante de este audio.";
        gemini = await summarizeWithGemini({
          prompt,
          text: riverside?.transcript || "",
          audioPath: mp3Local,
        });
      } catch (e) {
        console.error("⚠️ Gemini falló:", e.message);
      }

      // 6) Colab/GPU (gpu_enabler)
      console.log("⚙️ Arrancando GPU en Colab con gpu_enabler…");
      let gpuUrl = "NONE";
      try {
        const { result, browser } = await enableGpuAndRun();
        browserToClose = browser || null;
        if (result) gpuUrl = result;
        else console.warn("⚠️ gpu_enabler no devolvió URL; seguimos en modo CPU.");
      } catch (e) {
        console.error("⚠️ Falló el arranque de GPU:", e.message);
      }

      // 7) Pipeline Python local
      let pipelineOutput = null;
      try {
        pipelineOutput = await runPythonScript("video_pipeline.py", [
          localPath,
          mp3Local,
          gpuUrl,
        ]);
      } catch (e) {
        console.error("🔥 Error en pipeline Python:", e.message);
      }

      // 8) Limpieza local
      try { if (!(isAudio && mimetype === "audio/mpeg")) fs.rmSync(localPath, { force: true }); } catch {}
      try { if (mp3Local !== localPath) fs.rmSync(mp3Local, { force: true }); } catch {}

      return res.json({
        ok: true,
        type: isVideo ? "video" : "audio",
        original: uploadedOriginal,
        audio: uploadedMp3,
        riverside,
        gemini,
        gpu: { url: gpuUrl },
        pipeline: { output: pipelineOutput },
      });
    }

    // ===== Otros archivos =====
    const uploadedOther = await uploadFileToDriveUI(localPath, { folderName: "Videos" });
    try { fs.rmSync(localPath, { force: true }); } catch {}
    return res.json({ ok: true, type: "other", file: uploadedOther });

  } catch (err) {
    console.error("🔥 Error en /match:", err);
    return res.status(500).json({ error: err.message || String(err) });
  } finally {
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
