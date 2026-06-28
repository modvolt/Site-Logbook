import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(async ({ command }) => {
  const basePath = process.env.BASE_PATH;

  if (!basePath) {
    throw new Error(
      "BASE_PATH environment variable is required but was not provided.",
    );
  }

  // PORT is only needed when running a dev/preview server (`command === "serve"`).
  // A production `vite build` (e.g. in Docker / Coolify) does not bind a port, so
  // requiring PORT there would break the build for no reason.
  let port = 0;
  if (command === "serve") {
    const rawPort = process.env.PORT;

    if (!rawPort) {
      throw new Error(
        "PORT environment variable is required but was not provided.",
      );
    }

    port = Number(rawPort);

    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`Invalid PORT value: "${rawPort}"`);
    }
  }

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // Use injectManifest so we can ship a custom service worker that handles
        // the Background Sync API ("offline-flush" tag) in addition to the
        // standard Workbox precaching and NetworkFirst API caching.
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        registerType: "prompt",
        includeAssets: ["favicon.svg", "apple-touch-icon.png", "robots.txt"],
        manifest: {
          id: basePath,
          name: "Stavba – Evidence zakázek",
          short_name: "Stavba",
          description:
            "Evidence stavebních zakázek, úkolů a docházky pro Modvolt s.r.o.",
          lang: "cs",
          dir: "ltr",
          start_url: basePath,
          scope: basePath,
          display: "standalone",
          orientation: "portrait",
          theme_color: "#f59e0b",
          background_color: "#f8fafc",
          icons: [
            { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
            {
              src: "maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        // injectManifest: file-matching options only; all Workbox runtime
        // logic (NetworkFirst, navigation fallback, sync handler) lives in sw.ts.
        injectManifest: {
          // Precache the static app shell (HTML/JS/CSS/fonts/bundled images).
          globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
          // The main JS bundle is >2 MiB; raise the precache limit so the full
          // offline app shell is cached (default is 2 MiB, which fails the build).
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        devOptions: {
          enabled: false,
        },
      }),
      // Replit-only dev plugins. They are dynamically imported and gated on
      // REPL_ID so production builds (e.g. Docker / Coolify) never load them and
      // do not require the @replit/* dev dependencies to be installed.
      ...(process.env.NODE_ENV !== "production" &&
      process.env.REPL_ID !== undefined
        ? [
            await import("@replit/vite-plugin-runtime-error-modal").then((m) =>
              m.default(),
            ),
            await import("@replit/vite-plugin-cartographer").then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, ".."),
              }),
            ),
            await import("@replit/vite-plugin-dev-banner").then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(
          import.meta.dirname,
          "..",
          "..",
          "attached_assets",
        ),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    define: {
      // Inject build-time git SHA so the health page can compare frontend vs API versions.
      // Set VITE_BUILD_SHA in CI / Coolify build args. Falls back to "dev" at runtime.
      "import.meta.env.VITE_BUILD_SHA": JSON.stringify(
        process.env.VITE_BUILD_SHA ?? process.env.BUILD_SHA ?? process.env.COMMIT_SHA ?? "dev",
      ),
    },
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
