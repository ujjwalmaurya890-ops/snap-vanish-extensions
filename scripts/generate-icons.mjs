#!/usr/bin/env node
/**
 * Generates crisp RGBA PNG icons (16, 32, 48, 128 px) for Snap Vanish 2.0
 * using pure Node built-ins (zlib + CRC32) — zero external native dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.resolve(__dirname, "../extension/icons");

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderSnapMarkIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const rBg = size * 0.46;
  const rCircle = size * 0.31;

  // Deterministic dust fragments on the right side (normalized [0..1] coords)
  const fragments = [
    { cx: 0.57, cy: 0.28, r: 0.055 },
    { cx: 0.58, cy: 0.45, r: 0.06 },
    { cx: 0.57, cy: 0.63, r: 0.055 },
    { cx: 0.72, cy: 0.36, r: 0.045 },
    { cx: 0.74, cy: 0.54, r: 0.048 },
    { cx: 0.70, cy: 0.70, r: 0.042 },
    { cx: 0.85, cy: 0.44, r: 0.032 },
    { cx: 0.84, cy: 0.62, r: 0.03 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;

      // Rounded obsidian squircle background
      const nx = Math.abs(dx) / rBg;
      const ny = Math.abs(dy) / rBg;
      const squircle = Math.pow(nx, 4.2) + Math.pow(ny, 4.2);

      if (squircle > 1.0) {
        rgba[idx + 3] = 0;
        continue;
      }

      // Base obsidian charcoal
      let r = 16;
      let g = 18;
      let b = 24;
      const a = squircle > 0.9 ? Math.round((1 - (squircle - 0.9) / 0.1) * 255) : 255;

      // Left intact warm-ember hemisphere
      const distCenter = Math.sqrt(dx * dx + dy * dy);
      if (dx <= 0 && distCenter <= rCircle) {
        const grad = (y / size) * 0.35 + (1 - distCenter / rCircle) * 0.25;
        r = Math.min(255, Math.round(218 + grad * 37));
        g = Math.min(255, Math.round(78 + grad * 55));
        b = Math.min(255, Math.round(36 + grad * 28));
      } else {
        // Right dispersing dust fragments
        const ux = (x + 0.5) / size;
        const uy = (y + 0.5) / size;
        for (const f of fragments) {
          const fd = Math.hypot(ux - f.cx, uy - f.cy);
          if (fd <= f.r) {
            r = 246;
            g = 112;
            b = 68;
            break;
          }
        }
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.max(0, Math.min(255, a));
    }
  }

  return encodeRgbaPng(size, size, rgba);
}

fs.mkdirSync(ICONS_DIR, { recursive: true });
for (const sz of [16, 32, 48, 128]) {
  const out = path.join(ICONS_DIR, `icon-${sz}.png`);
  fs.writeFileSync(out, renderSnapMarkIcon(sz));
}
console.log("✓ Generated extension/icons/icon-{16,32,48,128}.png");
