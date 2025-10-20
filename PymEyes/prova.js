const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");

// importamos la función de login automático que ya sabe
// pulsar "Sign in" e introducir credenciales
const { attemptGoogleLogin } = require("./auto_log_in.js");

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

// === Función principal de Colab ===
async function run_colab_job(start_url, image_path) {
  // Login automático a Google
  const { browser, context } = await attemptGoogleLogin();

  // abrir Colab con la sesión ya autenticada
  const page = await context.newPage();
  console.log("➡️ Abriendo Colab...");
  await page.goto(COLAB_NOTEBOOK_URL, { waitUntil: "domcontentloaded", timeout: 180_000 });

  // esperar a que cargue
  await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
  console.log("🌍 Notebook abierto");

  // esperar celdas
  await page.waitForSelector(".cell.code", { timeout: 60_000 });
  const cells = await page.$$(".cell.code");
  console.log(`🔎 Detectadas ${cells.length} celdas de código`);
  if (!cells.length) throw new Error("❌ No se encontró ninguna celda de código");

  // limpiar y escribir variables en la primera celda
  const firstCell = cells[0];
  await firstCell.evaluate(el => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  const editor = await firstCell.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await editor.click();

  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(mod);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(mod);
  await page.keyboard.press("Backspace");
  console.log("🧹 Contenido previo eliminado");

  await page.keyboard.type(`start_url = "${start_url}"\nimage_url = "${image_path}"`, { delay: 50 });
  console.log("✅ Variables inyectadas");

  // ejecutar celdas (ejemplo: hasta la tercera)
  let result = null;
  for (let i = 0; i < cells.length; i++) {
    await cells[i].click({ clickCount: 2 });
    await page.keyboard.down(mod);
    await page.keyboard.press("Enter"); // ejecutar celda
    await page.keyboard.up(mod);
    console.log(`▶️ Celda ${i + 1} ejecutada`);

    if (i === 2) {
      try {
        const outputHandle = await cells[i].waitForSelector(
          ".cell-output, .cell-output-stdout, .output, .output_subarea",
          { timeout: 120_000 }
        );

        await page.waitForFunction(
          el => (el.innerText || el.textContent || "").trim().length > 0,
          outputHandle,
          { timeout: 300_000 }
        );

        result = await page.evaluate(el => el.innerText || el.textContent, outputHandle);
        console.log("📜 Resultado de la celda 3:", (result || "").slice(0, 200), "...");
      } catch (err) {
        console.warn("⚠️ Sin salida en la celda 3:", err.message);
      }
      break;
    }

    await new Promise(r => setTimeout(r, 1200));
  }

  // guardar sesión
  const storage = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storage, null, 2));
  console.log("💾 storageState actualizado en", SESSION_FILE);

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
app.use("/uploads", express.static("uploads"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 API escuchando en http://0.0.0.0:${PORT}`);
});
