import type {
  EffectPreset,
  EntitlementState,
  PlanTier,
} from "../types/snapVanish";
import { STORAGE_KEYS, VALID_EFFECTS } from "./settings";

export interface CloudAuthUser {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: number;
  accessToken: string;
}

export interface CloudSyncStatus {
  configured: boolean;
  statusLabel: "VERIFIED" | "IMPLEMENTED, NOT VERIFIED" | "BLOCKED";
  reason: string;
  lastSyncedAt: string | null;
}

function getEnvVar(key: string): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return env?.[key]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function getCloudConfig() {
  const supabaseUrl = getEnvVar("VITE_SUPABASE_URL");
  const supabaseAnonKey = getEnvVar("VITE_SUPABASE_ANON_KEY");
  const billingCheckoutUrl = getEnvVar("VITE_BILLING_CHECKOUT_URL");
  const billingPortalUrl = getEnvVar("VITE_BILLING_PORTAL_URL");

  const cloudConfigured = Boolean(
    supabaseUrl &&
      supabaseAnonKey &&
      supabaseUrl.startsWith("https://"),
  );
  const billingConfigured = Boolean(
    billingCheckoutUrl && billingCheckoutUrl.startsWith("https://"),
  );

  return {
    supabaseUrl,
    supabaseAnonKey,
    billingCheckoutUrl,
    billingPortalUrl,
    cloudConfigured,
    billingConfigured,
  };
}

export function getCloudSyncStatus(): CloudSyncStatus {
  const { cloudConfigured } = getCloudConfig();
  if (!cloudConfigured) {
    return {
      configured: false,
      statusLabel: "BLOCKED",
      reason:
        "Supabase credentials (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are not configured in the environment. Local storage remains 100% functional.",
      lastSyncedAt: null,
    };
  }
  return {
    configured: true,
    statusLabel: "IMPLEMENTED, NOT VERIFIED",
    reason:
      "Supabase REST client configured. Requires live Supabase project with RLS tables to verify end-to-end cloud sync.",
    lastSyncedAt: null,
  };
}

export function loadAuthSession(): CloudAuthUser | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEYS.AUTH_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudAuthUser;
    if (!parsed.id || !parsed.email || !parsed.accessToken || !parsed.expiresAt) {
      return null;
    }
    if (Date.now() >= parsed.expiresAt) {
      localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearAuthSession() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
    }
  } catch {
    // Ignore
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function authenticateWithCloud(params: {
  mode: "signin" | "signup";
  email: string;
  password: string;
}): Promise<{
  ok: boolean;
  status: "BLOCKED" | "FAILED" | "AUTHENTICATED";
  message: string;
  user?: CloudAuthUser;
}> {
  const email = params.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return {
      ok: false,
      status: "FAILED",
      message: "Please provide a valid email address.",
    };
  }
  if (!params.password || params.password.length < 8) {
    return {
      ok: false,
      status: "FAILED",
      message: "Password must be at least 8 characters long.",
    };
  }

  const config = getCloudConfig();
  if (!config.cloudConfigured) {
    return {
      ok: false,
      status: "BLOCKED",
      message:
        "Cloud authentication is BLOCKED because VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set. Configure .env to enable Supabase Auth.",
    };
  }

  const endpoint =
    params.mode === "signup"
      ? `${config.supabaseUrl}/auth/v1/signup`
      : `${config.supabaseUrl}/auth/v1/token?grant_type=password`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ email, password: params.password }),
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        error_description?: string;
        msg?: string;
      };
      return {
        ok: false,
        status: "FAILED",
        message:
          errBody.error_description ||
          errBody.msg ||
          `Authentication failed (HTTP ${res.status})`,
      };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      user?: { id?: string; email?: string; created_at?: string };
    };

    if (!data.access_token || !data.user?.id) {
      return {
        ok: false,
        status: "FAILED",
        message:
          "Check your email inbox to confirm your account before signing in.",
      };
    }

    const user: CloudAuthUser = {
      id: data.user.id,
      email: data.user.email ?? email,
      createdAt: data.user.created_at ?? new Date().toISOString(),
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      accessToken: data.access_token,
    };

    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEYS.AUTH_SESSION, JSON.stringify(user));
    }

    return {
      ok: true,
      status: "AUTHENTICATED",
      message: "Authenticated with Supabase.",
      user,
    };
  } catch (err) {
    return {
      ok: false,
      status: "FAILED",
      message:
        err instanceof Error
          ? `Network error contacting auth server: ${err.message}`
          : "Network error contacting auth server.",
    };
  }
}

/**
 * Resolves conflicts between local and remote presets deterministically by comparing
 * ISO updatedAt timestamps (newest wins), preserving all unique preset IDs.
 */
export function resolvePresetSyncConflicts(
  localPresets: EffectPreset[],
  remotePresets: EffectPreset[],
): {
  merged: EffectPreset[];
  conflictsResolved: number;
} {
  const byId = new Map<string, EffectPreset>();
  let conflictsResolved = 0;

  for (const lp of localPresets) {
    byId.set(lp.id, structuredClone(lp));
  }

  for (const rp of remotePresets) {
    const existing = byId.get(rp.id);
    if (!existing) {
      byId.set(rp.id, structuredClone(rp));
    } else {
      const localTime = Date.parse(existing.updatedAt) || 0;
      const remoteTime = Date.parse(rp.updatedAt) || 0;
      if (remoteTime > localTime) {
        byId.set(rp.id, structuredClone(rp));
        conflictsResolved += 1;
      } else if (localTime > remoteTime) {
        conflictsResolved += 1;
      }
    }
  }

  return {
    merged: Array.from(byId.values()),
    conflictsResolved,
  };
}

/**
 * Evaluates feature entitlements honestly.
 * Never trusts a client-side boolean as payment proof for server-controlled features.
 */
export function getEntitlementState(
  session: CloudAuthUser | null = loadAuthSession(),
): EntitlementState {
  const { cloudConfigured, billingConfigured } = getCloudConfig();
  const tier: PlanTier = "free";

  return {
    tier,
    verificationSource:
      cloudConfigured && session ? "server-verified" : "unconfigured",
    cloudSyncConfigured: cloudConfigured,
    billingConfigured,
    entitlements: {
      coreVanishRestore: true,
      essentialEffects: ["dust", "fade-out", "pixel-dissolve"],
      // All 5 visual effects remain usable locally in the studio so we never cripple the local extension
      allEffects: [...VALID_EFFECTS],
      maxLocalPresets: 25,
      cloudPresetSync: Boolean(cloudConfigured && session),
      advancedAnalyticsExport: true,
    },
  };
}
