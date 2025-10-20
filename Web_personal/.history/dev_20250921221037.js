import { Miniflare } from "miniflare";

const mf = new Miniflare({
  assets: { directory: "public" },
  compatibilityDate: "2025-09-13",
  kvNamespaces: ["KEYVALUE"],
  envPath: true,
});

// 🔥 Usar servidor integrado de Miniflare v3
const httpServer = await mf.start(); // 👈 Este sí existe en v3
console.log(`🚀 Miniflare running at ${httpServer.address().address}:${httpServer.address().port}`);
