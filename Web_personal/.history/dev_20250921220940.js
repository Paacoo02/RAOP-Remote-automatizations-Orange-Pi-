import { Miniflare } from "miniflare";

const mf = new Miniflare({
  // ⚡️ Entry point del Worker
  scriptPath: "functions/index.js", // o el que sea tu handler principal

  // 📂 Archivos estáticos (Pages)
  assets: "public",

  // ⚙️ Configuración
  kvNamespaces: ["KEYVALUE"],
  compatibilityDate: "2025-09-13",
  envPath: true, // carga variables de .env
});

const server = await mf.startServer();
console.log(`🚀 Miniflare running at http://localhost:${server.address().port}`);
