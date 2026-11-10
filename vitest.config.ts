import { defineConfig } from "vitest/config";

// Separate from vite.config.ts because that one sets root: "web".
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
