const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require('user-agents');
const cors = require("cors");
const { attemptGoogleLogin } = require("./auto_log_in.js"); // ⬅️ Importamos login automático

// === NEW: Google Drive API ===
const { google } = require("googleapis");

// ==================== Config Stealth (igual que tenías) ====================
const stealth = StealthPlugin();
stealth.enabledEvasions = new Set([
  'chrome.app',
  'chrome.csi',
  'chrome.loadTimes',
  'chrome.runtime',
  'defaultArgs',
  'navigator.hardwareConcurrency',
  'navigator.languages',
  'navigator.permissions',
  'navigator.plugins',
  'navigator.vendor',
  'navigator.webdriver',
  'sourceurl',
  'user-agent-override',
  'webgl.vendor',
  'window.outerdimensions'
]);
puppeteer.use(stealth);

const app = express();

const allowedOrigins = [
  "https://pacoweb.pages.dev",
  "http://127.0.0.1:8788",
  "http://localhost:8788"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS: " + origin));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const upload = multer({ dest: "uploads/" });

const COLAB_NOTEBOOK_URL = "https://colab.research.google.com/drive/1YNn5z5yP9sz8YQ2QKN70ULWq1RYFbwqR?authuser=0#scrollTo=lvQXqEqIOb3t";
const SESSION_FILE = "google_session.json";

// ==================== NEW: Helpers Google Drive ====================
function getDriveClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN en el entorno.");
  }
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost"
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: oAuth2Client });
}

async function uploadFileToDrive(filePath, originalName, mimeType) {
  const drive = getDriveClient();

  const fileMetadata = {
    name: originalName || path.basename(filePath),
  };
  if (process.env.DRIVE_FOLDER_ID) {
    fileMetadata.parents = [process.env.DRIVE_FOLDER_ID];
  }

  const media = {
    mimeType: mimeType || "application/octet-stream",
    body: fs.createReadStream(filePath),
  };

  const { data } = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, name, mimeType, size, webViewLink, webContentLink",
  });

  // Compartir públicamente si se pide
  if (process.env.DRIVE_SHARE_ANYONE === "true") {
    try {
      await drive.permissions.create({
        fileId: data.id,
        requestBody: { role: "reader", type: "anyone" },
      });
    } catch (e) {
      console.warn("No se pudo crear permiso público:", e.message);
    }
  }

  // Obtener links actualizados
  const { data: fresh } = await drive.files.get({
    fileId: data.id,
    fields: "id, name, mimeType, size, webViewLink, webContentLink",
  });

  return fresh;
}

// ==================== Sleep ====================
function sleep(minMs, maxMs = null) {
  const ms = maxMs ? Math.random() * (maxMs - minMs) + minMs : minMs;
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== Playwright + Colab (tu flujo, intacto) ====================
async function run_colab_job(start_url, image_path) {
  const { browser, context } = await attemptGoogleLogin();
  const page = await context.newPage();

  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: 'networkidle', timeout: 90_000 });
  console.log("🌍 Notebook abierto");

  await page.waitForSelector(".cell.code", { timeout: 60_000 });
  const cells = await page.$$(".cell.code");
  console.log(`🔎 Detectadas ${cells.length} celdas de código`);
  if (!cells.length) throw new Error("❌ No se encontró ninguna celda de código");

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
  console.log("🧹 Contenido previo eliminado");

  await page.keyboard.type(`start_url = "${start_url}"\nimage_url = "${image_path}"`, { delay: 50 });
  console.log("✅ Variables inyectadas");

  let result = null;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    await cell.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await sleep(400);

    await cell.click({ clickCount: 2 });
    await sleep(300);

    const ed = await cell.$(".monaco-editor");
    if (ed) {
      await ed.click();
      await sleep(200);
      await page.keyboard.down(mod);
      await page.keyboard.press("Enter"); // ejecutar celda
      await page.keyboard.up(mod);
      console.log(`▶️ Celda ${i + 1} ejecutada`);
    } else {
      console.warn(`⚠️ No se encontró editor en la celda ${i + 1}`);
    }

    if (i === 2) {
      try {
        const outputHandle = await cell.waitForSelector(
          ".cell-output, .cell-output-stdout, .output, .output_subarea",
          { timeout: 120_000 }
        );
        await page.waitForFunction(
          el => (el.innerText || el.textContent || '').trim().length > 0,
          outputHandle,
          { timeout: 300_000 }
        );
        result = await page.evaluate(el => el.innerText || el.textContent, outputHandle);
        console.log(`📜 Resultado de la celda 3:`, (result || "").slice(0, 200), "...");
      } catch (err) {
        console.warn("⚠️ Sin salida en la celda 3:", err.message);
      }
      break;
    }

    await sleep(1200);
  }

  const storage = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
  console.log("💾 storageState actualizado en", SESSION_FILE);

  await page.close();
  return result;
}

// ==================== Endpoint API ====================
app.post("/match", upload.single("file"), async (req, res) => {
  try {
    console.log("📥 POST /match recibido");
    if (!req.file) return res.status(400).json({ error: "missing file" });

    const isVideo = (req.file.mimetype || "").startsWith("video/");
    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    // ⬇️ NEW: si es vídeo, súbelo a Drive usando la API
    if (isVideo) {
      console.log("🎬 Archivo detectado como VIDEO. Subiendo a Google Drive vía API...");
      const driveInfo = await uploadFileToDrive(
        req.file.path,
        req.file.originalname || req.file.filename,
        req.file.mimetype
      );

      // Limpieza local del archivo tras subirlo
      fs.unlink(req.file.path, (err) => {
        if (err) console.warn("No se pudo borrar el archivo local:", err.message);
      });

      return res.json({
        ok: true,
        type: "video",
        drive: {
          id: driveInfo.id,
          name: driveInfo.name,
          mimeType: driveInfo.mimeType,
          size: driveInfo.size,
          webViewLink: driveInfo.webViewLink,
          webContentLink: driveInfo.webContentLink
        }
      });
    }

    // 👇 Si NO es vídeo, mantener tu flujo actual con Colab
    const result = await run_colab_job(req.body.start_url, imageUrl);

    res.json({ ok: true, type: "image", result, imageUrl });
  } catch (err) {
    console.error("🔥 Error en /match:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Servir estáticos
app.use('/uploads', express.static('uploads'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
  console.log(`   POST /match (file: image|video)`);
});
