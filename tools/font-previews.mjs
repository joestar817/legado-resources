import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HASH = /^[a-f0-9]{64}$/;
const PREVIEW_PATH = /^previews\/([a-f0-9]{64})\.png$/;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const SIZES = Object.freeze({ thumbnail: [256, 256], detail: [960, 420] });
const rendererScript = fileURLToPath(new URL('./render-font-preview.py', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function fail(message) { throw new Error(message); }
function fields(value, names, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some(key => !names.includes(key))) fail(`${label} contains an unsupported field`);
}
async function ordinary(filename, directory = false) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('Preview paths must be ordinary files/directories, not links');
  return stat;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Verify the bounded RGBA PNG format emitted by the trusted renderer, including chunk CRCs. */
function validatePng(bytes, width, height) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail('Invalid preview PNG');
  const compressed = [];
  let header = false, ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) fail('Truncated preview PNG');
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) fail('Truncated preview PNG chunk');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) fail('Invalid preview PNG checksum');
    if (kind === 'IHDR') {
      if (header || offset !== 8 || size !== 13 || data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height
        || data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail('Invalid preview PNG dimensions or format');
      header = true;
    } else if (kind === 'IDAT') {
      if (!header || ended || !size) fail('Invalid preview PNG data');
      compressed.push(data);
    } else if (kind === 'IEND') {
      if (!header || !compressed.length || size || end !== bytes.length) fail('Invalid preview PNG ending');
      ended = true;
    } else fail('Unexpected preview PNG chunk');
    offset = end;
  }
  if (!ended) fail('Incomplete preview PNG');
  const stride = width * 4 + 1, expectedSize = stride * height;
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedSize });
  if (pixels.length !== expectedSize) fail('Invalid preview PNG pixel data');
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) fail('Invalid preview PNG filter');
}

function validateAsset(asset, kind, files) {
  fields(asset, ['path', 'size', 'sha256', 'width', 'height'], `preview.${kind}`);
  const [width, height] = SIZES[kind];
  if (!HASH.test(asset.sha256) || asset.path !== `previews/${asset.sha256}.png`
    || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_IMAGE_BYTES
    || asset.width !== width || asset.height !== height) fail(`Invalid preview.${kind} metadata`);
  const bytes = files[asset.path];
  if (!Buffer.isBuffer(bytes) || bytes.length !== asset.size || digest(bytes) !== asset.sha256) fail(`Missing or mismatched preview image: ${asset.path}`);
  validatePng(bytes, width, height);
}

/** Called before replacing any output: every PNG must have a matching index reference. */
export function validatePreviewFiles(indexes, files = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail('previewFiles must be an object');
  const referenced = new Set();
  for (const index of Object.values(indexes)) {
    if (!Array.isArray(index?.resources)) fail('Invalid preview index resources');
    for (const resource of index.resources) {
      if (resource.preview === undefined) continue;
      if (index.type !== 'font') fail('Only fonts may contain font previews');
      fields(resource.preview, Object.keys(SIZES), 'preview');
      for (const kind of Object.keys(SIZES)) {
        validateAsset(resource.preview[kind], kind, files);
        referenced.add(resource.preview[kind].path);
      }
    }
  }
  for (const filename of Object.keys(files)) {
    if (!PREVIEW_PATH.test(filename) || !referenced.has(filename)) fail(`Unreferenced or unsafe preview output: ${filename}`);
  }
  return files;
}

/** Read the existing managed preview directory without accepting unrelated files or links. */
export async function readPreviewFiles(directory) {
  const files = Object.create(null);
  let stat;
  try { stat = await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Preview output must be an ordinary directory');
  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9]{64}\.png$/.test(name)) fail('Refusing to replace unrelated preview files');
    const filename = path.join(directory, name), info = await ordinary(filename);
    if (info.size < 1 || info.size > MAX_IMAGE_BYTES) fail('Invalid existing preview size');
    files[`previews/${name}`] = await fs.readFile(filename);
  }
  return files;
}

export function rendererEnvironment(environment = process.env) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'VIRTUAL_ENV', 'PYTHONHOME'];
  const result = {};
  for (const key of allowed) if (environment[key] !== undefined) result[key] = environment[key];
  return { ...result, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC' };
}

