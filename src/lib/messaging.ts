import type {
  ExtensionMessage,
  ExtensionMessageType,
  ExtensionResponse,
} from "../types/snapVanish";

export const VALID_MESSAGE_TYPES: readonly ExtensionMessageType[] = [
  "PING",
  "GET_STATE",
  "SNAP_NOW",
  "SNAP_TOGGLE",
  "SNAP_VANISH_NOW",
  "EMERGENCY_RESTORE",
  "MUTE_TOGGLE",
  "RESET_FRAME",
  "SETTINGS_CHANGED",
  "SETTINGS",
  "STATE",
  "CALIBRATE_GESTURE",
  "RUN_DIAGNOSTICS",
  "CLEAR_LOCAL_DATA",
  "SYNC_DASHBOARD_STATE",
] as const;

export interface MessageValidationResult {
  valid: boolean;
  error?: string;
  message?: ExtensionMessage;
}

/**
 * Runtime validator for messages received across extension contexts
 * (Popup <-> Service Worker <-> Content Script <-> Dashboard Bridge).
 */
export function validateExtensionMessage(raw: unknown): MessageValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      error: "Message must be a non-null plain object",
    };
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.type !== "string") {
    return {
      valid: false,
      error: "Message is missing a string 'type' field",
    };
  }

  if (!VALID_MESSAGE_TYPES.includes(candidate.type as ExtensionMessageType)) {
    return {
      valid: false,
      error: `Unsupported message type '${candidate.type}'`,
    };
  }

  if (
    candidate.payload !== undefined &&
    (typeof candidate.payload !== "object" ||
      candidate.payload === null ||
      Array.isArray(candidate.payload))
  ) {
    return {
      valid: false,
      error: "Message 'payload' must be a plain object when provided",
    };
  }

  if (
    candidate.requestId !== undefined &&
    typeof candidate.requestId !== "string"
  ) {
    return {
      valid: false,
      error: "Message 'requestId' must be a string when provided",
    };
  }

  return {
    valid: true,
    message: {
      type: candidate.type as ExtensionMessageType,
      payload: candidate.payload as Record<string, unknown> | undefined,
      requestId: candidate.requestId as string | undefined,
    },
  };
}

interface ChromeRuntimeLike {
  id?: string;
  lastError?: { message?: string };
  sendMessage?: (
    message: ExtensionMessage,
    callback?: (response: ExtensionResponse) => void,
  ) => void;
}

function getChromeRuntime(): ChromeRuntimeLike | null {
  const g = globalThis as unknown as {
    chrome?: { runtime?: ChromeRuntimeLike };
  };
  if (g.chrome?.runtime && typeof g.chrome.runtime.sendMessage === "function") {
    return g.chrome.runtime;
  }
  return null;
}

/**
 * Checks whether the current context has an active Chrome Extension runtime bridge.
 */
export function isExtensionRuntimeAvailable(): boolean {
  const rt = getChromeRuntime();
  return Boolean(rt && rt.id);
}

/**
 * Sends a validated message to the Chrome extension service worker if available,
 * with automatic retry on service-worker wake-up and clean fallback response.
 */
export async function sendExtensionMessage(
  msg: ExtensionMessage,
  options: { retries?: number; timeoutMs?: number } = {},
): Promise<ExtensionResponse> {
  const validation = validateExtensionMessage(msg);
  if (!validation.valid || !validation.message) {
    return {
      ok: false,
      reason: "invalid-message",
      error: validation.error ?? "Invalid message payload",
    };
  }

  const runtime = getChromeRuntime();
  if (!runtime || !runtime.sendMessage) {
    return {
      ok: false,
      reason: "extension-context-unavailable",
      interceptionMode: "preview-only",
    };
  }

  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? 1500;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await new Promise<ExtensionResponse>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({
            ok: false,
            reason: "message-timeout",
          });
        }
      }, timeoutMs);

      try {
        runtime.sendMessage!(validation.message!, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (runtime.lastError) {
            resolve({
              ok: false,
              reason: "service-worker-unreachable",
              error: runtime.lastError.message,
            });
            return;
          }
          resolve(
            response ?? {
              ok: false,
              reason: "empty-response",
            },
          );
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            reason: "send-exception",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    if (result.ok || result.reason !== "service-worker-unreachable") {
      return result;
    }
  }

  return {
    ok: false,
    reason: "service-worker-restart-failed",
  };
}
