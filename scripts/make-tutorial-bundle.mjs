// Packs tutorial/ into robot-code-tutorials-<version>.zip for the releases page.
//
// The deep-dive lessons are a separate download, not part of the .vsix (see .vscodeignore).
// Written with a store-only ZIP writer so there is no dependency and it runs on any OS.
//
//   node scripts/make-tutorial-bundle.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const src = path.join(repo, 'tutorial');
const out = path.join(repo, `robot-code-tutorials-${pkg.version}.zip`);

/** every file under `dir`, as { abs, rel } with forward-slash relative paths */
function walk(dir, base = dir) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...walk(p, base));
    else if (e.isFile()) found.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return found;
}

// CRC-32 (IEEE), the checksum every ZIP entry carries
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const files = walk(src);
if (!files.length) {
  console.error(`make-tutorial-bundle: ${path.relative(repo, src)} has no files`);
  process.exit(1);
}

const parts = [];
const central = [];
let offset = 0;
for (const f of files) {
  const data = readFileSync(f.abs);
  const name = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // local file header
  local.writeUInt16LE(20, 4);           // version needed
  local.writeUInt16LE(0x0800, 6);       // UTF-8 names
  local.writeUInt16LE(0, 8);            // method: store
  local.writeUInt16LE(0, 10);           // time
  local.writeUInt16LE(0x0021, 12);      // date: 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  parts.push(local, name, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);      // central directory header
  cd.writeUInt16LE(20, 4);              // version made by
  cd.writeUInt16LE(20, 6);              // version needed
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0x0021, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, name);

  offset += local.length + name.length + data.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);      // end of central directory
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

writeFileSync(out, Buffer.concat([...parts, cdBuf, eocd]));
console.log(`make-tutorial-bundle: ${path.basename(out)} (${files.length} files)`);
