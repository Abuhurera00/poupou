import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: { "@": resolve("src/renderer/src") },
    },
    plugins: [react(), tailwindcss()],
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
