import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  noExternal: ["@ia/core", "@ia/data"],
  banner: {
    js: "#!/usr/bin/env node"
  }
});
