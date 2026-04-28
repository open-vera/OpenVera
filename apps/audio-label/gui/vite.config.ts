import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { usePolling: false },
  },
  resolve: {
    alias: {
      worker_threads: path.resolve(__dirname, "src/worker_threads_stub.js"),
    },
  },
});
