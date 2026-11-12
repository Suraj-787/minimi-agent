import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Root is web/ so the UI stays a thin, separate package-in-a-folder.
// The proxy lets the browser call /api on :5173 without CORS during dev. It follows PORT (.env or the
// shell), the same variable the server listens on, so changing PORT does not break the UI.
export default defineConfig(({ mode }) => {
  const apiPort = loadEnv(mode, process.cwd(), "").PORT || "8787";
  return {
    root: "web",
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: { "/api": `http://localhost:${apiPort}` },
    },
    build: { outDir: "../dist/web", emptyOutDir: true },
  };
});
