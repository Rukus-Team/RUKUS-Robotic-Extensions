// Generates media/icon.png (128x128) without any image dependency: a dark rounded
// tile with a yellow robot-arm glyph. Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const S = 128;
const px = new Uint8Array(S * S * 4);
const bg = [0x15, 0x1a, 0x21], fg = [0xf6, 0xc3, 0x43], accent = [0x61, 0xaf, 0xef];

function set(x, y, c, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const k = a / 255;
  px[i] = px[i] * (1 - k) + c[0] * k; px[i + 1] = px[i + 1] * (1 - k) + c[1] * k; px[i + 2] = px[i + 2] * (1 - k) + c[2] * k; px[i + 3] = Math.max(px[i + 3], a);
}
function roundedRect(x0, y0, w, h, r, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const dx = Math.max(x0 + r - x, x - (x0 + w - 1 - r), 0), dy = Math.max(y0 + r - y, y - (y0 + h - 1 - r), 0);
    const d = Math.hypot(dx, dy);
    if (d <= r) set(x, y, c, d > r - 1 ? Math.round(255 * (r - d)) : 255);
  }
}
function disc(cx, cy, r, c) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= r) set(x, y, c, d > r - 1 ? Math.round(255 * (r - d)) : 255);
  }
}
function segment(x1, y1, x2, y2, w, c) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const minX = Math.min(x1, x2) - w, maxX = Math.max(x1, x2) + w, minY = Math.min(y1, y2) - w, maxY = Math.max(y1, y2) + w;
  for (let y = Math.floor(minY); y <= maxY; y++) for (let x = Math.floor(minX); x <= maxX; x++) {
    const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / (len * len)));
    const d = Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
    if (d <= w / 2) set(x, y, c, d > w / 2 - 1 ? Math.round(255 * (w / 2 - d)) : 255);
  }
}

roundedRect(0, 0, S, S, 26, bg);
// base
segment(30, 102, 98, 102, 8, fg);
// arm
segment(46, 100, 54, 62, 10, fg);
segment(54, 62, 84, 44, 10, fg);
segment(84, 44, 92, 70, 9, fg);
disc(54, 62, 8, bg); disc(54, 62, 4.5, fg);
disc(84, 44, 8, bg); disc(84, 44, 4.5, fg);
// tool
disc(93, 76, 9, accent);
disc(93, 76, 4, bg);

// PNG encode
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1); }
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(new URL('../media/icon.png', import.meta.url), png);
console.log('wrote media/icon.png', png.length, 'bytes');
