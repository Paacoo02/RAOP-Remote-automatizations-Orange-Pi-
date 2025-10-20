import { Miniflare } from "miniflare";

const mf = new Miniflare({
  // Worker principal
  scriptPath: "functions/index.js", // cámbialo si tu entrypoint es otro

  // Archivos estáticos (Pages)
  assets: {
    directory: "public"
  },

  // Configuración
  kvNamespaces: ["KEYVALUE"],
  compatibilityDate: "2025-09-13",
  envPath: true, // lee variables de .env
});

const server = await mf.startServer();
console.log(`🚀 Miniflare running at http://localhost:${server.address().port}`);
