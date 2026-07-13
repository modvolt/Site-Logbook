import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Mirror the production esbuild `{ ".ttf": "base64" }` loader (see build.mjs) so
 * `.ttf` imports resolve to a base64 string under vitest too. Without this the
 * PDF font assets import as undefined and jsPDF crashes during invoice issuing.
 */
function ttfBase64(): Plugin {
  return {
    name: "ttf-base64",
    transform(_code, id) {
      if (!id.endsWith(".ttf") && !id.endsWith(".png")) return null;
      const base64 = readFileSync(id).toString("base64");
      const value = id.endsWith(".png") ? `data:image/png;base64,${base64}` : base64;
      return { code: `export default ${JSON.stringify(value)};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [ttfBase64()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
