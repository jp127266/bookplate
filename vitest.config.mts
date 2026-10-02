import path from "path";
import { defineConfig } from "vitest/config";

// Pure-logic unit tests (`npm test`). This edition has no server, so the
// server edition's API suite is gone.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
