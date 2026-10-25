// @vitest-environment jsdom
import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

describe("7. Chrome Extension Manifest, Service Worker & Content Script Verification", () => {
  it("validates extension/manifest.json structure and verifies all referenced files exist", () => {
    const manifestPath = path.resolve(process.cwd(), "extension/manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.permissions).toEqual(["activeTab", "storage"]);
    expect(manifest.permissions).not.toContain("offscreen");

    // Verify service worker exists
    const swPath = path.resolve(
      process.cwd(),
      "extension",
      manifest.background.service_worker,
    );
    expect(fs.existsSync(swPath)).toBe(true);

    // Verify popup exists
    const popupPath = path.resolve(
      process.cwd(),
      "extension",
      manifest.action.default_popup,
    );
    expect(fs.existsSync(popupPath)).toBe(true);

    // Verify all content_scripts JS and CSS files exist
    for (const cs of manifest.content_scripts) {
      for (const jsFile of cs.js ?? []) {
        expect(
          fs.existsSync(path.resolve(process.cwd(), "extension", jsFile)),
        ).toBe(true);
      }
      for (const cssFile of cs.css ?? []) {
        expect(
          fs.existsSync(path.resolve(process.cwd(), "extension", cssFile)),
        ).toBe(true);
      }
    }
  });

  it("loads extension/content/snap-vanish.js without throwing and handles all message types", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          save: vi.fn(),
          restore: vi.fn(),
          clearRect: vi.fn(),
          fillRect: vi.fn(),
          drawImage: vi.fn(),
          createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
          getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4).fill(180),
          })),
          fillStyle: "#000",
          globalAlpha: 1,
        }) as unknown as RenderingContext,
    );

    let registeredListener:
      | ((
          msg: { type: string; payload?: Record<string, unknown> },
          sender: unknown,
          respond: (res: Record<string, unknown>) => void,
        ) => boolean)
      | null = null;

    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        sync: {
          get: vi.fn(async () => ({
            enabled: true,
            sensitivity: 62,
            duration: 0.4,
            direction: "right",
            effect: "dust",
          })),
        },
      },
      runtime: {
        onMessage: {
          addListener: (fn: typeof registeredListener) => {
            registeredListener = fn;
          },
        },
      },
    };

    const contentScriptCode = fs.readFileSync(
      path.resolve(process.cwd(), "extension/content/snap-vanish.js"),
      "utf8",
    );

    // Execute content script in JSDOM window
    const fn = new Function(contentScriptCode);
    expect(() => fn()).not.toThrow();

    const ctrl = (window as unknown as { __snapVanish?: Record<string, unknown> })
      .__snapVanish;
    expect(ctrl).toBeDefined();
    expect(registeredListener).toBeTypeOf("function");

    // Verify STATE message
    const stateRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!({ type: "STATE" }, {}, resolve);
    });
    expect(stateRes.ok).toBe(true);
    expect(stateRes.engineState).toBe("live");

    // Verify SNAP_VANISH_NOW (previously unhandled in baseline!)
    const vanishRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!({ type: "SNAP_VANISH_NOW" }, {}, resolve);
    });
    expect(vanishRes.ok).toBe(true);
    expect(vanishRes.engineState).toBe("vanishing");

    // Verify EMERGENCY_RESTORE
    const restoreRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!({ type: "EMERGENCY_RESTORE" }, {}, resolve);
    });
    expect(restoreRes.ok).toBe(true);
    expect(restoreRes.engineState).toBe("live");
    expect(restoreRes.muted).toBe(false);

    // Verify SETTINGS update
    const settingsRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!(
        { type: "SETTINGS", payload: { effect: "digital-glitch", sensitivity: 80 } },
        {},
        resolve,
      );
    });
    expect(settingsRes.ok).toBe(true);

    // Verify RUN_DIAGNOSTICS
    const diagRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!({ type: "RUN_DIAGNOSTICS" }, {}, resolve);
    });
    expect(diagRes.ok).toBe(true);

    delete (globalThis as Record<string, unknown>).chrome;
  });
});
