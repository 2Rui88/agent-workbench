import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  base: "/board/",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:47321",
      "/events": "http://127.0.0.1:47321",
      "/health": "http://127.0.0.1:47321"
    }
  }
});
