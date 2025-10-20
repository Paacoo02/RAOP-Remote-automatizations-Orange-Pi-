import { Miniflare } from "miniflare";

const mf = new Miniflare({
  // Si tienes funciones Workers
  scriptPath: "functions/index.js", // cámbialo si tu entrypoint es otro

  // Para los assets estáticos (Pages)
  assets: {
    directory: "public"
  },

  kvNamespaces: ["KEYVALUE"],
  compatibilityDate: "2025-09-13",
  envPath: true, // lee .env
});

// 🚀 Crear servidor HTTP a partir de Miniflare
const server = await mf.createServer();
server.listen(8787, () => {
  console.log("🚀 Miniflare running at http://localhost:8787");
});
