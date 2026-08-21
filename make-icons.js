/* Generates icon-192.png and icon-512.png — no dependencies. */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth = (edge, w, d) => clamp01((edge + w - d) / (2 * w));   // anti-aliased coverage

function roundedRectDist(x, y, hw, hh, r) {
  const dx = Math.abs(x) - (hw - r);
  const dy = Math.abs(y) - (hh - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1.2 / size;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;          // 0..1
      const v = (j + 0.5) / size;
      const cx = u - 0.5, cy = v - 0.5;

      // --- background: rounded square, indigo → violet gradient ---
      const bgD = roundedRectDist(cx, cy, 0.5, 0.5, 0.235);
      const bgA = smooth(0, aa, bgD);
      const t = clamp01((u + v) / 2);
      let r = Math.round(79  + (139 - 79)  * t);
      let g = Math.round(70  + (92  - 70)  * t);
      let b = Math.round(229 + (246 - 229) * t);

      // subtle top-left sheen
      const sheen = clamp01(1 - Math.hypot(u - 0.28, v - 0.24) * 1.9) * 0.16;
      r = Math.min(255, Math.round(r + sheen * 255));
      g = Math.min(255, Math.round(g + sheen * 255));
      b = Math.min(255, Math.round(b + sheen * 255));

      // --- bell glyph (white) ---
      const domeD  = Math.hypot(u - 0.5, (v - 0.455) * 1.05) - 0.175;
      const bodyD  = roundedRectDist(u - 0.5, v - 0.515, 0.183, 0.105, 0.05);
      const rimD   = roundedRectDist(u - 0.5, v - 0.635, 0.235, 0.032, 0.03);
      const clapD  = Math.hypot(u - 0.5, v - 0.715) - 0.048;

      const bellD = Math.min(domeD, bodyD, rimD, clapD);
      const bellA = smooth(0, aa, bellD);

      // cut a notch so the clapper reads separately
      const notchD = roundedRectDist(u - 0.5, v - 0.668, 0.09, 0.014, 0.014);
      const notchA = smooth(0, aa, notchD);

      const ink = clamp01(bellA - notchA);

      const outR = Math.round(r * (1 - ink) + 255 * ink);
      const outG = Math.round(g * (1 - ink) + 255 * ink);
      const outB = Math.round(b * (1 - ink) + 255 * ink);

      const o = (j * size + i) * 4;
      px[o]     = outR;
      px[o + 1] = outG;
      px[o + 2] = outB;
      px[o + 3] = Math.round(bgA * 255);
    }
  }

  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) {
    raw[j * (size * 4 + 1)] = 0;
    px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = path.join(__dirname, 'public');
for (const size of [192, 512]) {
  const file = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}
