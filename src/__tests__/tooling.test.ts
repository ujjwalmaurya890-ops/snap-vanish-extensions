// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("development tooling", () => {
  it("runs the configured benchmark without an undeclared TypeScript runner", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    expect(manifest.scripts.bench).toBe("node scripts/bench-dust.mts");
    const result = spawnSync(process.execPath, ["scripts/bench-dust.mts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("DustScene micro-benchmark");
  }, 35_000);

  it("explains how to supply a browser when the optional smoke cannot start", () => {
    const result = spawnSync(process.execPath, ["scripts/browser-smoke.mjs"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, CHROME_BIN: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set CHROME_BIN");
  });
});
