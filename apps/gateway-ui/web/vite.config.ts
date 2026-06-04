import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 7704,
    proxy: {
      "/api": {
        target: "http://localhost:7720",
        changeOrigin: true,
      },
    },
  },
});
