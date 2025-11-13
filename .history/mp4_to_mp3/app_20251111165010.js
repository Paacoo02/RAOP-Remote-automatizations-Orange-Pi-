// app.js — Flujo: subir a Drive → Colab (espera True) → descargar MP3 a /tmp → subir a Riverside o pasar por Gemini (texto)
// ---------------------------------------------------------------------------------------------

const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const cors    = require("cors");

// Helpers propios
const { uploadFileToDriveUI, downloadAndTrashFileViaMenu, switchToVideosTab } = require("./auto_log_in.js"); // Subida UI a Drive
const { drive_auto }          = require("./drive_auto.js");   // Ejecuta notebook Colab (devuelve True o link y, si True, la descarga)
const { transcribeFromTmpOrPath, findLatestMp3 } = require("./riverside_auto.js");

// Gemini (UI web): usamos directamente el navegador controlado por Playwright
const { summarizeWithGemini } = require("./gemini_auto.js");

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
  { name: "file",      maxCount: 1 }, // ← usa este campo para .txt o cualquier fichero
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
  
    const startTime = Date.now(); // ⏱️ Marca de inicio
    console.log("📥 POST /match recibido");
  
    try {
      const f = pickUploadedFile(req);
      if (!f) {
        return res.status(400).json({ error: "Falta archivo. Usa uno de: file | imageFile | video | audio" });
      }
  
      const localPath    = f.path;
      const originalName = f.originalname || f.filename;
  
      // 🧮 Calculamos tamaño del archivo
      const fileSizeBytes = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
      const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
  
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
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`🔗 Notebook devolvió link (sin MP3). Duración total: ${durationSec}s`);
        return res.json({
          ok: true,
          durationSec,
          fileSizeBytes,
          fileSizeMB,
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
          const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
          return res.status(500).json({
            ok: false,
            durationSec,
            fileSizeBytes,
            fileSizeMB,
            error: 'No se encontró "video.mp3" en /tmp tras la descarga.'
          });
        }
  
        console.log("🎧 MP3 listo:", mp3Path);
  
        // (4) Subir a Riverside y transcribir
        console.log("③ Subiendo a Riverside para transcripción…");
        const riverside = await transcribeFromTmpOrPath({ mediaPath: mp3Path, keepOpen: false });
  
        // Extraer transcripción de la respuesta de Riverside
        const transcript =
          (riverside && (riverside.transcript || riverside.text || riverside.result?.text || riverside.result?.transcript))
            ? (riverside.transcript || riverside.text || riverside.result?.text || riverside.result?.transcript)
            : null;
  
        if (!transcript || !String(transcript).trim()) {
          const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
          return res.status(500).json({
            ok: false,
            durationSec,
            fileSizeBytes,
            fileSizeMB,
            error: "Transcripción vacía o no encontrada en la respuesta de Riverside.",
            riverside
          });
        }
  
        // (5) Subir la transcripción como "video.txt" al **mismo Drive**
        console.log("④ Subiendo transcripción como video.txt al mismo Drive (misma sesión)...");
        const driveTranscript = await uploadTextToDriveSameContext({
          context  : uploadedOriginal.context,
          drivePage: uploadedOriginal.page,
          destName : 'video.txt',
          contents : transcript
        });
  
        // ⏱️ Calcular tiempo total de ejecución
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`🏁 Flujo /match completado en ${durationSec}s`);
  
        return res.json({
          ok: true,
          durationSec,
          fileSizeBytes,
          fileSizeMB,
          drive: {
            original: uploadedOriginal,
            transcript: driveTranscript
          },
          colab: { kind: "true", url: null },
          mp3: { path: mp3Path },
          riverside,
          transcriptInfo: { length: String(transcript).length }
        });
      }
  
      // Falla si no hubo ni link ni True
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
      return res.status(500).json({
        ok: false,
        durationSec,
        fileSizeBytes,
        fileSizeMB,
        error: 'Colab no devolvió ni "True" ni link.'
      });
  
    } catch (err) {
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
      console.error("🔥 Error en /match:", err);
      return res.status(500).json({
        ok: false,
        durationSec,
        error: err.message || String(err)
      });
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

/* --- Endpoint: probar solo Riverside (sube /tmp/video.mp3 o el .mp3 más reciente) --- */
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

    const riverside = await transcribeFromTmpOrPath({ mediaPath: mp3Path, keepOpen: false });

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

/* ===============================================================
   NUEVO: POST /gemini-text
   Recibe SOLO un .txt (p.ej. video.txt) y lo pega tal cual en Gemini,
   SIN prompt adicional. Devuelve el texto respuesta y lo guarda en /tmp.
   Campo de formulario: file=@/ruta/a/video.txt
   =============================================================== */
app.post("/gemini-text", uploadFields, async (req, res) => {
  req.setTimeout(10 * 60 * 1000);
  console.log("📥 POST /gemini-text recibido");

  try {
    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({ error: "Falta archivo .txt. Usa el campo 'file'." });
    }

    const localPath    = f.path;
    const originalName = f.originalname || f.filename;

    if (!fs.existsSync(localPath)) {
      return res.status(400).json({ error: "El archivo no existe en el servidor temporal." });
    }

    const textContent = fs.readFileSync(localPath, "utf8");
    console.log(`📄 Texto cargado (${textContent.length} caracteres) de ${originalName}`);

    // Llamamos a Gemini SIN prompt (solo texto)
    const result = await summarizeWithGemini({
      prompt: "",             // ← sin prompt
      text: textContent,
      audioPath: null,
    });

    // Guardamos salida en /tmp con nombre derivado del original
    const stamp   = Date.now();
    const base    = path.basename(originalName, path.extname(originalName)) || "video";
    const outName = `${base}_gemini_${stamp}.txt`;
    const outPath = path.join(os.tmpdir(), outName);
    try { fs.writeFileSync(outPath, result?.summary || ""); } catch {}

    // Limpieza del temporal subido
    try { fs.rmSync(localPath, { force: true }); } catch {}

    return res.json({
      ok: true,
      file: originalName,
      chars: textContent.length,
      gemini: {
        ok: !!(result && result.ok),
        url: result?.url || null,
        resultText: result?.summary || "",
        saved: { path: outPath, fileName: outName }
      }
    });
  } catch (err) {
    console.error("🔥 Error en /gemini-text:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* ===============================================================
   (Opcional) POST /gemini-test
   Usa /tmp/video.mp3 o el .mp3 más reciente y lo adjunta a Gemini
   para que responda en la UI. Útil para validar audio directo.
   =============================================================== */
app.post("/gemini-test", async (req, res) => {
  req.setTimeout(15 * 60 * 1000);
  console.log("▶️ POST /gemini-test — inicio");

  try {
    // Permite forzar una ruta concreta (opcional)
    const provided = (req.body && req.body.mp3Path) ? String(req.body.mp3Path) : null;

    let mp3Path = null;
    if (provided && fs.existsSync(provided)) {
      mp3Path = provided;
    } else {
      mp3Path = findLatestMp3({ preferName: "video.mp3" });
    }

    if (!mp3Path || !fs.existsSync(mp3Path)) {
      return res.status(404).json({
        ok: false,
        error: 'No se encontró ningún .mp3. Coloca "video.mp3" en /tmp o pasa mp3Path en el body.',
        searched: [os.tmpdir(), "/tmp"]
      });
    }

    // Enviamos a Gemini adjuntando el audio (sin prompt ni texto)
    const result = await summarizeWithGemini({
      prompt: "",
      text: "",
      audioPath: mp3Path,
    });

    const stamp   = Date.now();
    const outName = `gemini_audio_${stamp}.txt`;
    const outPath = path.join(os.tmpdir(), outName);
    try { fs.writeFileSync(outPath, result?.summary || ""); } catch {}

    return res.json({
      ok: true,
      usedFile: mp3Path,
      gemini: {
        ok: !!(result && result.ok),
        url: result?.url || null,
        resultText: result?.summary || "",
        saved: { path: outPath, fileName: outName }
      }
    });
  } catch (err) {
    console.error("🔥 Error en /gemini-test:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/* ===============================================================
   POST /match-gemini
   1) Sube a Drive (UI)
   2) Ejecuta Colab (espera True o link)
   3) Si True: localiza /tmp/video.mp3
   4) Pasa el MP3 a la UI de Gemini y devuelve el resultado
   =============================================================== */
app.post("/match-gemini", uploadFields, async (req, res) => {
  req.setTimeout(15 * 60 * 1000);
  console.log("📥 POST /match-gemini recibido");
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

    // Limpieza del temporal
    try { if (fs.existsSync(localPath)) fs.rmSync(localPath, { force: true }); } catch {}

    // (2) Colab (mismo contexto/pestaña Drive)
    console.log("② Ejecutando drive_auto (Colab)...");
    const { result, download } = await drive_auto({
      context: uploadedOriginal.context,
      drivePage: uploadedOriginal.page,
    });

    // Si devolvió link → no hay MP3 todavía
    if (typeof result === "string") {
      console.log("🔗 Notebook devolvió link (sin MP3).");
      return res.json({
        ok: true,
        drive: { original: uploadedOriginal },
        colab: { url: result, kind: "link" },
        gemini: { started: false, reason: "Notebook devolvió link, no True." },
      });
    }

    // (3) Localizar el MP3 si devolvió True
    if (result === true) {
      console.log("🟢 Notebook devolvió True: buscamos el MP3 en /tmp…");
      let mp3Path = (download && download.path && fs.existsSync(download.path))
        ? download.path
        : null;

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

      // (4) Pasar a Gemini (UI)
      console.log("③ Enviando a Gemini (adjuntando audio) …");
      const resultGem = await summarizeWithGemini({
        prompt: "",
        text: "",
        audioPath: mp3Path,
      });

      const stamp   = Date.now();
      const outName = `gemini_match_${stamp}.txt`;
      const outPath = path.join(os.tmpdir(), outName);
      try { fs.writeFileSync(outPath, resultGem?.summary || ""); } catch {}

      return res.json({
        ok: true,
        drive: { original: uploadedOriginal },
        colab: { kind: "true", url: null },
        mp3: { path: mp3Path },
        gemini: {
          ok: !!(resultGem && resultGem.ok),
          url: resultGem?.url || null,
          resultText: resultGem?.summary || "",
          saved: { path: outPath, fileName: outName }
        },
      });
    }

    return res.status(500).json({ ok: false, error: 'Colab no devolvió ni "True" ni link.' });
  } catch (err) {
    console.error("🔥 Error en /match-gemini:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post("/drive-download-menu", async (req, res) => {
  req.setTimeout(10 * 60 * 1000); // hasta 10 min
  console.log("📥 POST /drive-download-menu recibido");

  try {
    const fileName = (req.body && req.body.fileName) ? String(req.body.fileName).trim() : "video.mp3";
    if (!fileName) {
      return res.status(400).json({ ok: false, error: "Falta parámetro fileName" });
    }

    // Iniciar sesión en Drive
    console.log(`🔑 Iniciando sesión y abriendo carpeta fija...`);
    const { context, page } = await require("./auto_log_in.js").attemptGoogleLogin();

    // Ir a la carpeta “Videos” (fija)
    const videosPage = await switchToVideosTab(context);
    await videosPage.bringToFront();

    console.log(`📂 Buscando y descargando "${fileName}" por menú…`);
    const info = await downloadAndTrashFileViaMenu(videosPage, fileName, {
      destDir: os.tmpdir(),
      timeoutMs: 180000
    });

    console.log(`✅ Descarga completada: ${info.path}`);

    // Cerrar navegador/contexto tras finalizar
    try { await context.close(); } catch {}

    return res.json({
      ok: true,
      file: fileName,
      savedPath: info.path,
      fileId: info.fileId || null,
      message: `"${fileName}" descargado y enviado a papelera.`
    });
  } catch (err) {
    console.error("🔥 Error en /drive-download-menu:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video|audio|other)`);
  console.log(`   POST /drive-auto`);
  console.log(`   POST /riverside-test`);
  console.log(`   POST /gemini-text`);
  console.log(`   POST /gemini-test`);
  console.log(`   POST /match-gemini`);
});
