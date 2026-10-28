import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCatalog, writeCatalog } from '../tools/catalog.mjs';
import { attachFontPreviews, rendererEnvironment, validatePreviewFiles } from '../tools/font-previews.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const sourceCommit = 'a'.repeat(40);
const sourceTime = '2026-10-27T00:00:00Z';
const cli = fileURLToPath(new URL('../tools/catalog.mjs', import.meta.url));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height, alpha = 255) {
  function chunk(type, data) {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * (1 + width * 4) + 1 + x * 4 + 3] = alpha;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function writeJson(filename, data) { await fs.writeFile(filename, `${JSON.stringify(data)}\n`); }

async function fixture(t, count = 1) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-font-preview-test-'));
  t.after(async () => {
    assert.ok(path.resolve(scratch).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(scratch).startsWith('ng-font-preview-test-'));
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const root = path.join(scratch, 'source');
  await fs.mkdir(path.join(root, 'resources', 'fonts'), { recursive: true });
  await writeJson(path.join(root, 'catalog.config.json'), { schemaVersion: 1, categories: [{ id: 'fonts', name: '字体', type: 'font' }] });
  for (let n = 0; n < count; n++) {
    await fs.writeFile(path.join(root, `resources/fonts/font${n}.ttf`), 'same fixture font bytes');
    await writeJson(path.join(root, `resources/fonts/font${n}.resource.json`), {
      schemaVersion: 1, id: `font.fixture.${n}`, name: '测试字体', author: '测试作者',
      payload: { path: `resources/fonts/font${n}.ttf`, format: 'ttf' },
    });
  }
  const build = () => buildCatalog({ root, sourceCommit, sourceTime });
  return { scratch, root, build };
}

async function fakeRenderer({ fontPath, outDir }, alpha = 255) {
  const manifest = { schemaVersion: 1, rendererVersion: 'font-name-thumbnail-v3', fontSha256: digest(await fs.readFile(fontPath)) };
  for (const [kind, width, height] of [['thumbnail', 256, 256], ['detail', 960, 420]]) {
    const bytes = png(width, height, alpha), sha256 = digest(bytes), name = `${sha256}.png`;
    await fs.writeFile(path.join(outDir, name), bytes);
    manifest[kind] = { path: name, size: bytes.length, sha256, width, height };
  }
  return manifest;
}

test('font previews are machine-only output and do not change versions or dates', async t => {
  const f = await fixture(t, 2), built = await f.build(), before = JSON.stringify(built);
  let calls = 0;
  const enriched = await attachFontPreviews(built, { root: f.root, render: async args => { calls++; return fakeRenderer(args); } });
  assert.equal(calls, 1, 'identical font payloads and names share one rendering');
  assert.equal(JSON.stringify(built), before, 'validation result is not mutated');
  assert.deepEqual(enriched.state, built.state);
  assert.equal(Object.keys(enriched.previewFiles).length, 2);
  for (const item of enriched.indexes.fonts.resources) {
    assert.equal(item.versionCode, 1);
    assert.equal(item.publishedAt, '2026-10-27T00:00:00.000Z');
    assert.equal(item.updatedAt, item.publishedAt);
    assert.match(item.preview.thumbnail.path, /^previews\/[a-f0-9]{64}\.png$/);
    assert.equal(item.preview.detail.width, 960);
  }
  const otherLayout = await attachFontPreviews(built, { root: f.root, render: args => fakeRenderer(args, 128) });
  assert.notEqual(enriched.indexes.fonts.resources[0].preview.detail.sha256, otherLayout.indexes.fonts.resources[0].preview.detail.sha256);
  assert.deepEqual(enriched.state, otherLayout.state);
});

test('same font bytes with different names render separate thumbnails', async t => {
  const f = await fixture(t, 2), built = await f.build();
  built.indexes.fonts.resources[0].name = '风云体';
  built.indexes.fonts.resources[1].name = '山川体';
  const names = [];
  const enriched = await attachFontPreviews(built, { root: f.root, render: async args => {
    names.push(args.fontName);
    return fakeRenderer(args, args.fontName === '风云体' ? 255 : 128);
  } });
  assert.deepEqual(names, ['风云体', '山川体']);
  const [first, second] = enriched.indexes.fonts.resources;
  assert.notEqual(first.preview.thumbnail.sha256, second.preview.thumbnail.sha256);
  assert.deepEqual(enriched.state, built.state);
  for (const item of [first, second]) {
    assert.equal(item.versionCode, 1);
    assert.equal(item.publishedAt, '2026-10-27T00:00:00.000Z');
    assert.equal(item.updatedAt, item.publishedAt);
  }
});

test('source metadata cannot author preview fields', async t => {
  const f = await fixture(t), file = path.join(f.root, 'resources/fonts/font0.resource.json');
  const meta = JSON.parse(await fs.readFile(file, 'utf8')); meta.preview = {};
  await writeJson(file, meta);
  await assert.rejects(f.build(), /unsupported field preview/);
});

test('preview generation rejects a source changed after catalog validation', async t => {
  const f = await fixture(t), built = await f.build();
  await fs.writeFile(path.join(f.root, 'resources/fonts/font0.ttf'), 'different fixture bytes');
  let called = false;
  await assert.rejects(attachFontPreviews(built, { root: f.root, render: () => { called = true; } }), /input size|changed before/);
  assert.equal(called, false);
});

test('preview generation rejects source replacement during rendering', async t => {
  const f = await fixture(t), built = await f.build();
  await assert.rejects(attachFontPreviews(built, { root: f.root, render: async args => {
    const manifest = await fakeRenderer(args);
    await fs.writeFile(args.fontPath, 'changed inside renderer');
    return manifest;
  } }), /input size|changed before/);
});

for (const [name, change] of [
  ['source digest', (m) => { m.fontSha256 = '0'.repeat(64); }],
  ['renderer version', (m) => { m.rendererVersion = 'other'; }],
  ['image path', (m) => { m.thumbnail.path = '../outside.png'; }],
  ['image size', (m) => { m.thumbnail.size++; }],
  ['image digest', (m) => { m.thumbnail.sha256 = '0'.repeat(64); }],
  ['image dimensions', (m) => { m.thumbnail.width = 960; }],
  ['extra manifest fields', (m) => { m.runNote = 'not a protocol field'; }],
  ['missing image', async (m, args) => { await fs.unlink(path.join(args.outDir, m.detail.path)); }],
  ['unrelated output', async (_, args) => { await fs.writeFile(path.join(args.outDir, 'keep.txt'), 'unrelated'); }],
]) {
  test(`preview generation rejects invalid ${name}`, async t => {
    const f = await fixture(t), built = await f.build();
    await assert.rejects(attachFontPreviews(built, { root: f.root, render: async args => {
      const manifest = await fakeRenderer(args); await change(manifest, args); return manifest;
    } }));
    assert.equal(built.indexes.fonts.resources[0].preview, undefined);
  });
}

test('preview PNG contents are checked independently of their claimed checksum', async t => {
  const f = await fixture(t), built = await f.build();
  await assert.rejects(attachFontPreviews(built, { root: f.root, render: async args => {
    const m = await fakeRenderer(args), old = path.join(args.outDir, m.thumbnail.path);
    const bytes = await fs.readFile(old); bytes[29] ^= 1;
    const sha256 = digest(bytes), filename = `${sha256}.png`;
    await fs.unlink(old); await fs.writeFile(path.join(args.outDir, filename), bytes);
    m.thumbnail.path = filename; m.thumbnail.sha256 = sha256;
    return m;
  } }), /PNG checksum/);
});

test('renderer output symlinks are rejected', async t => {
  const f = await fixture(t), target = path.join(f.scratch, 'target');
  await fs.writeFile(target, 'test');
  const link = path.join(f.scratch, 'probe-link');
  try { await fs.symlink(target, link); await fs.unlink(link); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('File symlink permission is unavailable'); throw error; }
  await assert.rejects(attachFontPreviews(await f.build(), { root: f.root, render: async args => {
    const m = await fakeRenderer(args), image = path.join(args.outDir, m.detail.path);
    await fs.unlink(image); await fs.symlink(target, image); return m;
  } }), /not links/);
});

test('preview PNGs and references are written atomically and old images are removed', async t => {
  const f = await fixture(t), built = await f.build(), output = path.join(f.scratch, 'catalog');
  const first = await attachFontPreviews(built, { root: f.root, render: fakeRenderer });
  await writeCatalog(first, output);
  const second = await attachFontPreviews(built, { root: f.root, render: args => fakeRenderer(args, 128) });
  await writeCatalog(second, output);
  assert.deepEqual((await fs.readdir(path.join(output, 'previews'))).sort(), Object.keys(second.previewFiles).map(p => path.basename(p)).sort());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'resources/fonts/index.json'), 'utf8')), second.indexes.fonts);
  await fs.writeFile(path.join(output, 'previews/keep.txt'), 'user data');
  await assert.rejects(writeCatalog(first, output), /unrelated preview/);
  assert.equal(await fs.readFile(path.join(output, 'previews/keep.txt'), 'utf8'), 'user data');
});

