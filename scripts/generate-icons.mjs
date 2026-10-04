/**
 * Generates the extension toolbar/store icons (16/48/128 px PNGs) without any
 * external dependency. Pure Node: hand-rolled PNG encoding using zlib.
 *
 * Draws a simple microphone glyph on a rounded blue square:
 *   - capsule body, lower arc, stem, base
 *
 * Output: src/public/icons/icon16.png, icon48.png, icon128.png
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public', 'icons');

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- Icon drawing ----------

const BG = [47, 111, 237, 255]; // blue
const FG = [255, 255, 255, 255]; // white mic
const TRANSPARENT = [0, 0, 0, 0];

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radius = size * 0.22;
  const b = half - radius; // rounded-square inner half-extent

  const put = (i, c) => {
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = c[3];
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      const i = (y * size + x) * 4;

      // rounded square background
      const ex = Math.max(Math.abs(px) - b, 0);
      const ey = Math.max(Math.abs(py) - b, 0);
      const insideBg = Math.hypot(ex, ey) <= radius;
      if (!insideBg) {
        put(i, TRANSPARENT);
        continue;
      }

      // microphone parts (all coordinates relative to center)
      const bodyTop = -0.3 * half;
      const bodyBottom = 0.06 * half;
      const bodyR = 0.17 * half;
      const inBody =
        px >= -bodyR &&
        px <= bodyR &&
        py >= bodyTop - bodyR + bodyR && // capsule: distance to vertical segment
        capsuleContains(px, py, 0, bodyTop + bodyR, 0, bodyBottom - bodyR, bodyR);

      const arcCx = 0;
      const arcCy = 0.1 * half;
      const arcR = 0.3 * half;
      const arcTh = 0.05 * half;
      const dist = Math.hypot(px - arcCx, py - arcCy);
      const inArc = Math.abs(dist - arcR) <= arcTh && py >= arcCy; // lower half only

      const inStem = Math.abs(px) <= 0.04 * half && py >= 0.4 * half && py <= 0.56 * half;
      const inBase = Math.abs(px) <= 0.17 * half && py >= 0.6 * half && py <= 0.68 * half;

      put(i, inBody || inArc || inStem || inBase ? FG : BG);
    }
  }
  return encodePng(size, size, rgba);
}

function capsuleContains(px, py, ax, ay, bx, by, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy) <= r;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = drawIcon(size);
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
