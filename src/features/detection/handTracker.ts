import { HandLandmarker, ImageSegmenter } from "@mediapipe/tasks-vision";
import type { HandLandmark } from "../../lib/gestureEngine";
import { resolveBundledAssetUrl } from "../../lib/messaging";

export interface HandInferenceFrameResult {
  handDetected: boolean;
  landmarks: HandLandmark[] | null;
  worldLandmarks: HandLandmark[] | null;
  handedness: "Left" | "Right" | null;
  confidence: number;
  inferenceMs: number;
}

export type ModelLoadProgressCallback = (
  progress: number,
  stage: string,
) => void;

const HAND_CONNECTIONS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

async function ensureMediaPipeWasmFactory(): Promise<{
  wasmLoaderPath: string;
  wasmBinaryPath: string;
}> {
  const moduleJsUrl = resolveBundledAssetUrl(
    "wasm/vision_wasm_module_internal.js",
  );
  const wasmBinUrl = resolveBundledAssetUrl(
    "wasm/vision_wasm_module_internal.wasm",
  );

  // Import the modularized Emscripten factory directly via ES dynamic import
  // so no <script> tag injection into document.body is needed (MV3 CSP safe).
  const mod = (await import(/* @vite-ignore */ moduleJsUrl)) as {
    default?: unknown;
  };
  const g = globalThis as Record<string, unknown>;
  if (mod?.default && !g.ModuleFactory) {
    g.ModuleFactory = mod.default;
  }

  return {
    wasmLoaderPath: "",
    wasmBinaryPath: wasmBinUrl,
  };
}

/**
 * Real MediaPipe Tasks Vision 21-point HandLandmarker & Selfie ImageSegmenter service.
 * Loads 100% local WASM and model assets with progress reporting and clean disposal.
 */
export class HandLandmarkService {
  private landmarker: HandLandmarker | null = null;
  private segmenter: ImageSegmenter | null = null;
  private status: "unloaded" | "loading" | "ready" | "error" = "unloaded";
  private loadProgress = 0;
  private lastError: string | null = null;
  private lastVideoTimestampMs = -1;

  get currentStatus() {
    return this.status;
  }

  get progress() {
    return this.loadProgress;
  }

  get error() {
    return this.lastError;
  }

