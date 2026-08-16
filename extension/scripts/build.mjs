import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist");

await rm(outDir, { recursive: true, force: true });

await build({
  root,
  configFile: false,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: resolve(root, "popup.html"),
    },
  },
});

for (const entry of [
  { input: "src/content/index.ts", name: "DouyinEnglishContent", output: "content.js" },
  { input: "src/background/serviceWorker.ts", name: "DouyinEnglishWorker", output: "background.js" },
]) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: true,
      lib: {
        entry: resolve(root, entry.input),
        name: entry.name,
        formats: ["iife"],
        fileName: () => entry.output,
      },
    },
  });
}

await copyFile(resolve(root, "manifest.json"), resolve(outDir, "manifest.json"));

const publicDir = resolve(root, "public");
if (existsSync(publicDir)) {
  await mkdir(outDir, { recursive: true });
  await cp(publicDir, outDir, { recursive: true });
}
