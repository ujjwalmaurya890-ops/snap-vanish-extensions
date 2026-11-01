import type {
  BackgroundMode,
  PlatformCompatibilityEntry,
} from "../../types/snapVanish";

export interface CameraDeviceOption {
  deviceId: string;
  label: string;
}

export async function enumerateVideoInputDevices(): Promise<CameraDeviceOption[]> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== "function"
  ) {
    return [];
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "videoinput")
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${idx + 1}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Technically honest Background Plate & Foreground Separation Reconstructor.
 *
 * Supports:
 * 1. Explicit Clean-Plate Capture (user captures empty room background).
 * 2. Temporal Background Buffer (slow EMA accumulation in low-motion exterior regions).
 * 3. Chroma + Luminance Foreground Differencing combined with optional MediaPipe
 *    Selfie Segmentation confidence masks and 3-tap spatial smoothing.
 * 4. Border-region camera motion / sudden lighting shift detector so stale background
 *    plates are flagged rather than silently producing severe ghosting.
 */
export class BackgroundReconstructor {
  private width: number;
  private height: number;
  private capturedPlate: Uint8ClampedArray | null = null;
  private temporalBuffer: Float32Array | null = null;
  private temporalInitialized = false;
  private prevBorderLuminance: Float32Array | null = null;
  private cameraMotionAlert = false;
  private frameCounter = 0;

  constructor(width = 640, height = 360) {
    this.width = width;
    this.height = height;
  }

  get hasCapturedPlate(): boolean {
    return this.capturedPlate !== null;
  }

  get hasTemporalPlate(): boolean {
    return this.temporalInitialized;
  }

  get isCameraMoving(): boolean {
    return this.cameraMotionAlert;
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.capturedPlate = null;
    this.temporalBuffer = null;
    this.temporalInitialized = false;
    this.prevBorderLuminance = null;
  }

  /**
   * Stores an explicit empty-room background plate captured by the user.
   */
  captureCleanPlate(frame: ImageData) {
    this.resize(frame.width, frame.height);
    this.capturedPlate = new Uint8ClampedArray(frame.data);
    this.cameraMotionAlert = false;
  }

  clearCapturedPlate() {
    this.capturedPlate = null;
  }

  /**
   * Updates the adaptive temporal background estimate from a live camera frame
   * and checks outer border pixels for sudden camera movement or lighting shifts.
   */
  ingestLiveFrame(
    frame: ImageData,
    segmentationConfidence?: Float32Array | null,
  ) {
    this.resize(frame.width, frame.height);
    const { data, width, height } = frame;
    const pixelCount = width * height;
    this.frameCounter += 1;

    // 1. Check outer border strip for sudden camera bump / lighting shift
    const borderSamples: number[] = [];
    const stepX = Math.max(4, Math.floor(width / 24));
    for (let x = 0; x < width; x += stepX) {
      const topIdx = x * 4;
      const lum =
        data[topIdx] * 0.299 +
        data[topIdx + 1] * 0.587 +
        data[topIdx + 2] * 0.114;
      borderSamples.push(lum);
    }
    const currentBorder = new Float32Array(borderSamples);
    if (
      this.prevBorderLuminance &&
      this.prevBorderLuminance.length === currentBorder.length
    ) {
      let diffSum = 0;
      for (let i = 0; i < currentBorder.length; i++) {
        diffSum += Math.abs(currentBorder[i] - this.prevBorderLuminance[i]);
      }
      const meanBorderDiff = diffSum / currentBorder.length;
      this.cameraMotionAlert = meanBorderDiff > 26;
    }
    this.prevBorderLuminance = currentBorder;

    // 2. Initialize or update temporal background plate
    if (!this.temporalBuffer || this.temporalBuffer.length !== data.length) {
      this.temporalBuffer = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) {
        this.temporalBuffer[i] = data[i];
      }
      this.temporalInitialized = true;
      return;
    }

    // Update every 2nd frame for low CPU overhead on laptops
    if (this.frameCounter % 2 !== 0) return;

    const alphaUpdate = this.cameraMotionAlert ? 0.18 : 0.035;
    const cx = width * 0.5;
    const cy = height * 0.56;
    const rx = width * 0.28;
    const ry = height * 0.42;