test('output refuses missing or orphan PNGs and previews on non-font resources', async t => {
  const f = await fixture(t), result = await attachFontPreviews(await f.build(), { root: f.root, render: fakeRenderer });
  const [filename] = Object.keys(result.previewFiles);
  const absent = { ...result.previewFiles }; delete absent[filename];
  assert.throws(() => validatePreviewFiles(result.indexes, absent), /Missing or mismatched/);
  assert.throws(() => validatePreviewFiles(result.indexes, { ...result.previewFiles, 'previews/keep.png': Buffer.from('x') }), /Unreferenced or unsafe/);
  assert.throws(() => validatePreviewFiles({ fonts: { ...result.indexes.fonts, type: 'theme' } }, result.previewFiles), /Only fonts/);
});

test('renderer receives no publication credentials or injected Python paths', () => {
  const environment = rendererEnvironment({ PATH: '/python', HOME: '/home/user', CATALOG_GITHUB_TOKEN: 'secret', GITHUB_TOKEN: 'secret',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'authorization secret', PYTHONPATH: '/untrusted' });
  assert.equal(environment.PATH, '/python');
  assert.equal(environment.HOME, '/home/user');
  assert.ok(Object.keys(environment).every(key => !/TOKEN|GIT_CONFIG|PYTHONPATH/.test(key)));
});

test('CLI renderer failure leaves the previous catalog intact', async t => {
  const f = await fixture(t, 0), output = path.join(f.scratch, 'catalog');
  const args = [cli, 'generate', '--root', f.root, '--source-commit', sourceCommit, '--source-time', sourceTime, '--out', output];
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
  const before = await fs.readFile(path.join(output, 'catalog.json'));
  await fs.writeFile(path.join(f.root, 'resources/fonts/font.ttf'), 'not a real font');
  await writeJson(path.join(f.root, 'resources/fonts/font.resource.json'), { schemaVersion: 1, id: 'font.invalid', name: '字体', author: '作者', payload: { path: 'resources/fonts/font.ttf', format: 'ttf' } });
  const failure = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, FONT_PREVIEW_PYTHON: process.execPath } });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /renderer failed/);
  assert.deepEqual(await fs.readFile(path.join(output, 'catalog.json')), before);
});
