import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  assets: "public",
  kvNamespaces: ["KEYVALUE"],
  compatibilityDate: "2025-09-13",
  envPath: true, // lee .env
});

const server = await mf.startServer();
console.log(`🚀 Miniflare running at http://localhost:${server.address().port}`);
