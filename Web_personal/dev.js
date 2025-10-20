import { Miniflare } from "miniflare";

const mf = new Miniflare({
  compatibilityDate: "2025-09-13",

  // 📂 carpeta de estáticos (imitando Cloudflare Pages)
  assets: {
    directory: "public"
  },

  kvNamespaces: ["KEYVALUE"],

  envPath: true, // lee .env y wrangler.toml
});

// 🚀 arrancar servidor local
const server = await mf.startServer();
console.log(`🚀 Miniflare running at http://localhost:${server.address().port}`);
