import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDirName = process.env.DOUYIN_ENGLISH_BUILD_OUT_DIR ?? "dist";
if (!/^dist(?:-[a-z0-9]+)*$/i.test(outDirName)) {
  throw new Error("DOUYIN_ENGLISH_BUILD_OUT_DIR must name a dist or dist-* directory");
}
const outDir = resolve(root, outDirName);
if (dirname(outDir) !== root) {
  throw new Error("Build output must be a direct child of the extension directory");
}

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
  { input: "src/content/mediaCaptureBridge.ts", name: "DouyinEnglishMediaBridge", output: "media-capture-bridge.js" },
  { input: "src/page/mediaCaptureHook.ts", name: "DouyinEnglishPageMediaHook", output: "page-media-hook.js" },
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
