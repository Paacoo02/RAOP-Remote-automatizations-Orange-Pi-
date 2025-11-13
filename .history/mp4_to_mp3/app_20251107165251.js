// app.js — Flujo mínimo: Drive UI -> Colab (drive_auto) y listo
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cors = require("cors");

// Helpers propios
const { uploadFileToDriveUI } = require("./auto_log_in.js"); // Subida UI a Drive
const { drive_auto } = require("./drive_auto.js");           // Ejecuta notebook Colab

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

// Subida temporal (solo para pasar el archivo a la UI de Drive)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// Campos aceptados
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

// === Endpoint principal: SOLO Drive -> Colab ===
app.post("/match", uploadFields, async (req, res) => {
  console.log("📥 POST /match recibido");

  try {
    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({ error: "Falta archivo. Usa uno de: file | imageFile | video | audio" });
    }

    const localPath    = f.path;
    const originalName = f.originalname || f.filename;

    // 1) Subir a Drive por UI (auto_log_in). Mantener la ventana de Drive abierta si tu helper lo soporta.
    console.log("① Subiendo archivo a Drive (UI)...");
    const uploadedOriginal = await uploadFileToDriveUI(localPath, { keepDriveOpen: true });
    console.log("✅ Subida finalizada:", uploadedOriginal?.name || originalName);

    // 2) Abrir Colab y ejecutar celdas (drive_auto). No cerramos el navegador de Colab.
    console.log("② Ejecutando drive_auto (Colab)...");
    const { result: colabUrl /*, page, browser */ } = await drive_auto();
    console.log("✅ drive_auto listo. URL reportada por notebook:", colabUrl);

    // Limpieza del archivo temporal local
    try { if (fs.existsSync(localPath)) fs.rmSync(localPath, { force: true }); } catch {}

    // Respuesta mínima solicitada (sin túneles, sin checks extra)
    return res.json({
      ok: true,
      drive: { original: uploadedOriginal },
      colab: { url: colabUrl }
    });

  } catch (err) {
    console.error("🔥 Error en /match:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/drive-auto", async (req, res) => {
  // Colab a veces tarda: subimos el timeout de la petición
  req.setTimeout(12 * 60 * 1000); // 12 minutos

  console.log("▶️ POST /drive-auto — iniciando drive_auto()");
  try {
    const { result: colabUrl /*, page, browser */ } = await drive_auto();
    console.log("✅ drive_auto OK. URL:", colabUrl);

    // Importante: NO cerramos el navegador aquí (queda abierto para depuración)
    return res.json({
      ok: true,
      colab: { url: colabUrl }
    });
  } catch (err) {
    console.error("🔥 Error en /drive-auto:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video|audio|other)`);
});
