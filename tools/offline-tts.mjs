import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const OFFLINE_TTS_CAPABILITY = 'tts.offline.microsoft.1';
export const OFFLINE_TTS_ENGINE = '__legado_microsoft_offline_bundle__';
export const MAX_OFFLINE_TTS_BYTES = 512 * 1024 * 1024;
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const hash = /^[a-f0-9]{64}$/;
const safePath = value => typeof value === 'string' && !/[\\\x00-\x1f:]/.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');
function need(value, message) { if (!value) throw new Error(`Offline TTS: ${message}`); }

export function releaseDescriptor(value) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'release descriptor required');
  need(Object.keys(value).every(key => ['tag', 'asset', 'size', 'sha256'].includes(key)), 'unsupported release field');
  need([value.tag, value.asset].every(part => typeof part === 'string' && segment.test(part) && !part.includes('..')) &&
    value.asset.endsWith('.zip'), 'invalid release tag or asset');
  need(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_OFFLINE_TTS_BYTES && hash.test(value.sha256), 'invalid release size or digest');
  return { tag: value.tag, asset: value.asset, size: value.size, sha256: value.sha256 };
}

export function releaseUrl(value) {
  const release = releaseDescriptor(value);
  return `https://github.com/joestar817/legado-resources/releases/download/${release.tag}/${release.asset}`;
}

async function verifyFile(filename, release) {
  const stat = await fs.lstat(filename);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size === release.size, 'release size mismatch');
  const sha = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    need(size <= release.size, 'release grew during verification');
    sha.update(chunk);
  }
  need(size === release.size && sha.digest('hex') === release.sha256, 'release SHA-256 mismatch');
}

