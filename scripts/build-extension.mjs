#!/usr/bin/env node
/**
 * Snap Vanish 2.0 — Reproducible Chrome MV3 Extension Builder & Validator
 *
 * 1. Verifies local MediaPipe WASM & TFLite assets in `extension/{models,wasm,vendor}`
 * 2. Builds the React Control Center & Studio (`vite build` -> `dist/`)
 * 3. Copies compiled CSP-safe UI assets (`dist/index.html` + `dist/assets/*`) into `extension/studio/`
 * 4. Audits `extension/manifest.json` (MV3 CSP, permission minimality, WAR scoping,
 *    offscreen document hygiene) and the packaged release zip
 * 5. Packages the unpacked `extension/` folder into `snap-vanish-chrome-extension.zip`
 *    (the zip is a build artifact and is git-ignored)
 *
 * Usage: npm run build:extension [-- --skip-build]
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
const SKIP_BUILD = process.argv.includes("--skip-build");

/** Hard ceiling for the unpacked extension; Store review flags anything bigger. */
const MAX_UNPACKED_MB = 30;

const ALLOWED_PERMISSIONS = new Set(["storage", "offscreen"]);
const ALLOWED_HOST_RE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/.+$/i;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function assertExists(relPath) {
  const full = path.join(EXT_DIR, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required extension file: extension/${relPath}`);
  }
}

function assertNoInlineExecutableScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scriptTags) {
    if (!/\bsrc\s*=/i.test(tag)) {
      throw new Error(
        `MV3 CSP Violation: inline <script> in ${path.relative(ROOT, htmlPath)}: ${tag}`,
      );
    }
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) {
    throw new Error(
      `MV3 CSP Violation: inline event handler in ${path.relative(ROOT, htmlPath)}`,
    );
  }
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
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

if (!SKIP_BUILD) {
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
    fs.cpSync(path.join(DIST_DIR, "assets"), path.join(STUDIO_DIR, "assets"), {
      recursive: true,
    });
  }
} else {
  console.log("2-3. Skipping Vite build (--skip-build)");
}

console.log("4. Validating manifest, CSP, permissions, WAR and offscreen hygiene...");
const manifest = JSON.parse(
  fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"),
);

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");

const csp = manifest.content_security_policy?.extension_pages || "";
if (!csp.includes("'wasm-unsafe-eval'")) {
  fail(`MV3 CSP must include 'wasm-unsafe-eval'. Found: ${csp}`);
}
if (csp.includes("'unsafe-eval'") || csp.includes("'unsafe-inline'")) {
  fail(`MV3 CSP contains a forbidden source: ${csp}`);
}

// --- Permission minimality -------------------------------------------------
const permissions = manifest.permissions || [];
const illegalPermissions = permissions.filter((p) => !ALLOWED_PERMISSIONS.has(p));
if (illegalPermissions.length > 0) {
  fail(
    `Unexpected permission(s): ${illegalPermissions.join(", ")}. ` +
      `Allowed set: ${[...ALLOWED_PERMISSIONS].join(", ")}`,
  );
}

const hostPermissions = manifest.host_permissions || [];
if (hostPermissions.length === 0) {
  fail("host_permissions must enumerate the supported meeting origins");
}
for (const pattern of hostPermissions) {
  if (pattern === "<all_urls>" || !ALLOWED_HOST_RE.test(pattern)) {
    fail(`Over-broad host permission: ${pattern}`);
  }
}

// --- Web accessible resources ---------------------------------------------
for (const entry of manifest.web_accessible_resources || []) {
  for (const resource of entry.resources) {
    if (resource === "*" || resource === "/*" || resource.endsWith("/*")) {
      fail(
        `Web accessible resource '${resource}' exposes a whole directory; ` +
          `list the individual files instead.`,
      );
    }
    assertExists(resource);
  }
  for (const match of entry.matches) {
    if (match === "<all_urls>" || match === "*://*/*") {
      fail(`Web accessible resource exposed to all origins: ${match}`);
    }
  }
}

// --- Referenced files ------------------------------------------------------
assertExists(manifest.background.service_worker);
assertExists(manifest.action.default_popup);
assertExists(manifest.options_page);
assertExists("offscreen/offscreen.html");
assertExists("offscreen/offscreen.js");
for (const iconPath of Object.values(manifest.icons || {})) assertExists(iconPath);
for (const cs of manifest.content_scripts || []) {
  for (const jsFile of cs.js || []) assertExists(jsFile);
  for (const cssFile of cs.css || []) assertExists(cssFile);
}
for (const reqFile of requiredModelFiles) assertExists(reqFile);

// The offscreen document is created by the worker, so its path is not in the
// manifest — assert the two agree.
const swSource = fs.readFileSync(
  path.join(EXT_DIR, manifest.background.service_worker),
  "utf8",
);
if (!swSource.includes("offscreen/offscreen.html")) {
  fail("background.js no longer creates the offscreen document at offcreen/offscreen.html");
}
if (!permissions.includes("offscreen") && swSource.includes("chrome.offscreen")) {
  fail("background.js uses chrome.offscreen but the 'offscreen' permission is missing");
}

assertNoInlineExecutableScript(path.join(EXT_DIR, "popup/popup.html"));
assertNoInlineExecutableScript(path.join(EXT_DIR, "offscreen/offscreen.html"));
assertNoInlineExecutableScript(path.join(STUDIO_DIR, "index.html"));

const unpackedMb = dirSizeBytes(EXT_DIR) / (1024 * 1024);
if (unpackedMb > MAX_UNPACKED_MB) {
  fail(
    `Unpacked extension is ${unpackedMb.toFixed(1)} MB (limit ${MAX_UNPACKED_MB} MB). ` +
      `Trim duplicated assets before packaging.`,
  );
}

console.log("5. Packaging snap-vanish-chrome-extension.zip...");
if (fs.existsSync(ZIP_OUT)) fs.unlinkSync(ZIP_OUT);
execSync(`zip -r -q "${ZIP_OUT}" . -x "*.DS_Store"`, {
  cwd: EXT_DIR,
  stdio: "inherit",
});

const zipSizeMb = (fs.statSync(ZIP_OUT).size / (1024 * 1024)).toFixed(2);
console.log(
  `✓ Snap Vanish ${manifest.version} verified — unpacked ${unpackedMb.toFixed(
    1,
  )} MB, packaged ${zipSizeMb} MB -> snap-vanish-chrome-extension.zip`,
);
console.log("  (the zip is a build artifact and is git-ignored)");
