// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package verification boundary", () => {
  it("fails explicitly when package verification is requested without an archive", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-vanish-package-test-"));
    try {
      const result = spawnSync(process.execPath, ["scripts/verify-package.mjs"], {
        cwd: process.cwd(), env: { ...process.env, SV_PACKAGE_PATH: path.join(dir, "missing.zip") }, encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Package not found");
      expect(result.stderr).toContain("npm run build:extension");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
