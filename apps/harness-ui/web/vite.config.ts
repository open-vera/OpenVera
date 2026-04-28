import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 7701,
    proxy: {
      "/api": {
        target: "http://localhost:7700",
        changeOrigin: true,
      },
    },
  },
});