  async initialize(options: {
    minConfidence?: number;
    enableSegmentation?: boolean;
    onProgress?: ModelLoadProgressCallback;
  } = {}): Promise<{ ok: boolean; error?: string }> {
    if (this.status === "ready" && this.landmarker) {
      options.onProgress?.(100, "Model ready");
      return { ok: true };
    }
    if (this.status === "loading") {
      return { ok: false, error: "Model initialization already in progress" };
    }

    this.status = "loading";
    this.lastError = null;
    this.loadProgress = 10;
    options.onProgress?.(10, "Loading local WebAssembly vision runtime…");

    try {
      const wasmFileset = await ensureMediaPipeWasmFactory();
      this.loadProgress = 45;
      options.onProgress?.(45, "Loading local 21-point hand_landmarker.task…");

      const modelAssetPath = resolveBundledAssetUrl(
        "models/hand_landmarker.task",
      );
      const minConf = Math.max(0.3, Math.min(0.95, options.minConfidence ?? 0.6));

      try {
        this.landmarker = await HandLandmarker.createFromOptions(wasmFileset, {
          baseOptions: {
            modelAssetPath,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: minConf,
          minHandPresenceConfidence: minConf,
          minTrackingConfidence: Math.max(0.3, minConf - 0.08),
        });
      } catch {
        // Fallback to CPU delegate if WebGL2/GPU delegate is unavailable on device
        await ensureMediaPipeWasmFactory();
        this.landmarker = await HandLandmarker.createFromOptions(wasmFileset, {
          baseOptions: {
            modelAssetPath,
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: minConf,
          minHandPresenceConfidence: minConf,
          minTrackingConfidence: Math.max(0.3, minConf - 0.08),
        });
      }

      if (options.enableSegmentation) {
        this.loadProgress = 80;
        options.onProgress?.(80, "Loading local selfie_segmentation.tflite…");
        try {
          await ensureMediaPipeWasmFactory();
          this.segmenter = await ImageSegmenter.createFromOptions(wasmFileset, {
            baseOptions: {
              modelAssetPath: resolveBundledAssetUrl(
                "models/selfie_segmentation.tflite",
              ),
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
          });
        } catch {
          // Segmentation remains optional; temporal/chroma background separation acts as fallback
          this.segmenter = null;
        }
      }

      this.loadProgress = 100;
      this.status = "ready";
      options.onProgress?.(100, "MediaPipe HandLandmarker ready");
      return { ok: true };
    } catch (err) {
      this.status = "error";
      this.lastError =
        err instanceof Error
          ? err.message
          : "Failed to initialize MediaPipe HandLandmarker";
      options.onProgress?.(0, this.lastError);
      return { ok: false, error: this.lastError };
    }
  }

  /**
   * Runs real 21-point hand landmark inference on a live video or canvas frame.
   */
  detectVideoFrame(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampMs = performance.now(),
  ): HandInferenceFrameResult {
    if (!this.landmarker || this.status !== "ready") {
      return {
        handDetected: false,
        landmarks: null,
        worldLandmarks: null,
        handedness: null,
        confidence: 0,
        inferenceMs: 0,
      };
    }

    // MediaPipe VIDEO mode requires strictly monotonically increasing timestamps
    const monoTs =
      timestampMs <= this.lastVideoTimestampMs
        ? this.lastVideoTimestampMs + 1
        : Math.floor(timestampMs);
    this.lastVideoTimestampMs = monoTs;

    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(source, monoTs);
    const inferenceMs = Number((performance.now() - t0).toFixed(2));

    if (!res.landmarks || res.landmarks.length === 0 || !res.landmarks[0]) {
      return {
        handDetected: false,
        landmarks: null,
        worldLandmarks: null,
        handedness: null,
        confidence: 0,
        inferenceMs,
      };
    }

    const category = res.handednesses?.[0]?.[0];
    const confidence =
      typeof category?.score === "number" ? Number(category.score.toFixed(3)) : 0.85;
    const rawHandedness = category?.categoryName;
    const handedness: "Left" | "Right" | null =
      rawHandedness === "Left" || rawHandedness === "Right"
        ? rawHandedness
        : null;

    return {
      handDetected: true,
      landmarks: res.landmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z })),
      worldLandmarks: res.worldLandmarks?.[0]
        ? res.worldLandmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z }))
        : null,
      handedness,
      confidence,
      inferenceMs,
    };
  }

  /**
   * Runs optional MediaPipe selfie segmentation on a video frame.
   */
  segmentVideoFrame(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampMs = performance.now(),
  ): Float32Array | null {
    if (!this.segmenter) return null;
    try {
      const monoTs = Math.floor(timestampMs) + 1;
      const res = this.segmenter.segmentForVideo(source, monoTs);
      const mask = res.confidenceMasks?.[0];
      if (!mask) return null;
      const copy = new Float32Array(mask.getAsFloat32Array());
      mask.close();
      return copy;
    } catch {
      return null;
    }
  }

  dispose() {
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        // Ignore WASM teardown error
      }
      this.landmarker = null;
    }
    if (this.segmenter) {
      try {
        this.segmenter.close();
      } catch {
        // Ignore
      }
      this.segmenter = null;
    }
    this.status = "unloaded";
    this.loadProgress = 0;
    this.lastVideoTimestampMs = -1;
  }
}

/**
 * Renders a crisp 21-point hand skeleton overlay onto a 2D canvas context.
 */
export function drawHandLandmarksOverlay(
  ctx: CanvasRenderingContext2D,
  landmarks: HandLandmark[],
  width: number,
  height: number,
  options: {
    mirrored?: boolean;
    accentColor?: string;
    isCandidate?: boolean;
  } = {},
) {
  if (!landmarks || landmarks.length < 21) return;
  const mirrored = Boolean(options.mirrored);
  const stroke = options.isCandidate
    ? "#34d399"
    : options.accentColor || "#f0623a";

  const projectX = (nx: number) => (mirrored ? (1 - nx) * width : nx * width);
  const projectY = (ny: number) => ny * height;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  ctx.globalAlpha = 0.88;

  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(projectX(pa.x), projectY(pa.y));
    ctx.lineTo(projectX(pb.x), projectY(pb.y));
    ctx.stroke();
  }

  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    const isSnapPair = i === 4 || i === 12;
    ctx.beginPath();
    ctx.fillStyle = isSnapPair ? "#fbbf24" : "#ffffff";
    ctx.arc(projectX(p.x), projectY(p.y), isSnapPair ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
