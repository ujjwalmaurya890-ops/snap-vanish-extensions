import type {
  ChangelogEntry,
  DiagnosticSnapshot,
  FeedbackSubmission,
} from "../types/snapVanish";
import { STORAGE_KEYS } from "./settings";

export const CURRENT_EXTENSION_VERSION = "2.0.0";

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    version: "2.0.0",
    date: "2026-10-25",
    title: "Production SaaS Upgrade: Multi-Effect Studio, Gesture Calibration & Companion Dashboard",
    type: "major",
    highlights: [
      "Fixed content script crashes caused by unimplemented WASM stubs (segmentSelfie, estimateHands, median3, buildDustScene) and added missing content/snap-vanish.css.",
      "Fixed unhandled SNAP_VANISH_NOW command in content script and corrected acoustic transient onset detection logic.",
      "Added 5 reversible visual effects: Dust Particles, Pixel Dissolve, Digital Glitch, Studio Fade-Out, and Solar Light-Burst.",
      "Built Custom Effect Studio with live preview, particle size/density/speed/color/intensity sliders, and preset CRUD (Save, Rename, Duplicate, Delete, Reset).",
      "Added Gesture Studio with interactive calibration, cooldown protection, accidental-trigger rejection, and manual fallback controls.",
      "Added Smart Meeting Modes (Professional, Creative, Minimal, Low-Power) and First-Run Onboarding wizard.",
      "Added Privacy Center, Local Usage Analytics, Diagnostics & Performance Monitor, and synchronized SaaS Web Dashboard.",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-09-12",
    title: "Baseline Snap Vanish Showcase & MV3 Prototype",
    type: "minor",
    highlights: [
      "Initial 22,000-particle curl-noise dust scene and photographic landing page.",
      "Chrome Manifest V3 service worker, keyboard shortcuts (Alt+Shift+S/D/M/R), and 360px popup.",
    ],
  },
];

export function loadFeedbackSubmissions(): FeedbackSubmission[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEYS.FEEDBACK);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function submitFeedback(params: {
  category: FeedbackSubmission["category"];
  title: string;
  description: string;
  includeDiagnostics: boolean;
  diagnosticSnapshot?: Partial<DiagnosticSnapshot>;
}): { ok: boolean; error?: string; submission?: FeedbackSubmission; all: FeedbackSubmission[] } {
  const title = params.title.trim();
  const description = params.description.trim();

  if (title.length < 3) {
    return {
      ok: false,
      error: "Title must be at least 3 characters long.",
      all: loadFeedbackSubmissions(),
    };
  }
  if (description.length < 10) {
    return {
      ok: false,
      error: "Please provide at least 10 characters of description.",
      all: loadFeedbackSubmissions(),
    };
  }

  const submission: FeedbackSubmission = {
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    category: params.category,
    title,
    description,
    includeDiagnostics: Boolean(params.includeDiagnostics),
    // Strictly attach diagnostic snapshot ONLY when user explicitly consented
    diagnosticSnapshot: params.includeDiagnostics
      ? params.diagnosticSnapshot
      : undefined,
    createdAt: new Date().toISOString(),
    status: "recorded-locally",
  };

  const current = loadFeedbackSubmissions();
  const updated = [submission, ...current];
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.FEEDBACK, JSON.stringify(updated));
    }
  } catch {
    // Ignore quota errors
  }

  return {
    ok: true,
    submission,
    all: updated,
  };
}

export function deleteFeedbackSubmission(id: string): FeedbackSubmission[] {
  const current = loadFeedbackSubmissions().filter((item) => item.id !== id);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.FEEDBACK, JSON.stringify(current));
    }
  } catch {
    // Ignore
  }
  return current;
}

export function clearAllFeedback(): FeedbackSubmission[] {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.FEEDBACK);
    }
  } catch {
    // Ignore
  }
  return [];
}
