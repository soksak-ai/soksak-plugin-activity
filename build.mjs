// soksak-plugin-activity 번들 — esbuild 단일 ESM main.js(loader 가 blob-URL 로 import).
import { build } from "esbuild";
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
console.log("[activity] built main.js");
