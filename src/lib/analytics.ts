import type {
  AnalyticsEvent,
  AnalyticsEventType,
  EffectType,
  MeetingModeId,
  UsageAnalyticsSummary,
} from "../types/snapVanish";
import { STORAGE_KEYS, broadcastSyncEvent } from "./settings";

const MAX_STORED_EVENTS = 200;

export function createEmptyAnalytics(): UsageAnalyticsSummary {
  return {
    totalActivations: 0,
    successfulRestorations: 0,
    emergencyRestorations: 0,
    failedTriggers: 0,
    cooldownBlocks: 0,
    effectCounts: {
      dust: 0,
      "pixel-dissolve": 0,
      "digital-glitch": 0,
      "fade-out": 0,
      "light-burst": 0,
    },
    presetCounts: {},
    dailyActivations: {},
    events: [],
    lastUpdated: new Date().toISOString(),
  };
}

export function loadAnalytics(): UsageAnalyticsSummary {
  try {
    if (typeof localStorage === "undefined") {
      return createEmptyAnalytics();
    }
    const raw = localStorage.getItem(STORAGE_KEYS.ANALYTICS);
    if (!raw) return createEmptyAnalytics();
    const parsed = JSON.parse(raw) as Partial<UsageAnalyticsSummary>;
    const empty = createEmptyAnalytics();
    return {
      totalActivations:
        typeof parsed.totalActivations === "number"
          ? parsed.totalActivations
          : 0,
      successfulRestorations:
        typeof parsed.successfulRestorations === "number"
          ? parsed.successfulRestorations
          : 0,
      emergencyRestorations:
        typeof parsed.emergencyRestorations === "number"
          ? parsed.emergencyRestorations
          : 0,
      failedTriggers:
        typeof parsed.failedTriggers === "number" ? parsed.failedTriggers : 0,
      cooldownBlocks:
        typeof parsed.cooldownBlocks === "number" ? parsed.cooldownBlocks : 0,
      effectCounts: {
        ...empty.effectCounts,
        ...(parsed.effectCounts ?? {}),
      },
      presetCounts: { ...(parsed.presetCounts ?? {}) },
      dailyActivations: { ...(parsed.dailyActivations ?? {}) },
      events: Array.isArray(parsed.events)
        ? parsed.events.slice(0, MAX_STORED_EVENTS)
        : [],
      lastUpdated:
        typeof parsed.lastUpdated === "string"
          ? parsed.lastUpdated
          : empty.lastUpdated,
    };
  } catch {
    return createEmptyAnalytics();
  }
}

export function saveAnalytics(summary: UsageAnalyticsSummary): UsageAnalyticsSummary {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.ANALYTICS, JSON.stringify(summary));
    }
  } catch {
    // Ignore storage quota error
  }
  broadcastSyncEvent("ANALYTICS_UPDATED", summary);
  return summary;
}

export function recordAnalyticsEvent(params: {
  type: AnalyticsEventType;
  effect?: EffectType;
  presetId?: string;
  modeId?: MeetingModeId;
  source?: "manual" | "gesture" | "shortcut" | "popup" | "dashboard";
  reason?: string;
  timestamp?: string;
}): UsageAnalyticsSummary {
  const summary = loadAnalytics();
  const nowIso = params.timestamp ?? new Date().toISOString();
  const dayKey = nowIso.slice(0, 10);

  const event: AnalyticsEvent = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: params.type,
    timestamp: nowIso,
    effect: params.effect,
    presetId: params.presetId,
    modeId: params.modeId,
    source: params.source,
    reason: params.reason,
  };

  switch (params.type) {
    case "vanish_activated":
      summary.totalActivations += 1;
      summary.dailyActivations[dayKey] =
        (summary.dailyActivations[dayKey] ?? 0) + 1;
      if (params.effect) {
        summary.effectCounts[params.effect] =
          (summary.effectCounts[params.effect] ?? 0) + 1;
      }
      break;
    case "restore_completed":
      summary.successfulRestorations += 1;
      break;
    case "emergency_restore":
      summary.emergencyRestorations += 1;
      summary.successfulRestorations += 1;
      break;
    case "trigger_failed":
      summary.failedTriggers += 1;
      break;
    case "trigger_blocked_cooldown":
      summary.cooldownBlocks += 1;
      break;
    case "preset_selected":
      if (params.presetId) {
        summary.presetCounts[params.presetId] =
          (summary.presetCounts[params.presetId] ?? 0) + 1;
      }
      break;
    default:
      break;
  }

  summary.events = [event, ...summary.events].slice(0, MAX_STORED_EVENTS);
  summary.lastUpdated = nowIso;
  return saveAnalytics(summary);
}

export function clearAnalyticsData(): UsageAnalyticsSummary {
  const empty = createEmptyAnalytics();
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.ANALYTICS);
    }
  } catch {
    // Ignore
  }
  broadcastSyncEvent("ANALYTICS_UPDATED", empty);
  return empty;
}

export interface WeeklyUsageDay {
  date: string;
  label: string;
  activations: number;
}

/**
 * Computes real 7-day activation counts from recorded local events.
 */
export function getWeeklyUsageSummary(
  summary: UsageAnalyticsSummary,
  referenceDate = new Date(),
): { days: WeeklyUsageDay[]; totalWeekActivations: number; mostUsedEffect: EffectType | null } {
  const days: WeeklyUsageDay[] = [];
  let totalWeekActivations = 0;

  for (let i = 6; i >= 0; i--) {
    const d = new Date(referenceDate);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
    const count = summary.dailyActivations[key] ?? 0;
    totalWeekActivations += count;
    days.push({ date: key, label, activations: count });
  }

  let mostUsedEffect: EffectType | null = null;
  let maxCount = 0;
  for (const [effect, count] of Object.entries(summary.effectCounts) as [
    EffectType,
    number,
  ][]) {
    if (count > maxCount) {
      maxCount = count;
      mostUsedEffect = effect;
    }
  }

  return { days, totalWeekActivations, mostUsedEffect };
}
