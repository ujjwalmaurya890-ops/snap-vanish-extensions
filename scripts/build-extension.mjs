#!/usr/bin/env node
/**
 * Snap Vanish 2.0 — Reproducible Chrome MV3 Extension Builder & Validator
 *
 * 1. Verifies local MediaPipe WASM & TFLite assets in `extension/{models,wasm,vendor}`
 * 2. Builds the React Control Center & Studio (`vite build` -> `dist/`)
 * 3. Copies compiled CSP-safe UI assets (`dist/index.html` + `dist/assets/*`) into `extension/studio/`
 * 4. Audits `extension/manifest.json` paths, MV3 CSP syntax, and zero-inline-script compliance
 * 5. Packages the unpacked `extension/` folder into `snap-vanish-chrome-extension.zip`
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "extension");
const STUDIO_DIR = path.join(EXT_DIR, "studio");
const DIST_DIR = path.join(ROOT, "dist");
const ZIP_OUT = path.join(ROOT, "snap-vanish-chrome-extension.zip");

function assertExists(relPath) {
  const full = path.join(EXT_DIR, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required extension file: extension/${relPath}`);
  }
}

function assertNoInlineExecutableScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  // Match <script> tags without a src="..." attribute
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scriptTags) {
    if (!/\bsrc\s*=/i.test(tag)) {
      throw new Error(
        `MV3 CSP Violation: Inline <script> tag detected in ${path.relative(ROOT, htmlPath)}: ${tag}`,
      );
    }
  }
}

console.log("1. Checking local MediaPipe WASM & model binaries...");
const requiredModelFiles = [
  "models/hand_landmarker.task",
  "models/selfie_segmentation.tflite",
  "wasm/vision_wasm_module_internal.js",
  "wasm/vision_wasm_module_internal.wasm",
  "vendor/vision_bundle.mjs",
];
const missingAssets = requiredModelFiles.filter(
  (rel) => !fs.existsSync(path.join(EXT_DIR, rel)),
);
if (missingAssets.length > 0) {
  console.log("   Provisioning missing local vision assets...");
  execSync("node scripts/prepare-assets.mjs", { cwd: ROOT, stdio: "inherit" });
}

console.log("2. Building Control Center & Effect Studio with Vite...");
execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });

console.log("3. Syncing compiled Studio UI into extension/studio/...");
fs.rmSync(STUDIO_DIR, { recursive: true, force: true });
fs.mkdirSync(STUDIO_DIR, { recursive: true });
fs.copyFileSync(
  path.join(DIST_DIR, "index.html"),
  path.join(STUDIO_DIR, "index.html"),
);
if (fs.existsSync(path.join(DIST_DIR, "assets"))) {
  fs.cpSync(
    path.join(DIST_DIR, "assets"),
    path.join(STUDIO_DIR, "assets"),
    { recursive: true },
  );
}

console.log("4. Validating extension/manifest.json & MV3 CSP compliance...");
const manifest = JSON.parse(
  fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"),
);
if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

const csp = manifest.content_security_policy?.extension_pages || "";
if (!csp.includes("'wasm-unsafe-eval'")) {
  throw new Error(
    `MV3 CSP must include single-quoted 'wasm-unsafe-eval'. Found: ${csp}`,
  );
}

assertExists(manifest.background.service_worker);
assertExists(manifest.action.default_popup);
assertExists(manifest.options_page);
for (const iconPath of Object.values(manifest.icons || {})) {
  assertExists(iconPath);
}
for (const cs of manifest.content_scripts || []) {
  for (const jsFile of cs.js || []) assertExists(jsFile);
  for (const cssFile of cs.css || []) assertExists(cssFile);
}
for (const reqFile of requiredModelFiles) {
  assertExists(reqFile);
}

assertNoInlineExecutableScript(path.join(EXT_DIR, "popup/popup.html"));
assertNoInlineExecutableScript(path.join(STUDIO_DIR, "index.html"));

console.log("5. Packaging snap-vanish-chrome-extension.zip...");
if (fs.existsSync(ZIP_OUT)) {
  fs.unlinkSync(ZIP_OUT);
}
execSync(`zip -r -q "${ZIP_OUT}" .`, { cwd: EXT_DIR, stdio: "inherit" });

const zipSizeMb = (fs.statSync(ZIP_OUT).size / (1024 * 1024)).toFixed(2);
console.log(
  `✓ Snap Vanish ${manifest.version} extension built and verified (${zipSizeMb} MB -> snap-vanish-chrome-extension.zip)`,
);