/** The URL is restricted to this repository. Cache and remote bytes are both checked. */
export async function releasePayload(cacheDirectory, descriptor, fetchImpl = fetch) {
  const release = releaseDescriptor(descriptor);
  await fs.mkdir(cacheDirectory, { recursive: true });
  const directory = await fs.lstat(cacheDirectory);
  need(directory.isDirectory() && !directory.isSymbolicLink(), 'invalid release cache directory');
  const target = path.join(cacheDirectory, `${release.sha256}.zip`);
  try {
    await verifyFile(target, release);
    return target;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    const response = await fetchImpl(releaseUrl(release), { signal: AbortSignal.timeout(15 * 60 * 1000) });
    need(response.ok && response.body, `release download failed (${response.status})`);
    const length = response.headers.get('content-length');
    if (length !== null) need(Number(length) === release.size, 'release Content-Length mismatch');
    const file = await fs.open(temporary, 'wx');
    try {
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        need(received <= release.size, 'release exceeds declared size');
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    await verifyFile(temporary, release);
    await fs.rename(temporary, target);
    return target;
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Reads bounded ZIP metadata only. Native code and license inputs are never loaded. */
export async function readOfflineTts(filename) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    need(stat.isFile() && stat.size >= 22 && stat.size <= MAX_OFFLINE_TTS_BYTES, 'invalid package size');
    async function read(offset, size) {
      need(offset >= 0 && size >= 0 && offset + size <= stat.size, 'truncated ZIP');
      const bytes = Buffer.alloc(size);
      need((await file.read(bytes, 0, size, offset)).bytesRead === size, 'truncated ZIP');
      return bytes;
    }
    const tailOffset = Math.max(0, stat.size - 65557);
    const tail = await read(tailOffset, stat.size - tailOffset);
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    need(end >= 0 && end + 22 + tail.readUInt16LE(end + 20) === tail.length, 'invalid ZIP trailer');
    const count = tail.readUInt16LE(end + 10);
    need(count > 0 && count <= 256 && tail.readUInt16LE(end + 4) === 0 && tail.readUInt16LE(end + 6) === 0 &&
      tail.readUInt16LE(end + 8) === count, 'unsupported ZIP');
    const centralOffset = tail.readUInt32LE(end + 16), centralSize = tail.readUInt32LE(end + 12);
    need(centralSize <= 256 * 1024 && centralOffset + centralSize === tailOffset + end, 'invalid ZIP directory');
    const central = await read(centralOffset, centralSize);
    const entries = new Map();
    let offset = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      need(offset + 46 <= central.length && central.readUInt32LE(offset) === 0x02014b50, 'invalid ZIP entry');
      const nameSize = central.readUInt16LE(offset + 28);
      const next = offset + 46 + nameSize + central.readUInt16LE(offset + 30) + central.readUInt16LE(offset + 32);
      need(next <= central.length, 'truncated ZIP name');
      const name = central.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
      const method = central.readUInt16LE(offset + 10), size = central.readUInt32LE(offset + 24);
      expanded += size;
      need(safePath(name) && !entries.has(name) && !(central.readUInt16LE(offset + 8) & 1) &&
        [0, 8].includes(method) && expanded <= MAX_OFFLINE_TTS_BYTES, 'unsafe or unsupported ZIP entry');
      entries.set(name, { method, size, packed: central.readUInt32LE(offset + 20), offset: central.readUInt32LE(offset + 42) });
      offset = next;
    }
    need(offset === central.length, 'inconsistent ZIP directory');
    const entry = entries.get('manifest.json');
    need(entry && entry.size > 0 && entry.size <= 128 * 1024 && entry.packed <= 128 * 1024, 'invalid manifest size');
    const local = await read(entry.offset, 30);
    need(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(8) === entry.method, 'invalid local header');
    const name = await read(entry.offset + 30, local.readUInt16LE(26));
    need(name.toString('utf8') === 'manifest.json', 'inconsistent manifest entry');
    const payloadOffset = entry.offset + 30 + name.length + local.readUInt16LE(28);
    need(payloadOffset + entry.packed <= centralOffset, 'manifest overlaps ZIP directory');
    const packed = await read(payloadOffset, entry.packed);
    const bytes = entry.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: 128 * 1024 });
    need(bytes.length === entry.size, 'inconsistent manifest size');
    const manifest = JSON.parse(bytes);
    need(manifest.format === 'ng-tts-package' && manifest.schema_version === 1 && manifest.kind === 'bundle' &&
      manifest.mode === 'complete' && manifest.package_id === 'io.legado.prototype.microsoft.bundle', 'unsupported complete bundle');
    need(Number.isSafeInteger(manifest.version_code) && manifest.version_code > 0 &&
      typeof manifest.version_name === 'string' && manifest.version_name.length > 0 && manifest.version_name.length <= 128 &&
      typeof manifest.name === 'string' && manifest.name.trim(), 'invalid bundle version or name');
    need(Array.isArray(manifest.members) && manifest.members.length > 0 && manifest.members.length <= 255 &&
      Array.isArray(manifest.files) && manifest.files.length === manifest.members.length &&
      entries.size === manifest.members.length + 1, 'invalid bundle members');
    const memberIds = new Set(), memberPaths = new Set();
    for (const member of manifest.members) {
      const declared = manifest.files.filter(item => item.path === member.path);
      const item = entries.get(member.path);
      need(safePath(member.path) && item && !memberPaths.has(member.path) && !memberIds.has(member.package_id) &&
        typeof member.package_id === 'string' && member.package_id.startsWith('io.legado.prototype.microsoft.') &&
        hash.test(member.manifest_sha256) && declared.length === 1 && declared[0].size === item.size &&
        hash.test(declared[0].sha256), 'invalid member identity or size');
      memberPaths.add(member.path); memberIds.add(member.package_id);
    }
    need(memberIds.has('io.legado.prototype.microsoft.engine') && Array.isArray(manifest.roots) && manifest.roots.length > 0, 'missing engine or voices');
    const voices = new Set();
    for (const root of manifest.roots) {
      need(memberIds.has(root.package_id) && Array.isArray(root.voice_ids) && root.voice_ids.length > 0, 'invalid voice root');
      for (const voice of root.voice_ids) {
        need(typeof voice === 'string' && voice.startsWith('zh-') && !voices.has(voice), 'invalid or duplicate Chinese voice');
        voices.add(voice);
      }
    }
    return { uuid: OFFLINE_TTS_ENGINE, name: manifest.name, version: manifest.version_name, voiceCount: voices.size };
  } finally { await file.close(); }
}
