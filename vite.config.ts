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
export function localVisionAssetsPlugin(projectRoot = __dirname): Plugin {
  const assetFolders = ["models", "wasm", "vendor"];
  const extensionRoot = path.resolve(projectRoot, "extension");
  const within = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative !== "" && relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  return {
    name: "snap-vanish-local-vision-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent((req.url || "").split("?")[0]);
        } catch {
          res.statusCode = 400;
          return res.end("Malformed path");
        }
        const match = assetFolders.find((dir) => pathname.startsWith(`/${dir}/`));
        if (!match) return next();
        const reject = (status: 400 | 403 | 404 | 405) => {
          res.statusCode = status;
          const messages = { 400: "Bad request", 403: "Forbidden", 404: "Not found", 405: "Method not allowed" };
          res.end(messages[status]);
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.setHeader("Allow", "GET, HEAD");
          return reject(405);
        }
        // Reject platform separators and NULs even on systems where they would
        // otherwise be treated as ordinary filename characters.
        if (pathname.includes("\\") || pathname.includes("\0")) return reject(400);
        const allowedRoot = path.join(extensionRoot, match);
        const fullPath = path.resolve(allowedRoot, pathname.slice(match.length + 2));
        if (!within(allowedRoot, fullPath)) return reject(403);

        try {
          const realExtension = fs.realpathSync(extensionRoot);
          const realRoot = fs.realpathSync(allowedRoot);
          // The asset directory itself may not redirect to another folder.
          if (realRoot !== path.join(realExtension, match)) return reject(403);
          const realFile = fs.realpathSync(fullPath);
          if (!within(realRoot, realFile)) return reject(403);
          if (!fs.statSync(realFile).isFile()) return reject(404);

          const ext = path.extname(fullPath).toLowerCase();
          res.setHeader("Content-Type", MIME_BY_EXT[ext] || "application/octet-stream");
          res.setHeader("Cache-Control", "public, max-age=3600");
          if (req.method === "HEAD") return res.end();
          const stream = fs.createReadStream(realFile);
          stream.on("error", () => {
            if (!res.headersSent) res.statusCode = 500;
            res.end();
          });
          stream.pipe(res);
        } catch {
          return reject(404);
        }
      });
    },
    closeBundle() {
      const outDir = path.resolve(projectRoot, "dist");
      if (!fs.existsSync(outDir)) return;
      for (const folder of assetFolders) {
        const srcDir = path.join(extensionRoot, folder);
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

    // Permit the proxied Arena preview domain without disabling Vite's host
    // protection for arbitrary domain names. Vite also permits localhost and IPs.
    server: {
      host: "0.0.0.0",
      allowedHosts: [".e2b.app"],
    },
    preview: {
      host: "0.0.0.0",
      allowedHosts: [".e2b.app"],
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