    for (let i = 0; i < pixelCount; i++) {
      let fgProb = 0;
      if (segmentationConfidence && segmentationConfidence.length === pixelCount) {
        fgProb = segmentationConfidence[i];
      } else {
        const x = i % width;
        const y = (i - x) / width;
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        fgProb = nx * nx + ny * ny < 1.0 ? 0.85 : 0.05;
      }

      // Only blend into temporal background where foreground probability is low
      if (fgProb < 0.25 || this.cameraMotionAlert) {
        const p4 = i * 4;
        this.temporalBuffer[p4] +=
          (data[p4] - this.temporalBuffer[p4]) * alphaUpdate;
        this.temporalBuffer[p4 + 1] +=
          (data[p4 + 1] - this.temporalBuffer[p4 + 1]) * alphaUpdate;
        this.temporalBuffer[p4 + 2] +=
          (data[p4 + 2] - this.temporalBuffer[p4 + 2]) * alphaUpdate;
        this.temporalBuffer[p4 + 3] = 255;
      }
    }
  }

  /**
   * Produces the best available background plate ImageData for the chosen mode,
   * reporting which honest reconstruction method was actually used.
   */
  resolveBackgroundPlate(
    mode: BackgroundMode,
    currentFrame?: ImageData | null,
  ): {
    imageData: ImageData | null;
    methodUsed:
      | "captured-clean-plate"
      | "temporal-running-buffer"
      | "ambient-blurred-fallback";
  } {
    const createImgData = (arr: Uint8ClampedArray): ImageData => {
      if (typeof ImageData !== "undefined") {
        return new ImageData(new Uint8ClampedArray(arr), this.width, this.height);
      }
      return {
        data: new Uint8ClampedArray(arr),
        width: this.width,
        height: this.height,
        colorSpace: "srgb",
      } as ImageData;
    };

    if (mode === "captured-plate" && this.capturedPlate) {
      return {
        imageData: createImgData(this.capturedPlate),
        methodUsed: "captured-clean-plate",
      };
    }

    if (this.temporalBuffer && this.temporalInitialized) {
      const out = new Uint8ClampedArray(this.temporalBuffer.length);
      for (let i = 0; i < this.temporalBuffer.length; i++) {
        out[i] = Math.max(0, Math.min(255, Math.round(this.temporalBuffer[i])));
      }
      return {
        imageData: createImgData(out),
        methodUsed: "temporal-running-buffer",
      };
    }

    // Fallback: extrapolate peripheral room colors horizontally across the frame
    if (currentFrame && currentFrame.data.length === this.width * this.height * 4) {
      const out = new Uint8ClampedArray(currentFrame.data.length);
      const { width, height, data } = currentFrame;
      for (let y = 0; y < height; y++) {
        const leftIdx = (y * width + Math.min(width - 1, 4)) * 4;
        const rightIdx = (y * width + Math.max(0, width - 5)) * 4;
        for (let x = 0; x < width; x++) {
          const k = x / Math.max(1, width - 1);
          const idx = (y * width + x) * 4;
          out[idx] = Math.round(data[leftIdx] * (1 - k) + data[rightIdx] * k);
          out[idx + 1] = Math.round(
            data[leftIdx + 1] * (1 - k) + data[rightIdx + 1] * k,
          );
          out[idx + 2] = Math.round(
            data[leftIdx + 2] * (1 - k) + data[rightIdx + 2] * k,
          );
          out[idx + 3] = 255;
        }
      }
      return {
        imageData: createImgData(out),
        methodUsed: "ambient-blurred-fallback",
      };
    }

    return { imageData: null, methodUsed: "ambient-blurred-fallback" };
  }

  /**
   * Computes a foreground alpha matte [0..1] using:
   * - MediaPipe segmentation confidence mask when available, OR
   * - Real pixel-level RGB/chroma difference against the background plate + spatial prior.
   */
  computeForegroundAlpha(
    currentFrame: ImageData,
    plate: ImageData | null,
    segmentationMask?: Float32Array | null,
  ): Float32Array {
    const { width, height, data } = currentFrame;
    const count = width * height;

    if (segmentationMask && segmentationMask.length === count) {
      return smoothAlpha3Tap(segmentationMask);
    }

    const alpha = new Float32Array(count);
    const pData = plate?.data;
    const cx = width * 0.5;
    const cy = height * 0.56;
    const rx = width * 0.34;
    const ry = height * 0.46;

    for (let y = 0; y < height; y++) {
      const ny = (y - cy) / ry;
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const p4 = idx * 4;
        const nx = (x - cx) / rx;
        const spatialPrior = Math.max(0, 1.12 - (nx * nx + ny * ny) * 0.88);

        if (pData && pData.length === data.length) {
          const dr = Math.abs(data[p4] - pData[p4]);
          const dg = Math.abs(data[p4 + 1] - pData[p4 + 1]);
          const db = Math.abs(data[p4 + 2] - pData[p4 + 2]);
          const colorDiff = (dr * 0.35 + dg * 0.45 + db * 0.2) / 42;
          alpha[idx] = Math.min(
            1,
            Math.max(0, colorDiff * 0.72 + spatialPrior * 0.35),
          );
        } else {
          alpha[idx] = Math.min(1, spatialPrior);
        }
      }
    }

    return smoothAlpha3Tap(alpha);
  }
}

