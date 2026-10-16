import { copyFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * The speech model runs on onnxruntime's WebAssembly build. By default it would
 * be fetched from a CDN at run time; this serves it from node_modules in dev and
 * copies it next to the pages on build, so voice input works offline.
 */
const ORT_DIR = resolve("node_modules/onnxruntime-web/dist");
const ORT_FILES = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

function onnxRuntime(): Plugin {
  return {
    name: "poupou-onnx-runtime",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0].split("/ort/")[1];
        if (!name || !ORT_FILES.includes(name)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(join(ORT_DIR, name)).pipe(res);
      });
    },
    writeBundle(options) {
      const out = join(options.dir ?? resolve("out/renderer"), "ort");
      mkdirSync(out, { recursive: true });
      for (const name of ORT_FILES) {
        const from = join(ORT_DIR, name);
        if (existsSync(from)) copyFileSync(from, join(out, name));
        else this.warn(`${from} is missing — voice input will not work`);
      }
    },
  };
}

/**
 * onnxruntime also points at its .wasm with `new URL(…, import.meta.url)`, so
 * the worker build emits a second, hashed 27 MB copy. The runtime is told to
 * use the one in ort/ instead (see voice/worker.ts), so the copy can go.
 */
function dropBundledWasm(): Plugin {
  return {
    name: "poupou-drop-bundled-wasm",
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm-simd-threaded[^/]*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: { "@": resolve("src/renderer/src") },
    },
    plugins: [react(), tailwindcss(), onnxRuntime()],
    // The speech worker loads the runtime with a dynamic import, which only an
    // ES-module worker can do.
    worker: { format: "es", plugins: () => [dropBundledWasm()] },
    build: {
      rollupOptions: {
        input: {
          // The island is plain TypeScript + Canvas; the settings window is React.
          index: resolve("src/renderer/index.html"),
          settings: resolve("src/renderer/settings.html"),
        },
      },
    },
  },
});
