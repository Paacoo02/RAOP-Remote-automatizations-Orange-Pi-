// app.js — Flujo: subir a Drive → Colab (espera True) → descargar MP3 a /tmp → subir a Riverside
const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const cors    = require("cors");

// Helpers propios
const { uploadFileToDriveUI } = require("./auto_log_in.js"); // Subida UI a Drive
const { drive_auto }          = require("./drive_auto.js");   // Ejecuta notebook Colab (devuelve True o link y, si True, la descarga)
const { transcribeFromTmpOrPath, findLatestMp3 } = require("./riverside_auto.js");

const app  = express();
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

/* ---------- Subida temporal (para pasarlo a la UI de Drive) ---------- */
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

const uploadFields = upload.fields([
  { name: "file",      maxCount: 1 },
  { name: "imageFile", maxCount: 1 },
  { name: "video",     maxCount: 1 },
  { name: "audio",     maxCount: 1 },
]);

function pickUploadedFile(req) {
  return (
    (req.files?.file?.[0])      ||
    (req.files?.imageFile?.[0]) ||
    (req.files?.video?.[0])     ||
    (req.files?.audio?.[0])     ||
    null
  );
}

/* ===============================================================
   POST /match
   1) Sube a Drive (UI)
   2) Abre Colab y espera:
      - Celda 2 monta Drive + consent
      - Celda 3 devuelve "True" (estricto) o link
   3) Si "True": descarga video.mp3 a /tmp
   4) Sube /tmp/video.mp3 a Riverside y devuelve info
   =============================================================== */
app.post("/match", uploadFields, async (req, res) => {
  // Riverside puede tardar subiendo el archivo: ampliamos timeout
  req.setTimeout(15 * 60 * 1000);

  console.log("📥 POST /match recibido");
  try {
    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({ error: "Falta archivo. Usa uno de: file | imageFile | video | audio" });
    }

    const localPath    = f.path;
    const originalName = f.originalname || f.filename;

    // (1) Subida a Drive (UI)
    console.log("① Subiendo archivo a Drive (UI)...");
    const uploadedOriginal = await uploadFileToDriveUI(localPath, { keepDriveOpen: true });
    console.log("✅ Subida finalizada:", uploadedOriginal?.name || originalName);

    // Limpieza del archivo temporal local
    try { if (fs.existsSync(localPath)) fs.rmSync(localPath, { force: true }); } catch {}

    // (2) Colab (mismo contexto/pestaña Drive)
    console.log("② Ejecutando drive_auto (Colab)...");
    const { result, download } = await drive_auto({
      context: uploadedOriginal.context,
      drivePage: uploadedOriginal.page,
    });

    // Si devuelve link → no hay MP3 que subir a Riverside
    if (typeof result === "string") {
      console.log("🔗 Notebook devolvió link (sin MP3).");
      return res.json({
        ok: true,
        drive: { original: uploadedOriginal },
        colab: { url: result, kind: "link" },
        riverside: { started: false, reason: "Notebook devolvió link, no True." },
      });
    }

    // (3) Si devolvió True: localizar el MP3
    if (result === true) {
      console.log("🟢 Notebook devolvió True: buscamos el MP3 en /tmp…");
      let mp3Path = (download && download.path && fs.existsSync(download.path))
        ? download.path
        : null;

      // gracia breve por si el fs tarda en volcar
      if (!mp3Path) {
        for (let i = 0; i < 10 && !mp3Path; i++) {
          const cand = findLatestMp3({ preferName: "video.mp3" });
          if (cand && fs.existsSync(cand)) mp3Path = cand;
          if (!mp3Path) await new Promise(r => setTimeout(r, 700));
        }
      }

      if (!mp3Path) {
        return res.status(500).json({ ok: false, error: 'No se encontró "video.mp3" en /tmp tras la descarga.' });
      }

      console.log("🎧 MP3 listo:", mp3Path);

      // (4) Subir a Riverside
      console.log("③ Subiendo a Riverside para transcripción…");
      const riverside = await transcribeFromTmpOrPath({ mp3Path, keepOpen: false });

      return res.json({
        ok: true,
        drive: { original: uploadedOriginal },
        colab: { kind: "true", url: null },
        mp3: { path: mp3Path },
        riverside,
      });
    }

    // Falla si no hubo ni link ni True (seguridad extra; drive_auto ya lo controla)
    return res.status(500).json({ ok: false, error: 'Colab no devolvió ni "True" ni link.' });
  } catch (err) {
    console.error("🔥 Error en /match:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* --- Endpoint opcional: solo dispara Colab (legacy) --- */
app.post("/drive-auto", async (req, res) => {
  req.setTimeout(12 * 60 * 1000);
  console.log("▶️ POST /drive-auto — iniciando drive_auto()");
  try {
    const out = await drive_auto();
    return res.json({ ok: true, result: out.result || null, meta: out.download || null });
  } catch (err) {
    console.error("🔥 Error en /drive-auto:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// --- Endpoint: probar solo Riverside (sube /tmp/video.mp3 o el .mp3 más reciente) ---
app.post("/riverside-test", async (req, res) => {
  req.setTimeout(15 * 60 * 1000); // por si la subida/transcripción tarda

  try {
    // Permite forzar una ruta concreta (opcional)
    const provided = (req.body && req.body.mp3Path) ? String(req.body.mp3Path) : null;

    let mp3Path = null;
    if (provided && fs.existsSync(provided)) {
      mp3Path = provided;
    } else {
      // Busca primero "video.mp3"; si no está, el .mp3 más reciente en /tmp
      mp3Path = findLatestMp3({ preferName: "video.mp3" });
    }

    if (!mp3Path || !fs.existsSync(mp3Path)) {
      return res.status(404).json({
        ok: false,
        error: 'No se encontró ningún .mp3. Coloca "video.mp3" en /tmp o pasa mp3Path en el body.',
        searched: [os.tmpdir(), "/tmp"]
      });
    }

    const riverside = await transcribeFromTmpOrPath({ mp3Path, keepOpen: false });

    return res.json({
      ok: true,
      usedFile: mp3Path,
      riverside
    });
  } catch (err) {
    console.error("🔥 Error en /riverside-test:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video|audio|other)`);
});