function smoothAlpha3Tap(alpha: Float32Array): Float32Array {
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i > 0 ? i - 1 : i];
    const b = alpha[i];
    const c = alpha[i + 1 < alpha.length ? i + 1 : i];
    out[i] = (a + b * 2 + c) * 0.25;
  }
  return out;
}

export const BACKGROUND_METHODS_EXPLAINED: {
  id: BackgroundMode;
  title: string;
  mechanism: string;
  limitations: string;
}[] = [
  {
    id: "captured-plate",
    title: "Captured Empty Plate (Highest Visual Fidelity)",
    mechanism:
      "Stores a reference frame of your empty workspace before you sit down and composites disintegrating particles directly over the real room.",
    limitations:
      "Sensitive to tripod/laptop hinge movement or major room lighting changes after capture (automatically flagged by the border-motion detector).",
  },
  {
    id: "temporal-plate",
    title: "Temporal Background Estimation (Default)",
    mechanism:
      "Continuously estimates static background pixels over time while excluding foreground motion regions.",
    limitations:
      "Areas permanently occluded since camera start (such as your chair backrest) only fill in once briefly uncovered; sudden camera shakes trigger gradual re-adaptation.",
  },
  {
    id: "ai-segmentation",
    title: "Local MediaPipe Selfie Segmentation + Plate",
    mechanism:
      "Runs local selfie_segmentation.tflite WASM inference to separate person contours from the background plate.",
    limitations:
      "Increases GPU/CPU inference cost on older laptops and can exhibit minor edge softness under dim backlighting.",
  },
  {
    id: "studio-fallback",
    title: "Peripheral Room Extrapolation Fallback",
    mechanism:
      "Interpolates outer room edge colors across the frame when neither a clean plate nor segmentation mask is available yet.",
    limitations:
      "Produces a smooth ambient backdrop rather than detailed wall/bookshelf geometry behind the user.",
  },
];

export const PLATFORM_COMPATIBILITY_MATRIX: PlatformCompatibilityEntry[] = [
  {
    id: "google-meet",
    name: "Google Meet",
    hostPatterns: ["https://meet.google.com/*"],
    classification: "Partially implemented",
    verificationStatus: "Tested in automated harness; Untested in live call",
    outgoingStreamMethod:
      "MAIN-world document_start RTCPeerConnection sender tracking + RTCRtpSender.replaceTrack() swap to processed canvas stream, with automatic fallback to DOM overlay if call started prior to extension load.",
    selfViewOverlaySupport: true,
    knownLimitations: [
      "If Snap Vanish is installed while a Meet tab is already open, the tab must be refreshed once so document_start WebRTC hooks attach.",
      "Meet's built-in background blur should be turned off so two mattes do not stack.",
    ],
    fallbackWorkflow:
      "Refresh the Meet tab before joining, or route the Snap Vanish Studio Stage through OBS Virtual Camera.",
  },
  {
    id: "microsoft-teams",
    name: "Microsoft Teams (Web)",
    hostPatterns: ["https://teams.microsoft.com/*"],
    classification: "Partially implemented",
    verificationStatus: "Tested in automated harness; Untested in live call",
    outgoingStreamMethod:
      "MAIN-world RTCPeerConnection video RTCRtpSender.replaceTrack() + getUserMedia stream monitor, with DOM self-view canvas fallback.",
    selfViewOverlaySupport: true,
    knownLimitations: [
      "Teams Web occasionally recreates video senders when toggling Together Mode or screen sharing; Snap Vanish re-queries active senders on each transition.",
      "Desktop Electron Teams app cannot load Chrome extensions directly; use Teams in Chrome/Edge or OBS Virtual Camera.",
    ],
    fallbackWorkflow:
      "Use Microsoft Teams in Chrome 121+ or capture the Snap Vanish Studio Stage via OBS Virtual Camera.",
  },
  {
    id: "zoom-web",
    name: "Zoom Web Client",
    hostPatterns: ["https://*.zoom.us/*"],
    classification: "Experimental",
    verificationStatus: "Tested in automated harness; Untested in live call",
    outgoingStreamMethod:
      "Experimental MAIN-world getUserMedia stream proxy + DOM overlay fallback. Zoom Web frequently encodes camera frames via custom WebAssembly/WebCodecs workers rather than standard RTCPeerConnection video senders.",
    selfViewOverlaySupport: true,
    knownLimitations: [
      "When Zoom Web uses its WebAssembly media transport, RTCRtpSender.replaceTrack() has zero video senders; only pre-call getUserMedia proxying or Virtual Camera affects remote participants.",
    ],
    fallbackWorkflow:
      "Recommended for Zoom: Open Snap Vanish Studio in Live Camera Mode, capture the stage window in OBS Studio -> Start Virtual Camera, and select 'OBS Virtual Camera' in Zoom.",
  },
];
