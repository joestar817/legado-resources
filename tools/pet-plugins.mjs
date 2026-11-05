import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const safePath = name => name && !name.includes('\\') && !/[\x00-\x1f:]/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..');
function need(value, message) { if (!value) throw new Error(`Pet plugin: ${message}`); }

/** Read only metadata; never evaluate plugin code or extract paths from the archive. */
export async function readPetPlugin(filename) {
  const stat = await fs.stat(filename);
  need(stat.size > 0 && stat.size <= 64 * 1024 * 1024, 'package size invalid');
  const zip = await fs.readFile(filename);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  need(end >= 0 && zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length, 'invalid ZIP trailer');
  const count = zip.readUInt16LE(end + 10);
  need(count > 0 && count <= 512 && zip.readUInt16LE(end + 4) === 0 && zip.readUInt16LE(end + 6) === 0, 'unsupported ZIP');
  let offset = zip.readUInt32LE(end + 16);
  const centralEnd = offset + zip.readUInt32LE(end + 12);
  need(centralEnd <= end, 'invalid ZIP directory');
  const entries = new Map();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    need(offset + 46 <= centralEnd && zip.readUInt32LE(offset) === 0x02014b50, 'invalid ZIP entry');
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10);
    const packed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24);
    const nameSize = zip.readUInt16LE(offset + 28), extraSize = zip.readUInt16LE(offset + 30), commentSize = zip.readUInt16LE(offset + 32);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    need(next <= centralEnd, 'truncated ZIP name');
    const name = zip.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    need(safePath(name.replace(/\/$/, '')) && !entries.has(name) && !name.startsWith('lib/'), 'unsafe or duplicate entry');
    expanded += size;
    need(size <= 64 * 1024 * 1024 && expanded <= 128 * 1024 * 1024 && !(flags & 1) && [0, 8].includes(method), 'unsupported entry data');
    entries.set(name, { offset: zip.readUInt32LE(offset + 42), method, packed, size });
    offset = next;
  }
  need(offset === centralEnd, 'inconsistent ZIP directory');
  function data(name, max) {
    const entry = entries.get(name);
    need(entry && entry.size > 0 && entry.size <= max, `missing or invalid ${name}`);
    const start = entry.offset;
    need(start + 30 <= zip.length && zip.readUInt32LE(start) === 0x04034b50, 'invalid local header');
    const payload = start + 30 + zip.readUInt16LE(start + 26) + zip.readUInt16LE(start + 28);
    need(payload + entry.packed <= zip.length, 'truncated payload');
    const bytes = zip.subarray(payload, payload + entry.packed);
    const decoded = entry.method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: max });
    need(decoded.length === entry.size, 'inconsistent payload size');
    return decoded;
  }
  need(data('classes.dex', 16 * 1024 * 1024).subarray(0, 4).toString() === 'dex\n', 'missing compiled DEX');
  const format = extname(filename).toLowerCase();
  need(format === '.ngpet' || format === '.zip', 'unsupported package extension');
  const legacy = format === '.ngpet';
  const currentPath = 'assets/plugin.json';
  const legacyPath = 'assets/pet-plugin.json';
  need(!entries.has(legacy ? currentPath : legacyPath), 'manifest does not match package format');
  const manifest = JSON.parse(data(legacy ? legacyPath : currentPath, 16384));
  need(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'invalid manifest');
  const api = legacy ? 1 : 2;
  need(manifest.schemaVersion === api && manifest.apiVersion === api, 'unsupported schema or API');
  if (!legacy) {
    need(manifest.kind === 'pet', 'invalid extension kind');
    need(!['none', 'button'].includes(manifest.id), 'reserved plugin ID');
  }
  const className = legacy ? /^io\.legado\.plugins\.pets\.[A-Za-z0-9_.]+$/ : /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
  need(typeof manifest.id === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(manifest.id) &&
    typeof manifest.name === 'string' && manifest.name.trim() &&
    Number.isSafeInteger(manifest.versionCode) && manifest.versionCode > 0 &&
    typeof manifest.entryClass === 'string' && className.test(manifest.entryClass), 'invalid manifest');
  return manifest;
}
