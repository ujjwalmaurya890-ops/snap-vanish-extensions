import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  resolveDetectionPolicy,
  validateSettings,
} from "../lib/settings";

describe("Detection trigger modes (Smart / Gesture / Manual)", () => {
  it("defaults to Smart mode with audio confirmation and mic allowed", () => {
    const policy = resolveDetectionPolicy(DEFAULT_SETTINGS);
    expect(policy.mode).toBe("smart");
    expect(policy.detectionActive).toBe(true);
    expect(policy.requiresAudioConfirm).toBe(true);
    expect(policy.microphoneAllowed).toBe(true);
  });

  it("Gesture mode never allows the microphone and skips audio confirmation", () => {
    const policy = resolveDetectionPolicy({
      ...DEFAULT_SETTINGS,
      gesture: { ...DEFAULT_SETTINGS.gesture, detectionMode: "gesture-only" },
    });
    expect(policy.detectionActive).toBe(true);
    expect(policy.requiresAudioConfirm).toBe(false);
    expect(policy.microphoneAllowed).toBe(false);
  });

  it("Manual mode disables automatic detection entirely", () => {
    const policy = resolveDetectionPolicy({
      ...DEFAULT_SETTINGS,
      gesture: { ...DEFAULT_SETTINGS.gesture, detectionMode: "manual" },
    });
    expect(policy.detectionActive).toBe(false);
    expect(policy.microphoneAllowed).toBe(false);
  });

  it("detection never runs when the extension or gesture engine is disabled", () => {
    expect(
      resolveDetectionPolicy({ ...DEFAULT_SETTINGS, enabled: false })
        .detectionActive,
    ).toBe(false);
    expect(
      resolveDetectionPolicy({
        ...DEFAULT_SETTINGS,
        gesture: { ...DEFAULT_SETTINGS.gesture, enabled: false },
      }).microphoneAllowed,
    ).toBe(false);
  });

  it("Smart mode respects requireAudioConfirm=false (no mic, no gate)", () => {
    const policy = resolveDetectionPolicy({
      ...DEFAULT_SETTINGS,
      gesture: {
        ...DEFAULT_SETTINGS.gesture,
        detectionMode: "smart",
        requireAudioConfirm: false,
      },
    });
    expect(policy.requiresAudioConfirm).toBe(false);
    expect(policy.microphoneAllowed).toBe(false);
  });

  it("legacy payloads without detectionMode resolve to Smart", () => {
    const policy = resolveDetectionPolicy({
      enabled: true,
      gesture: { enabled: true, requireAudioConfirm: true },
      audio: { enabled: true },
    });
    expect(policy.mode).toBe("smart");
  });

  it("validateSettings accepts every trigger mode and rejects unknown ones", () => {
    for (const mode of ["smart", "gesture-only", "manual"] as const) {
      const res = validateSettings({
        ...DEFAULT_SETTINGS,
        gesture: { ...DEFAULT_SETTINGS.gesture, detectionMode: mode },
      });
      expect(res.sanitized.gesture.detectionMode).toBe(mode);
      expect(
        res.issues.filter((i) => i.field === "gesture.detectionMode"),
      ).toHaveLength(0);
    }

    const bad = validateSettings({
      ...DEFAULT_SETTINGS,
      gesture: { ...DEFAULT_SETTINGS.gesture, detectionMode: "telepathic" },
    });
    expect(bad.sanitized.gesture.detectionMode).toBe("smart");
    expect(
      bad.issues.some((i) => i.field === "gesture.detectionMode"),
    ).toBe(true);
  });

  it("DEFAULT_SETTINGS still validates with zero issues", () => {
    const res = validateSettings(DEFAULT_SETTINGS);
    expect(res.issues).toHaveLength(0);
    expect(res.sanitized.gesture.detectionMode).toBe("smart");
  });
});
