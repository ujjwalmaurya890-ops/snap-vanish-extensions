// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();
const manifestPath = path.join(rootDir, "extension/manifest.json");
const builderPath = path.join(rootDir, "scripts/build-extension.mjs");

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

/** Run the real builder against a disposable minimal extension, not the checkout. */
function buildWithMatches(matches: unknown) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snap-vanish-war-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    fs.copyFileSync(builderPath, path.join(tempRoot, "scripts/build-extension.mjs"));

    const manifest = readManifest();
    manifest.web_accessible_resources[0].matches = matches;
    const extensionDir = path.join(tempRoot, "extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "manifest.json"),
      JSON.stringify(manifest),
    );

    // These files let the build reach its WAR checks without downloading assets.
    for (const relativePath of [
      "models/hand_landmarker.task",
      "models/selfie_segmentation.tflite",
      "wasm/vision_wasm_module_internal.js",
      "wasm/vision_wasm_module_internal.wasm",
      "vendor/vision_bundle.mjs",
    ]) {
      const target = path.join(extensionDir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "fixture");
    }

    return spawnSync(
      process.execPath,
      [path.join(tempRoot, "scripts/build-extension.mjs"), "--skip-build"],
      { cwd: tempRoot, encoding: "utf8", timeout: 10_000 },
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("Chrome web-accessible resource manifest validation", () => {
  it("exposes only the existing meeting origins while keeping Zoom injection scoped to /wc/", () => {
    const manifest = readManifest();
    const expectedOrigins = [
      "https://meet.google.com/*",
      "https://teams.microsoft.com/*",
      "https://teams.live.com/*",
      "https://*.zoom.us/*",
      "https://app.zoom.us/*",
    ];
    const expectedContentMatches = [
      "https://meet.google.com/*",
      "https://teams.microsoft.com/*",
      "https://teams.live.com/*",
      "https://*.zoom.us/wc/*",
      "https://app.zoom.us/wc/*",
    ];

    expect(manifest.permissions).toEqual(["storage", "offscreen"]);
    expect(manifest.web_accessible_resources).toHaveLength(1);
    expect(manifest.web_accessible_resources[0].matches).toEqual(expectedOrigins);
    expect(manifest.web_accessible_resources[0].resources).toEqual([
      "models/hand_landmarker.task",
      "wasm/vision_wasm_module_internal.js",
      "wasm/vision_wasm_module_internal.wasm",
      "vendor/vision_bundle.mjs",
    ]);
    expect(manifest.host_permissions).toEqual(expectedContentMatches);
    for (const script of manifest.content_scripts as Array<{ matches: string[] }>) {
      expect(script.matches).toEqual(expectedContentMatches);
    }
  });

  it.each([
    "https://*.zoom.us/wc/*",
    "https://app.zoom.us/wc/*",
    "https://meet.google.com/private/*",
    "https://meet.google.com/",
    "https://meet.google.com/*?extra=1",
    "https://*zoom.us/*",
    "http://meet.google.com/*",
    "https://*/*",
    "*://*/*",
    "<all_urls>",
    "https://unrelated.example/*",
  ])("the builder rejects invalid or undeclared WAR match %s", (match) => {
    const result = buildWithMatches([match]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/web-accessible resource match/i);
    expect(result.stdout).not.toContain("5. Packaging");
  });

  it.each([
    ["null", null],
    ["number", 42],
    ["object", {}],
    ["empty string", ""],
  ])("the builder rejects a %s WAR match", (_description, match) => {
    const result = buildWithMatches([match]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/web-accessible resource match/i);
    expect(result.stdout).not.toContain("5. Packaging");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", []],
    ["not an array", "https://meet.google.com/*"],
  ])("the builder rejects %s WAR matches", (_description, matches) => {
    const result = buildWithMatches(matches);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/web-accessible resource matches/i);
    expect(result.stdout).not.toContain("5. Packaging");
  });
});
