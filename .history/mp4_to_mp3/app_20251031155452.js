// app.js (versión unificada + envío de salida a Gemini + Multer multi-campo)

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { google } = require("googleapis");

const { attemptGoogleLogin } = require("./auto_log_in.js");

// 👇 NUEVO: importamos helpers de Riverside y Gemini
const { transcribeMp3 } = require("./riverside_auto.js");     // debe aceptar (mp3Local) y devolver { transcript, transcriptUrl, jobId }
const { summarizeWithGemini } = require("./gemini_auto.js");  // debe aceptar ({ prompt, text, audioPath })

// ==================== Configuración general ====================
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

// Subidas (usa /tmp del SO para que sea más rápido/efímero)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

// ==================== Stealth (igual que tenías) ====================
const stealth = StealthPlugin();
stealth.enabledEvasions = new Set([
  "chrome.app","chrome.csi","chrome.loadTimes","chrome.runtime","defaultArgs",
  "navigator.hardwareConcurrency","navigator.languages","navigator.permissions",
  "navigator.plugins","navigator.vendor","navigator.webdriver","sourceurl",
  "user-agent-override","webgl.vendor","window.outerdimensions",
]);
puppeteer.use(stealth);

// ==================== Colab (tu flujo) ====================
const COLAB_NOTEBOOK_URL = "https://colab.research.google.com/drive/1YNn5z5yP9sz8YQ2QKN70ULWq1RYFbwqR?authuser=0#scrollTo=lvQXqEqIOb3t";
const SESSION_FILE = "google_session.json";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run_colab_job(start_url, image_url) {
  const { browser, context } = await attemptGoogleLogin();
  const page = await context.newPage();

  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector(".cell.code", { timeout: 60_000 });
  const cells = await page.$$(".cell.code");
  if (!cells.length) throw new Error("No se encontró ninguna celda de código en el notebook.");

  const firstCell = cells[0];
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1000);
  await firstCell.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await sleep(1000);

  const editor = await firstCell.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await editor.click();
  await sleep(500);

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(mod);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(mod);
  await page.keyboard.press("Backspace");
  await page.keyboard.type(`start_url = "${start_url}"\nimage_url = "${image_url}"`, { delay: 50 });

  let result = null;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    await cell.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await sleep(300);

    const ed = await cell.$(".monaco-editor");
    if (ed) {
      await ed.click();
      await page.keyboard.down(mod);
      await page.keyboard.press("Enter"); // ejecutar celda
      await page.keyboard.up(mod);
    }

    if (i === 2) {
      try {
        const out = await cell.waitForSelector(
          ".cell-output, .cell-output-stdout, .output, .output_subarea",
          { timeout: 120_000 }
        );
        await page.waitForFunction(el => (el.innerText || el.textContent || "").trim().length > 0, out, { timeout: 300_000 });
        result = await page.evaluate(el => el.innerText || el.textContent, out);
      } catch (_) {}
      break;
    }
    await sleep(900);
  }

  const storage = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
  await page.close();
  return result;
}

// ==================== Google Drive (API oficial) ====================
function getDriveClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.");
  }
  const oAuth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost"
  );
  oAuth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: oAuth2 });
}

async function uploadFileToDrive(filePath, name, mimeType) {
  const drive = getDriveClient();
  const body = fs.createReadStream(filePath);

  const metadata = { name: name || path.basename(filePath) };
  if (process.env.DRIVE_FOLDER_ID) metadata.parents = [process.env.DRIVE_FOLDER_ID];

  const { data } = await drive.files.create({
    requestBody: metadata,
    media: { mimeType: mimeType || "application/octet-stream", body },
    fields: "id,name,mimeType,size,webViewLink,webContentLink",
  });

  if (process.env.DRIVE_SHARE_ANYONE === "true") {
    try {
      await drive.permissions.create({
        fileId: data.id,
        requestBody: { role: "reader", type: "anyone" },
      });
    } catch (e) {
      console.warn("No se pudo hacer público:", e.message);
    }
  }

  const { data: fresh } = await drive.files.get({
    fileId: data.id,
    fields: "id,name,mimeType,size,webViewLink,webContentLink",
  });
  return fresh;
}

