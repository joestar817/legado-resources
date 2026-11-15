import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readOfflineTts, releaseDescriptor, releasePayload, releaseUrl, OFFLINE_TTS_ENGINE, OFFLINE_TTS_CAPABILITY } from '../tools/offline-tts.mjs';
import { buildCatalog } from '../tools/catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packageId = 'io.legado.prototype.microsoft';
function archive(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const key = Buffer.from(name), data = Buffer.from(content), a = Buffer.alloc(30), b = Buffer.alloc(46);
    a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20, 4); a.writeUInt32LE(data.length, 18); a.writeUInt32LE(data.length, 22); a.writeUInt16LE(key.length, 26);
    b.writeUInt32LE(0x02014b50); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6); b.writeUInt32LE(data.length, 20); b.writeUInt32LE(data.length, 24); b.writeUInt16LE(key.length, 28); b.writeUInt32LE(offset, 42);
    local.push(a, key, data); central.push(b, key); offset += a.length + key.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function bundle(change = {}) {
  const members = ['engine', 'voice.yunxi'].map((id, i) => ({ path: `packages/${i}.zip`, package_id: `${packageId}.${id}`, manifest_sha256: sha('test') }));
  const manifest = { format: 'ng-tts-package', schema_version: 1, kind: 'bundle', mode: 'complete',
    package_id: `${packageId}.bundle`, name: '测试离线语音', version_name: '1.0.2', version_code: 6, members,
    files: members.map(it => ({ path: it.path, size: 4, sha256: sha('test') })),
    roots: [{ package_id: `${packageId}.voice.yunxi`, voice_ids: ['zh-CN-YunxiNeural'] }], ...change };
  return archive([['manifest.json', JSON.stringify(manifest)], ...members.map(it => [it.path, 'test'])]);
}
const descriptor = bytes => ({ tag: 'tts-test-1', asset: 'voices.zip', size: bytes.length, sha256: sha(bytes) });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-offline-tts-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('ng-offline-tts-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('release source stays in the fixed repository and rejects URL or path injection', () => {
  const value = descriptor(bundle());
  assert.equal(releaseUrl(value), 'https://github.com/joestar817/legado-resources/releases/download/tts-test-1/voices.zip');
  for (const patch of [{ tag: '../bad' }, { tag: 'a..b' }, { asset: 'https://example.org/x.zip' },
    { asset: 'x%2f.zip' }, { asset: 'x.js' }, { size: 513 * 1024 * 1024 }, { sha256: 'x' }, { url: 'https://example.org' }]) {
    assert.throws(() => releaseDescriptor({ ...value, ...patch }));
  }
});

test('download, verified cache reuse, and corrupt cache rejection', async t => {
  const root = await fixture(t), bytes = bundle(), release = descriptor(bytes);
  let requests = 0;
  const file = await releasePayload(root, release, async url => {
    requests++; assert.equal(url, releaseUrl(release)); return new Response(bytes);
  });
  assert.equal(sha(await fs.readFile(file)), release.sha256);
  await releasePayload(root, release, () => { throw new Error('must reuse cache'); });
  assert.equal(requests, 1);
  await fs.writeFile(file, Buffer.alloc(bytes.length));
  await assert.rejects(releasePayload(root, release), /SHA-256/);
});

test('truncated, oversized, wrong digest and interrupted downloads leave no partial cache', async t => {
  const root = await fixture(t), bytes = bundle(), release = descriptor(bytes);
  for (const response of [new Response(bytes.subarray(1)), new Response(Buffer.concat([bytes, Buffer.from('x')])),
    new Response(Buffer.alloc(bytes.length)), new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 20)); controller.error(new Error('interrupted'));
    } }))]) {
    await assert.rejects(releasePayload(root, release, async () => response));
    assert.deepEqual(await fs.readdir(root), []);
  }
});

test('complete bundle metadata and Chinese voice roots are checked without loading code', async t => {
  const root = await fixture(t), filename = path.join(root, 'package.zip');
  await fs.writeFile(filename, bundle());
  assert.deepEqual(await readOfflineTts(filename), { uuid: OFFLINE_TTS_ENGINE, name: '测试离线语音', version: '1.0.2', voiceCount: 1 });
  for (const patch of [{ package_id: 'another.package' }, { mode: 'partial' }, { roots: [] },
    { roots: [{ package_id: `${packageId}.voice.yunxi`, voice_ids: ['zh-CN-YunxiNeural', 'zh-CN-YunxiNeural'] }] },
    { roots: [{ package_id: `${packageId}.voice.yunxi`, voice_ids: ['en-US-Jenny'] }] }]) {
    await fs.writeFile(filename, bundle(patch)); await assert.rejects(readOfflineTts(filename));
  }
});

test('release-backed catalog derives identity and version, preserves revisions and gates host capability', async t => {
  const root = await fixture(t), folder = path.join(root, 'resources/tts');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(root, 'catalog.config.json'), JSON.stringify({ schemaVersion: 1, categories: [{ id: 'tts', type: 'tts', name: '朗读引擎' }] }));
  const bytes = bundle(), cache = path.join(root, '.local/release-assets');
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, `${sha(bytes)}.zip`), bytes);
  const meta = { schemaVersion: 1, id: 'tts.offline', author: '测试',
    payload: { path: 'resources/tts/voices.zip', format: 'zip', release: descriptor(bytes) },
    requirements: { capabilities: [OFFLINE_TTS_CAPABILITY] } };
  const save = () => fs.writeFile(path.join(folder, 'voices.resource.json'), JSON.stringify(meta));
  await save();
  const first = await buildCatalog({ root, sourceCommit: 'a'.repeat(40) });
  const item = first.indexes.tts.resources[0];
  assert.equal(item.payload.engineId, OFFLINE_TTS_ENGINE); assert.equal(item.versionName, '1.0.2'); assert.equal(item.versionCode, 1);
  assert.deepEqual(item.payload.release, { tag: 'tts-test-1', asset: 'voices.zip' });
  meta.description = '仅介绍变化'; await save();
  const repeated = await buildCatalog({ root, sourceCommit: 'b'.repeat(40), previousState: first.state });
  assert.equal(repeated.indexes.tts.resources[0].versionCode, 1);
  meta.requirements.capabilities = []; await save();
  await assert.rejects(buildCatalog({ root, sourceCommit: 'a'.repeat(40) }), /capability/);
});
