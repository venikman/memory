import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    {
      name: "externalize-node-sqlite",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") {
          return { id, external: true };
        }
        return null;
      }
    }
  ],
  test: {
    environment: "node",
    deps: {
      external: ["node:sqlite", "sqlite"]
    }
  },
  resolve: {
    alias: {
      "@ia/data": fileURLToPath(new URL("../data/src/index.ts", import.meta.url)),
      // Vite doesn't recognize node:sqlite as a builtin yet; it may try to resolve "sqlite".
      sqlite: "node:sqlite"
    }
  },
  ssr: {
    external: ["node:sqlite", "sqlite"]
  }
});
