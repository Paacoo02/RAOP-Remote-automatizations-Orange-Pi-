const express = require("express");
const { spawn } = require("child_process");
const multer = require("multer"); 
const fs = require("fs"); 
const path = require("path"); 
const os = require("os"); 
const { enableGpuAndRun } = require("./gpu_enabler.js"); // <-- Importante

const app = express();
const port = 3000;

const upload = multer({ dest: os.tmpdir() });
app.use(express.json());

/**
 * Función para ejecutar el script de Python (Acepta 3 args)
 */
function runPythonScraper(startUrl, imagePath, gpuUrl) {
  return new Promise((resolve, reject) => {
    
    // --- BLOQUE CORREGIDO ---
    // Apunta al ejecutable de Python DENTRO de tu entorno virtual.
    // Ajusta "venv" si tu carpeta se llama diferente (ej: ".venv", "mi_entorno").
    const pythonExecutable = path.resolve(
      __dirname,
      "venv", // <--- Asegúrate que este sea el nombre de tu carpeta venv
      "bin",
      "python"
    );
    // -------------------------

    // Este log ahora mostrará la ruta completa, lo cual es mejor para depurar
    console.log(
      `🐍 Ejecutando Python: ${pythonExecutable} image_scrapper.py "${startUrl}" "${imagePath}" "${gpuUrl}"`
    );

    // const pythonExecutable = "python3"; // <-- ESTA ES LA LÍNEA ANTIGUA
    
    const pythonProcess = spawn(
      pythonExecutable, // <-- Se usa la ruta completa al venv
      [
        "-X",
        "utf8",
        "image_scrapper.py",
        startUrl, // sys.argv[1]
        imagePath, // sys.argv[2]
        gpuUrl, // sys.argv[3]
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let output = "";
    let errorOutput = "";

    pythonProcess.stdout.on("data", (data) => {
      const chunk = data.toString("utf8");
      process.stdout.write(`[PY_STDOUT] ${chunk}`);
      output += chunk;
    });

    pythonProcess.stderr.on("data", (data) => {
      const chunk = data.toString("utf8");
      process.stderr.write(`[PY_STDERR] ${chunk}`);
      errorOutput += chunk;
    });

    pythonProcess.on("error", (spawnError) => {
      console.error(
        `❌ Error al intentar ejecutar Python: ${spawnError.message}`
      );
      // Error común: "ENOENT" (Error NO ENTry) significa que la ruta al ejecutable es incorrecta.
      if (spawnError.code === 'ENOENT') {
           console.error(`👉 Parece que la ruta al Python del venv es incorrecta. Verificando: ${pythonExecutable}`);
      }
      reject(
        new Error(`Fallo al ejecutar el proceso Python: ${spawnError.message}`)
      );
    });

    pythonProcess.on("close", (code) => {
      console.log(`\n🐍 Proceso Python finalizado con código: ${code}`);
      if (code !== 0) {
        return reject(
          new Error(
            `Python script salió con código ${code}. Error: ${
              errorOutput.trim() || "Error desconocido en Python."
            }`
          )
        );
      }
      try {
        const lines = output.trim().split("\n");
        let lastJsonLine = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const trimmedLine = lines[i].trim();
          if (trimmedLine.startsWith("{") && trimmedLine.endsWith("}")) {
            lastJsonLine = trimmedLine;
            break;
          }
        }
        if (!lastJsonLine) {
          throw new Error(
            "No se encontró una línea JSON válida en la salida de Python."
          );
        }
        console.log(`🐍 Intentando parsear JSON final: ${lastJsonLine}`);
        const resultJson = JSON.parse(lastJsonLine);
        resolve(resultJson);
      } catch (parseError) {
        console.error("❌ Error al parsear la salida JSON de Python:", parseError);
        reject(
          new Error(
            `Falló al parsear la salida de Python como JSON. Output:\n${output}`
          )
        );
      }
    });
  });
}


/**
 * Endpoint Híbrido (CPU + GPU) con Fallback
 */
app.post("/scrape", upload.single('imageFile'), async (req, res) => {
  console.log("[API /scrape] Petición Híbrida recibida.");

  // 1. Validar archivo
  if (!req.file) {
    return res.status(400).json({ error: "El parámetro 'imageFile' (archivo) es requerido." });
  }
  const imagePath = req.file.path;
  console.log(`[API /scrape] Archivo temporal: ${imagePath}`);

  // 2. Validar URL a scrapear
  const { startUrl } = req.body;
  if (!startUrl) {
    fs.unlink(imagePath, () => {}); // Limpieza
    return res.status(400).json({ error: "El parámetro 'startUrl' (texto) es requerido." });
  }
  console.log(`[API /scrape] URL a scrapear: ${startUrl}`);

  let browser = null; 
  let cloudflareUrl = "NONE"; // <-- VALOR POR DEFECTO

  try {
    // 3. INTENTAR obtener la URL de la GPU
    console.log("[API /scrape] Iniciando Colab para (intentar) obtener la URL de GPU...");
    const colabResult = await enableGpuAndRun();
    browser = colabResult.browser; // Guardar el browser para cerrarlo

    if (colabResult.result) {
        cloudflareUrl = colabResult.result; // <-- Éxito
        console.log(`[API /scrape] URL de GPU Worker obtenida: ${cloudflareUrl}`);
    } else {
        console.warn("[API /scrape] ⚠️ 'enableGpuAndRun' terminó sin una URL. Revirtiendo a modo CPU.");
    }

  } catch (gpuError) {
    // 4. SI 'enableGpuAndRun' FALLA, capturamos el error y continuamos
    console.error(`[API /scrape] 🔥 Error al iniciar el GPU Worker: ${gpuError.message}`);
    console.warn("[API /scrape] ⚠️ No se pudo iniciar la GPU. Revirtiendo a modo CPU.");
    // 'cloudflareUrl' permanece como "NONE"
  }

  try {
    // 5. Ejecutar el Scraper de Python (SIEMPRE se ejecuta)
    // Pasará la URL real o la palabra "NONE"
    console.log(`[API /scrape] Iniciando script de Python (Modo: ${cloudflareUrl === 'NONE' ? 'CPU' : 'GPU'})...`);
    const scrapeResult = await runPythonScraper(startUrl, imagePath, cloudflareUrl); 

    console.log("[API /scrape] Proceso completado.");
    res.json(scrapeResult);

  } catch (pythonError) {
    // 6. Manejo de errores de Python
    console.error(`[API /scrape] 🔥 Error en el script de Python: ${pythonError.message}`);
    if (pythonError.stack) console.error(pythonError.stack);
    res.status(500).json({
        error: "Falló el proceso de scraping de Python.",
        details: pythonError.message
    });

  } finally {
    // 7. Limpieza
    if (imagePath) {
        fs.unlink(imagePath, (err) => {
            if (err) console.error(`[API /scrape] Error borrando archivo ${imagePath}:`, err);
            else console.log(`[API /scrape] Archivo temporal ${imagePath} borrado.`);
        });
    }
    if (browser) { // Solo cierra el browser si se llegó a crear
      console.log("[API /scrape] Cerrando el navegador Puppeteer...");
      try {
          if (browser.isConnected()) await browser.close();
      } catch (closeError) {
          console.error(`[API /scrape] Error al cerrar el navegador: ${closeError.message}`);
      }
    }
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor API (Híbrido) escuchando en http://localhost:${port}`);
  console.log(`  Endpoint: POST http://localhost:${port}/scrape`);
});