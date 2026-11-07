#!/usr/bin/env node
/** Verify a built extension archive against the current unpacked extension.
 * Plain `npm test` does not require a generated archive; `npm run verify`
 * invokes this after building it. Requires the `unzip` CLI used by the builder.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const archive = path.resolve(process.env.SV_PACKAGE_PATH || path.join(root, "snap-vanish-chrome-extension.zip"));
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");

function unpackedFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.endsWith(".DS_Store")) return [];
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in extension: ${name}`);
    if (entry.isDirectory()) return unpackedFiles(path.join(dir, entry.name), name);
    if (!entry.isFile()) throw new Error(`Unexpected entry in extension: ${name}`);
    return [name];
  });
}

try {
  if (!fs.existsSync(archive)) throw new Error(`Package not found: ${archive}. Run npm run build:extension first.`);
  assert(fs.statSync(archive).size > 5_000_000, "Package is unexpectedly small");
  execFileSync("unzip", ["-tqq", archive], { stdio: "pipe" });
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
    .split(/\r?\n/).filter(Boolean);
  assert.equal(new Set(entries).size, entries.length, "Package contains duplicate entries");
  for (const name of entries) {
    assert(!name.startsWith("/") && !name.startsWith("-") && !name.includes("\\") &&
      !name.split("/").some((part) => part === ".." || part === "."), `Unsafe archive path: ${name}`);
  }
  const archivedFiles = entries.filter((name) => !name.endsWith("/")).sort();
  const expectedFiles = unpackedFiles(extDir).sort();
  assert.deepEqual(archivedFiles, expectedFiles, "Archive files differ from unpacked extension");
  for (const name of expectedFiles) {
    const packaged = execFileSync("unzip", ["-p", archive, name], { maxBuffer: 32 * 1024 * 1024 });
    const source = fs.readFileSync(path.join(extDir, name));
    assert.equal(hash(packaged), hash(source), `Archive content differs: ${name}`);
  }
  console.log(`✓ Package integrity: ${expectedFiles.length} files match extension/ and archive CRC checks pass.`);
} catch (error) {
  console.error(`Package integrity failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
