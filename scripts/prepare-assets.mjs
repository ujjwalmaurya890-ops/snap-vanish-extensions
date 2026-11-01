#!/usr/bin/env node
/**
 * Snap Vanish 2.0 — Local Computer Vision Asset Provisioner & Verifier
 *
 * Ensures that local MediaPipe runtime & model files exist in extension/
 * with cryptographic SHA-256 verification so both the Chrome MV3 extension
 * and the Vite web studio run 100% locally with zero runtime CDN requests.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const EXPECTED_HAND_TASK_SHA256 =
  "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

const HAND_TASK_BLOB_URL =
  "https://api.github.com/repos/pasunim/DT-508-Tasks-API/git/blobs/0d53faf3786146e95c5bc010c48029ff16b7fa59";

const SELFIE_NPM_TARBALL =
  "https://registry.npmjs.org/@mediapipe/selfie_segmentation/-/selfie_segmentation-0.1.1675465747.tgz";

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fetchBuffer(url, headers = {}) {
  const args = ["-fsSL", "-A", "snap-vanish-asset-builder/2.0.0"];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  return execFileSync("curl", args, { maxBuffer: 50 * 1024 * 1024 });
}

function extractFileFromTarBuffer(tarBuf, targetEntryName) {
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeOctal || "0", 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (rawName === targetEntryName) {
      return tarBuf.subarray(dataStart, dataEnd);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function main() {
  const vendorDir = path.join(ROOT, "extension", "vendor");
  const wasmDir = path.join(ROOT, "extension", "wasm");
  const modelsDir = path.join(ROOT, "extension", "models");

  ensureDir(vendorDir);
  ensureDir(wasmDir);
  ensureDir(modelsDir);

  // 1. Copy @mediapipe/tasks-vision bundle & modularized SIMD WASM runtime
  const mpRoot = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision");
  const copyPairs = [
    [
      path.join(mpRoot, "vision_bundle.mjs"),
      path.join(vendorDir, "vision_bundle.mjs"),
    ],
    [
      path.join(mpRoot, "wasm", "vision_wasm_module_internal.js"),
      path.join(wasmDir, "vision_wasm_module_internal.js"),
    ],
    [
      path.join(mpRoot, "wasm", "vision_wasm_module_internal.wasm"),
      path.join(wasmDir, "vision_wasm_module_internal.wasm"),
    ],
  ];

  for (const [src, dest] of copyPairs) {
    if (!fs.existsSync(src)) {
      throw new Error(`Missing MediaPipe runtime file: ${src}. Run npm install first.`);
    }
    fs.copyFileSync(src, dest);
    console.log(`[assets] Synced ${path.relative(ROOT, dest)}`);
  }

  // 2. Provision & verify official Google MediaPipe hand_landmarker.task
  const handTaskPath = path.join(modelsDir, "hand_landmarker.task");
  const hasValidHandTask =
    fs.existsSync(handTaskPath) &&
    sha256File(handTaskPath) === EXPECTED_HAND_TASK_SHA256;

  if (!hasValidHandTask) {
    console.log("[assets] Fetching official MediaPipe hand_landmarker.task...");
    const buf = await fetchBuffer(HAND_TASK_BLOB_URL, {
      Accept: "application/vnd.github.raw",
    });
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (hash !== EXPECTED_HAND_TASK_SHA256) {
      throw new Error(
        `SHA-256 mismatch for hand_landmarker.task: expected ${EXPECTED_HAND_TASK_SHA256}, got ${hash}`,
      );
    }
    fs.writeFileSync(handTaskPath, buf);
    console.log(
      `[assets] Verified hand_landmarker.task (${buf.length} bytes, sha256=${hash.slice(0, 12)}…)`,
    );
  } else {
    console.log("[assets] hand_landmarker.task already present and SHA-256 verified.");
  }

  // 3. Provision official MediaPipe selfie_segmentation.tflite
  const selfieModelPath = path.join(modelsDir, "selfie_segmentation.tflite");
  if (!fs.existsSync(selfieModelPath) || fs.statSync(selfieModelPath).size < 200000) {
    console.log("[assets] Extracting selfie_segmentation.tflite from @mediapipe/selfie_segmentation...");
    const tgzBuf = await fetchBuffer(SELFIE_NPM_TARBALL);
    const tarBuf = zlib.gunzipSync(tgzBuf);
    const modelBuf = extractFileFromTarBuffer(
      tarBuf,
      "package/selfie_segmentation.tflite",
    );
    if (!modelBuf) {
      throw new Error("Could not locate package/selfie_segmentation.tflite in tarball.");
    }
    fs.writeFileSync(selfieModelPath, modelBuf);
    console.log(
      `[assets] Provisioned selfie_segmentation.tflite (${modelBuf.length} bytes)`,
    );
  } else {
    console.log("[assets] selfie_segmentation.tflite already present.");
  }
}

main().catch((err) => {
  console.error("[assets] ERROR:", err);
  process.exit(1);
});
