import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Root is web/ so the UI stays a thin, separate package-in-a-folder.
// The proxy lets the browser call /api on :5173 without CORS during dev.
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
