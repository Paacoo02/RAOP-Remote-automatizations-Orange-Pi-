const express = require("express");
const multer = require("multer");
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const UserAgent = require('user-agents');
const cors = require("cors");
const { attemptGoogleLogin } = require("./auto_log_in.js"); // ⬅️ Importamos login automático

// Configuración Stealth
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

// Sleep con variabilidad
function sleep(minMs, maxMs = null) {
  const ms = maxMs ? Math.random() * (maxMs - minMs) + minMs : minMs;
  return new Promise((r) => setTimeout(r, ms));
}

// === Función principal de Colab ===
// Playwright-only + reusa navegador/contexto logueado
async function run_colab_job(start_url, image_path) {
  // attemptGoogleLogin() debe devolver { browser, context } (Playwright) y NO cerrar el browser
  const { browser, context } = await attemptGoogleLogin();

  // pestaña nueva dentro del MISMO contexto autenticado
  const page = await context.newPage();

  // 🚀 Ir al notebook (solo una vez). En Playwright: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: 'networkidle', timeout: 90_000 });
  console.log("🌍 Notebook abierto");

  // Detectar celdas
  await page.waitForSelector(".cell.code", { timeout: 60_000 });
  const cells = await page.$$(".cell.code");
  console.log(`🔎 Detectadas ${cells.length} celdas de código`);
  if (!cells.length) throw new Error("❌ No se encontró ninguna celda de código");

  // Editar la primera celda
  const firstCell = cells[0];
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 1000));

  await firstCell.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await new Promise(r => setTimeout(r, 1000));

  const editor = await firstCell.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await editor.click();
  await new Promise(r => setTimeout(r, 500));

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(mod);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(mod);
  await page.keyboard.press("Backspace");
  console.log("🧹 Contenido previo eliminado");

  await page.keyboard.type(`start_url = "${start_url}"\nimage_url = "${image_path}"`, { delay: 50 });
  console.log("✅ Variables inyectadas");

  // Ejecutar celdas y leer salida de la 3ª
  let result = null;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    await cell.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await new Promise(r => setTimeout(r, 400));

    await cell.click({ clickCount: 2 });
    await new Promise(r => setTimeout(r, 300));

    const ed = await cell.$(".monaco-editor");
    if (ed) {
      await ed.click();
      await new Promise(r => setTimeout(r, 200));

      await page.keyboard.down(mod);
      await page.keyboard.press("Enter"); // atajo Colab ejecutar celda
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

        // Playwright: waitForFunction(fn, arg, options)
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

    await new Promise(r => setTimeout(r, 1200));
  }

  // Guardar estado de sesión (Playwright): cookies + storage
  const storage = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
  console.log("💾 storageState actualizado en", SESSION_FILE);

  // No cierres el browser: lo reutiliza attemptGoogleLogin()
  await page.close();
  return result;
}

  

// === Endpoint API ===
app.post("/match", upload.single("file"), async (req, res) => {
  try {
    console.log("📥 POST /match recibido");
    if (!req.file) return res.status(400).json({ error: "missing file" });

    const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    const result = await run_colab_job(req.body.start_url, imageUrl);

    res.json({ result, imageUrl });
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
});
