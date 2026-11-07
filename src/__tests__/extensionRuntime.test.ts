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
    // Any 2.x release is acceptable; the exact number lives in the manifest.
    expect(manifest.version).toMatch(/^2\.\d+\.\d+$/);
    // Minimal permission surface: no "tabs", no "activeTab", no "<all_urls>".
    expect(manifest.permissions).toEqual(["storage", "offscreen"]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.permissions).not.toContain("scripting");

    // Host access is scoped to the five supported meeting origins only.
    expect(Array.isArray(manifest.host_permissions)).toBe(true);
    expect(manifest.host_permissions.length).toBe(5);
    for (const pattern of manifest.host_permissions) {
      expect(pattern).toMatch(/^https:\/\//);
      expect(pattern).not.toContain("<all_urls>");
    }

    // Web-accessible resources must be explicitly enumerated (no "vendor/*"
    // wildcards exposing the whole extension bundle) and only to meeting origins.
    const war = manifest.web_accessible_resources.flatMap(
      (entry: { resources: string[] }) => entry.resources,
    );
    expect(war.length).toBeGreaterThan(0);
    for (const resource of war) {
      expect(resource.startsWith("*")).toBe(false);
      expect(resource.endsWith("/*")).toBe(false);
    }

    // MV3 CSP: inline scripts stay blocked while WebAssembly is allowed.
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");

    // Offscreen document declared by the worker must exist and be CSP-clean.
    const offscreenPath = path.resolve(
      process.cwd(),
      "extension/offscreen/offscreen.html",
    );
    expect(fs.existsSync(offscreenPath)).toBe(true);
    const offscreenHtml = fs.readFileSync(offscreenPath, "utf8");
    expect(offscreenHtml).not.toMatch(/<script(?![^>]*src=)/i);
    expect(
      fs.existsSync(path.resolve(process.cwd(), "extension/offscreen/offscreen.js")),
    ).toBe(true);

    // Verify service worker exists
    const swPath = path.resolve(
      process.cwd(),
      "extension",
      manifest.background.service_worker,
    );
    expect(fs.existsSync(swPath)).toBe(true);

    // MV3 lifecycle: the worker must not cache state in module-scope `let`/`var`
    // that it later trusts after a suspension. `offscreenCreating` is the single
    // whitelisted single-flight guard.
    const swSource = fs.readFileSync(swPath, "utf8");
    const mutableModuleBindings = [
      ...swSource.matchAll(/^(?:let|var)\s+([A-Za-z_$][\w$]*)/gm),
    ].map((m) => m[1]);
    const whitelisted = new Set(["offscreenCreating", "lastWrittenState"]);
    const illegal = mutableModuleBindings.filter((n) => !whitelisted.has(n));
    expect(illegal).toEqual([]);
    expect(swSource).toContain("chrome.storage.session");
    expect(swSource).toContain("chrome.runtime.getContexts");

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

    // With no verified local camera, fail closed rather than pretending a
    // remote/no-video fixture was successfully sent to the meeting.
    const vanishRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!({ type: "SNAP_VANISH_NOW" }, {}, resolve);
    });
    expect(vanishRes.ok).toBe(false);
    expect(vanishRes.reason).toBe("no-verified-camera-preview");
    expect(vanishRes.engineState).toBe("live");

    // A missing bridge is reported, although local UI state is reset.
    const restoreRes = await new Promise<Record<string, unknown>>((resolve) => {
      registeredListener!({ type: "EMERGENCY_RESTORE" }, {}, resolve);
    });
    expect(restoreRes.ok).toBe(false);
    expect(restoreRes.reason).toBe("timeout");
    expect(restoreRes.engineState).toBe("live");
    expect(restoreRes.muted).toBeNull(); // no recognizable meeting mic control

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