function runRenderer({ fontPath, outDir, pythonExecutable }) {
  const child = spawnSync(pythonExecutable, ['-B', rendererScript, '--font', fontPath, '--out', outDir], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: MAX_IMAGE_BYTES,
    env: rendererEnvironment(),
  });
  if (child.error || child.status !== 0) fail(`Font preview renderer failed: ${child.error?.message || child.stderr?.trim().slice(0, 2000) || child.status}`);
  try { return JSON.parse(child.stdout); } catch { fail('Font preview renderer returned invalid JSON'); }
}

async function sourceFont(root, payload) {
  if (typeof payload?.path !== 'string' || payload.path.includes('\\') || !payload.path.startsWith('resources/fonts/')) fail('Font preview source must stay in resources/fonts');
  if (!['ttf', 'otf'].includes(payload.format) || path.posix.extname(payload.path).toLowerCase() !== `.${payload.format}`) fail('Invalid font preview input format');
  const parts = payload.path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f:]/.test(part))) fail('Unsafe font preview source path');
  let filename = root;
  for (let i = 0; i < parts.length; i++) {
    filename = path.join(filename, parts[i]);
    await ordinary(filename, i < parts.length - 1);
  }
  const stat = await ordinary(filename);
  if (!HASH.test(payload.sha256) || stat.size !== payload.size || stat.size < 1 || stat.size > MAX_FONT_BYTES) fail('Invalid font preview input size or digest');
  if (digest(await fs.readFile(filename)) !== payload.sha256) fail('Font changed before preview generation');
  return filename;
}

/** Render only approved font payloads. render is an integration-test seam, never a metadata option. */
export async function attachFontPreviews(result, { root, pythonExecutable = process.env.FONT_PREVIEW_PYTHON || 'python3', render = runRenderer } = {}) {
  if (typeof root !== 'string' || !root) fail('Preview source root is required');
  await ordinary(path.resolve(root), true);
  root = await fs.realpath(path.resolve(root));
  const files = Object.create(null), reused = new Map(), indexes = Object.create(null);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-font-previews-'));
  try {
    for (const [category, index] of Object.entries(result.indexes)) {
      const resources = [];
      for (const item of index.resources) {
        if (index.type !== 'font') { resources.push(item); continue; }
        const fontPath = await sourceFont(root, item.payload);
        let preview = reused.get(item.payload.sha256);
        if (!preview) {
          const outDir = await fs.mkdtemp(path.join(scratch, 'font-'));
          const manifest = await render({ fontPath, outDir, pythonExecutable });
          fields(manifest, ['schemaVersion', 'rendererVersion', 'fontSha256', 'thumbnail', 'detail'], 'renderer manifest');
          if (manifest.schemaVersion !== 1 || manifest.rendererVersion !== 'font-sample-v1' || manifest.fontSha256 !== item.payload.sha256) fail('Renderer source or version mismatch');
          await ordinary(outDir, true);
          const expectedNames = new Set(), images = Object.create(null);
          preview = {};
          for (const kind of Object.keys(SIZES)) {
            const asset = manifest[kind];
            fields(asset, ['path', 'size', 'sha256', 'width', 'height'], `renderer ${kind}`);
            if (!HASH.test(asset.sha256) || asset.path !== `${asset.sha256}.png`) fail('Unsafe renderer image path');
            expectedNames.add(asset.path);
            const filename = path.join(outDir, asset.path), stat = await ordinary(filename);
            if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES) fail('Renderer image exceeds its size limit');
            const relative = `previews/${asset.path}`;
            images[relative] = await fs.readFile(filename);
            preview[kind] = { ...asset, path: relative };
            validateAsset(preview[kind], kind, images);
          }
          const names = await fs.readdir(outDir);
          if (names.length !== expectedNames.size || names.some(name => !expectedNames.has(name))) fail('Renderer emitted unexpected files');
          // Reject an input replaced during the renderer call, even when its manifest reused the expected digest.
          await sourceFont(root, item.payload);
          for (const [name, bytes] of Object.entries(images)) {
            if (files[name] && !files[name].equals(bytes)) fail('Preview output collision');
            files[name] = bytes;
          }
          reused.set(item.payload.sha256, preview);
        }
        resources.push({ ...item, preview });
      }
      indexes[category] = { ...index, resources };
    }
    validatePreviewFiles(indexes, files);
    return { ...result, indexes, previewFiles: files };
  } finally {
    // Only this invocation's mkdtemp directory is removed, never the caller's source or output.
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(scratch));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(scratch).startsWith('ng-font-previews-')) fail('Unsafe preview temporary directory');
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
