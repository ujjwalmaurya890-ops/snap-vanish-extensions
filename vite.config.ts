import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_BY_EXT: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".task": "application/octet-stream",
  ".tflite": "application/octet-stream",
};

/**
 * Serves /models/*, /wasm/*, and /vendor/* directly from extension/ during dev
 * and copies them into dist/ on production build without duplicating binaries in git.
 */
function localVisionAssetsPlugin(): Plugin {
  const assetFolders = ["models", "wasm", "vendor"];

  return {
    name: "snap-vanish-local-vision-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const cleanUrl = (req.url || "").split("?")[0];
        const match = assetFolders.find((dir) =>
          cleanUrl.startsWith(`/${dir}/`),
        );
        if (!match) return next();

        const rel = cleanUrl.replace(/^\/+/, "");
        const fullPath = path.resolve(__dirname, "extension", rel);
        const allowedRoot = path.resolve(__dirname, "extension", match);
        if (!fullPath.startsWith(allowedRoot) || !fs.existsSync(fullPath)) {
          return next();
        }

        const ext = path.extname(fullPath).toLowerCase();
        res.setHeader(
          "Content-Type",
          MIME_BY_EXT[ext] || "application/octet-stream",
        );
        res.setHeader("Cache-Control", "public, max-age=3600");
        fs.createReadStream(fullPath).pipe(res);
      });
    },
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist");
      if (!fs.existsSync(outDir)) return;
      for (const folder of assetFolders) {
        const srcDir = path.resolve(__dirname, "extension", folder);
        const destDir = path.resolve(outDir, folder);
        if (fs.existsSync(srcDir)) {
          fs.cpSync(srcDir, destDir, { recursive: true });
        }
      }
    },
  };
}

export default defineConfig(({ command }) => {
  const isProd = command === "build";

  return {
    base: "./",
    plugins: [react(), tailwindcss(), localVisionAssetsPlugin()],

    server: {
      host: "0.0.0.0",
      allowedHosts: true,
    },
    preview: {
      host: "0.0.0.0",
      allowedHosts: true,
    },

    resolve: {
      alias: [
        { find: "@/", replacement: path.resolve(__dirname, "src") },
        /**
         * Both surfaces (the React studio and the content script) must ship the
         * *same* MediaPipe build. The content script can only load the local
         * `extension/vendor/vision_bundle.mjs` at runtime, so aliasing the npm
         * package to that file removes a second ~420 kB copy from the studio
         * bundle and guarantees identical inference behaviour.
         */
        {
          find: /^@mediapipe\/tasks-vision$/,
          replacement: path.resolve(__dirname, "extension/vendor/vision_bundle.mjs"),
        },
      ],
    },

    build: {
      // Matches `minimum_chrome_version: 121` in the manifest — no downlevelling
      // of syntax the runtime already supports.
      target: "chrome121",
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
      // Skipping gzip sizing shaves several seconds off every build.
      reportCompressedSize: false,
      // Extension assets are local files; sub-4 kB inlining just adds base64 noise.
      assetsInlineLimit: 4096,
      chunkSizeWarningLimit: 900,
      cssCodeSplit: false,
      minify: "esbuild",
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          // Keep React/MediaPipe in dedicated chunks so a settings-only code change
          // does not invalidate the 400 kB vendor chunk in the packaged extension.
          manualChunks: {
            react: ["react", "react-dom"],
          },
        },
      },
    },

    esbuild: isProd
      ? {
          legalComments: "none",
          drop: ["debugger"],
          pure: ["console.debug", "console.trace"],
        }
      : undefined,

    define: {
      __SNAP_VANISH_PROD__: JSON.stringify(isProd),
    },
  };
});