// ==================== Python helpers (como en el otro) ====================
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

    console.log(`🎧 Python: ${pythonExecutable} -X utf8 ${scriptPath} ${args.map(a => JSON.stringify(a)).join(" ")}`);

    const p = spawn(pythonExecutable, ["-X", "utf8", scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });

    p.stdout.on("data", d => process.stdout.write(`[PY_STDOUT] ${d.toString("utf8")}`));
    p.stderr.on("data", d => process.stderr.write(`[PY_STDERR] ${d.toString("utf8")}`));

    p.on("error", (e) => reject(new Error(`Fallo al ejecutar Python: ${e.message}`)));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script salió con código ${code}`));
    });
  });
}

// ==================== Multer: aceptar varios nombres de campo ====================
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

// ==================== Endpoint principal ====================
app.post("/match", uploadFields, async (req, res) => {
  try {
    console.log("📥 POST /match recibido");

    const f = pickUploadedFile(req);
    if (!f) {
      return res.status(400).json({
        error: "Falta archivo. Usa uno de: file | imageFile | video | audio",
      });
    }

    const localPath = f.path;
    const originalName = f.originalname || f.filename;
    const mimetype = f.mimetype || "";

    // ====== FLUJO VÍDEO/AUDIO → MP3 → RIVERSIDE → GEMINI ======
    if (mimetype.startsWith("video/") || mimetype.startsWith("audio/")) {
      // 1) Subir original a Drive (opcional, lo mantenemos)
      const origDrive = await uploadFileToDrive(localPath, originalName, mimetype);

      // 2) Si ya es MP3, reusamos; si no, convertimos a MP3
      const base = path.parse(originalName).name || path.parse(localPath).name;
      const mp3Local = mimetype === "audio/mpeg"
        ? localPath
        : path.join(path.dirname(localPath), `${base}.mp3`);

      if (mimetype !== "audio/mpeg") {
        await runPythonScript("mp4_to_mp3.py", [localPath, mp3Local, process.env.REMOTE_EXEC_BASE || "NONE"]);
      }

      // 3) Subir MP3 a Drive (opcional)
      const mp3Drive = await uploadFileToDrive(mp3Local, `${base}.mp3`, "audio/mpeg");

      // 4) Transcribir en Riverside
      console.log("🎙️ Enviando MP3 a Riverside para transcripción…");
      let riverside = { started: true };
      try {
        riverside = await transcribeMp3(mp3Local); // { transcript, transcriptUrl, jobId }
      } catch (e) {
        console.error("⚠️ Riverside falló:", e.message);
      }

      // 5) Resumen en Gemini
      console.log("🧠 Enviando transcripción a Gemini para resumen…");
      let gemini = null;
      try {
        const prompt = "Resúmeme diciéndome lo más importante de este audio.";
        gemini = await summarizeWithGemini({
          prompt,
          text: riverside?.transcript || "",
          audioPath: mp3Local, // opcional para que Gemini tenga el audio si lo usa
        });
      } catch (e) {
        console.error("⚠️ Gemini falló:", e.message);
      }

      // 6) Limpieza local (si el original no era MP3, ya está convertido)
      if (mimetype !== "audio/mpeg") {
        fs.rm(localPath, { force: true }, () => {});
      }
      // si generamos MP3 en un archivo distinto, puedes borrarlo tras usarlo:
      if (mp3Local !== localPath) {
        fs.rm(mp3Local, { force: true }, () => {});
      }

      return res.json({
        ok: true,
        type: mimetype.startsWith("video/") ? "video" : "audio",
        original: {
          id: origDrive.id,
          name: origDrive.name,
          mimeType: origDrive.mimeType,
          size: origDrive.size,
          webViewLink: origDrive.webViewLink,
          webContentLink: origDrive.webContentLink,
        },
        audio: {
          id: mp3Drive.id,
          name: mp3Drive.name,
          mimeType: mp3Drive.mimeType,
          size: mp3Drive.size,
          webViewLink: mp3Drive.webViewLink,
          webContentLink: mp3Drive.webContentLink,
        },
        riverside,
        gemini,
      });
    }

    // ====== FLUJO IMAGEN + COLAB ======
    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${f.filename}`;
    const start_url = req.body.start_url || req.body.startUrl || "";
    if (!start_url) {
      fs.unlink(localPath, () => {});
      return res.status(400).json({ error: "Falta start_url para el flujo de imagen." });
    }

    const result = await run_colab_job(start_url, imageUrl);
    fs.unlink(localPath, () => {}); // limpia el archivo local

    return res.json({ ok: true, type: "image", result, imageUrl });

  } catch (err) {
    console.error("🔥 Error en /match:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// (opcional) servir /uploads (aunque en este flujo subimos a /tmp y respondemos por Drive)
app.use("/uploads", express.static("uploads"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video|audio)`);
});
