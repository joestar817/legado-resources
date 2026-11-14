import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCatalog, writeCatalog, initializeCatalogDates } from '../tools/catalog.mjs';

const SOURCE_A = 'a'.repeat(40);
const SOURCE_B = 'b'.repeat(40);
const SOURCE_C = 'c'.repeat(40);
const categories = [
  { id: 'fonts', name: '字体', type: 'font' },
  { id: 'backgrounds', name: '阅读背景', type: 'background' },
  { id: 'tts', name: 'TTS', type: 'tts' },
  { id: 'themes', name: '主题', type: 'theme' },
];
const cliPath = fileURLToPath(new URL('../tools/catalog.mjs', import.meta.url));

async function fixture(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ng-resource-test-'));
  const root = path.join(scratch, 'repo');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'resources'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(scratch));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(scratch).startsWith('ng-resource-test-'));
    await fs.rm(scratch, { recursive: true, force: true });
  });
  await putJson(root, 'catalog.config.json', { schemaVersion: 1, categories });
  return { root, scratch };
}

async function put(root, relative, content) {
  const destination = path.resolve(root, relative);
  const child = path.relative(path.resolve(root), destination);
  assert.ok(child && !child.startsWith('..') && !path.isAbsolute(child));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
  return destination;
}

async function putJson(root, relative, value) {
  return put(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function fontMeta(id = 'font.example.serif', payloadPath = 'resources/fonts/serif.ttf') {
  return {
    schemaVersion: 1,
    id,
    name: '示例宋体',
    author: '示例作者',
    license: 'NOASSERTION',
    payload: { path: payloadPath, format: 'ttf' },
  };
}

async function addFont(root, { id, payloadPath, content = 'font content v1', metadataPath = 'resources/fonts/serif.resource.json', extra = {} } = {}) {
  const metadata = { ...fontMeta(id, payloadPath), ...extra };
  await put(root, metadata.payload.path, content);
  await putJson(root, metadataPath, metadata);
  return { metadata, metadataPath, content };
}

function ttsSource(body = 'throw new Error("投稿脚本不得执行");') {
  return [
    '// @name 测试语音',
    '// @author 原作者',
    '// @version 1.2.0',
    '// @uuid fixture_engine',
    body,
    '',
  ].join('\n');
}

async function addTts(root, { content = ttsSource(), extra = {} } = {}) {
  const metadata = {
    schemaVersion: 1,
    id: 'tts.example.engine',
    license: 'NOASSERTION',
    payload: { path: 'resources/tts/engine.js', format: 'js' },
    ...extra,
  };
  await put(root, metadata.payload.path, content);
  await putJson(root, 'resources/tts/engine.resource.json', metadata);
  return metadata;
}

function build(root, previousState = null, sourceCommit = SOURCE_A) {
  return buildCatalog({ root, sourceCommit, previousState });
}

function resource(result, category = 'fonts', id = 'font.example.serif') {
  const found = result.indexes[category].resources.find((entry) => entry.id === id);
  assert.ok(found, `Missing resource ${id}`);
  return found;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function filesSnapshot(root) {
  const entries = {};
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else entries[relative] = digest(await fs.readFile(full));
    }
  }
  await walk(root);
  return entries;
}

async function makeSymlink(t, target, link, type) {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Host does not allow this symlink: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('empty configured categories are valid and retain category routing', async (t) => {
  const { root } = await fixture(t);
  const result = await build(root);
  assert.equal(result.catalog.schemaVersion, 1);
  assert.equal(result.catalog.sourceCommit, SOURCE_A);
  assert.equal(result.catalog.categories.length, 4);
  for (const category of categories) {
    const published = result.catalog.categories.find((entry) => entry.id === category.id);
    assert.equal(published.type, category.type);
    assert.equal(published.index, `resources/${category.id}/index.json`);
    assert.equal(published.count, 0);
    assert.equal(result.indexes[category.id].sourceCommit, SOURCE_A);
    assert.deepEqual(result.indexes[category.id].resources, []);
  }
  assert.equal(Object.keys(result.state.resources).length, 0);
});

test('reading preset catalog replaces standalone reading entries while retaining their history', async t => {
  const { root } = await fixture(t);
  await addFont(root);
  const previous = await build(root);
  const presetCategory = { id: 'read-presets', name: '阅读预设', type: 'read_preset' };
  await putJson(root, 'catalog.config.json', { schemaVersion: 1, categories: [presetCategory] });
  const content = Buffer.from('test preset package');
  await put(root, 'resources/read-presets/sample/preset.zip', content);
  await putJson(root, 'resources/read-presets/sample/preset.resource.json', {
    schemaVersion: 1, id: 'read.preset.sample', name: '阅读预设', author: '作者',
    payload: { path: 'resources/read-presets/sample/preset.zip', format: 'zip' },
  });
  const result = await build(root, previous.state, SOURCE_B);
  assert.equal(result.catalog.categories.length, 1);
  assert.equal(result.indexes['read-presets'].resources[0].payload.sha256, digest(content));
  assert.equal(result.state.resources['font.example.serif'].active, false);
  assert.equal(result.state.resources['read.preset.sample'].active, true);
  assert.equal(result.state.resources['read.preset.sample'].versionCode, 1);
  await put(root, 'resources/read-presets/sample/preset.zip', Buffer.from('new preset'));
  const updated = await build(root, result.state, SOURCE_C);
  assert.equal(updated.state.resources['read.preset.sample'].versionCode, 2);
  assert.equal(updated.state.resources['font.example.serif'].active, false);
});

test('resources root is required instead of silently publishing an empty inventory', async (t) => {
  const { root } = await fixture(t);
  await fs.rmdir(path.join(root, 'resources'));
  await assert.rejects(build(root));
});

test('metadata outside resources is not treated as a resource', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  await put(root, 'fonts/legacy.resource.json', '{invalid root-level metadata');
  await put(root, 'tools/example.resource.json', '{invalid tool fixture');
  const result = await build(root);
  assert.equal(result.indexes.fonts.resources.length, 1);
  assert.equal(resource(result).payload.path, 'resources/fonts/serif.ttf');
});

test('a linked resources root cannot bypass the repository boundary', async (t) => {
  const { root, scratch } = await fixture(t);
  await fs.rmdir(path.join(root, 'resources'));
  const outside = path.join(scratch, 'linked-resources');
  await fs.mkdir(outside);
  if (!await makeSymlink(t, outside, path.join(root, 'resources'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  await assert.rejects(build(root));
});

test('each supported resource type is routed and hashes actual bytes', async (t) => {
  const { root } = await fixture(t);
  await addFont(root, { content: Buffer.from([0, 1, 0, 0, 255, 10]) });
  await put(root, 'resources/backgrounds/paper.webp', Buffer.from('RIFFfixtureWEBP'));
  await putJson(root, 'resources/backgrounds/paper.resource.json', {
    schemaVersion: 1, id: 'background.example.paper', name: '纸张', author: 'A', license: 'CC0-1.0',
    payload: { path: 'resources/backgrounds/paper.webp', format: 'webp' },
  });
  await addTts(root);
  await put(root, 'resources/themes/theme.ngtheme', Buffer.from([80, 75, 3, 4, 1, 2, 3]));
  await putJson(root, 'resources/themes/theme.resource.json', {
    schemaVersion: 1, id: 'theme.example.paper', name: '纸张主题', author: 'A', license: 'CC0-1.0',
    payload: { path: 'resources/themes/theme.ngtheme', format: 'ngtheme' },
  });
  const result = await build(root);
  for (const category of categories) {
    const entry = result.indexes[category.id].resources[0];
    assert.equal(result.indexes[category.id].type, category.type);
    assert.equal(entry.versionCode, 1);
    const bytes = await fs.readFile(path.join(root, entry.payload.path));
    assert.equal(entry.payload.size, bytes.length);
    assert.equal(entry.payload.sha256, digest(bytes));
    assert.equal(result.state.resources[entry.id].active, true);
    assert.equal(result.state.resources[entry.id].type, category.type);
  }
});

test('TTS metadata is read statically without evaluating source', async (t) => {
  const { root, scratch } = await fixture(t);
  const marker = path.join(scratch, 'executed');
  await addTts(root, { content: ttsSource(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('do not run');`) });
  const result = await build(root);
  const entry = resource(result, 'tts', 'tts.example.engine');
  assert.equal(entry.name, '测试语音');
  assert.equal(entry.author, '原作者');
  assert.equal(entry.versionName, '1.2.0');
  assert.equal(entry.payload.engineId, 'fixture_engine');
  await assert.rejects(fs.access(marker));
});

test('explicit display metadata overrides TTS header defaults', async (t) => {
  const { root } = await fixture(t);
  await addTts(root, { extra: { name: '显示名', author: '署名', versionName: '作者版本' } });
  const entry = resource(await build(root), 'tts', 'tts.example.engine');
  assert.equal(entry.name, '显示名');
  assert.equal(entry.author, '署名');
  assert.equal(entry.versionName, '作者版本');
  assert.equal(entry.payload.engineId, 'fixture_engine');
});

test('payload revision advances only the changed resource', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  await addFont(root, { id: 'font.example.other', payloadPath: 'resources/fonts/other.ttf', metadataPath: 'resources/fonts/other.resource.json' });
  const first = await build(root);
  await put(root, 'resources/fonts/serif.ttf', 'font content v2');
  const second = await build(root, first.state, SOURCE_B);
  assert.equal(resource(second).versionCode, 2);
  assert.equal(resource(second, 'fonts', 'font.example.other').versionCode, 1);
  assert.equal(second.state.sourceCommit, SOURCE_B);
});

test('repeated generation and new commits with identical content do not advance versions', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  const first = await build(root);
  const repeated = await build(root, first.state);
  assert.deepEqual(repeated, first);
  const nextCommit = await build(root, repeated.state, SOURCE_B);
  assert.equal(resource(nextCommit).versionCode, 1);
  assert.equal(nextCommit.state.resources['font.example.serif'].fingerprint, first.state.resources['font.example.serif'].fingerprint);
});

test('display information and compatibility metadata refresh without reinstall revision', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  const first = await build(root);
  await putJson(root, metadataPath, {
    ...metadata, name: '新的显示名', author: '改正的署名', description: '仅修改说明', versionName: '2026',
    requirements: { minAppVersionCode: 999999, capabilities: ['font.variable'] },
    changelog: '说明更新', tags: ['阅读'],
    verification: { checkedOn: '2026-10-26', status: 'local-only', note: '尚未设备验证' },
  });
  const second = await build(root, first.state, SOURCE_B);
  const entry = resource(second);
  assert.equal(entry.versionCode, 1);
  assert.equal(entry.name, '新的显示名');
  assert.equal(entry.requirements.minAppVersionCode, 999999);
  assert.deepEqual(entry.requirements.capabilities, ['font.variable']);
  assert.equal(entry.verification.note, '尚未设备验证');
});

test('moving payload and metadata while keeping ID and bytes does not create a revision', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  const first = await build(root);
  await fs.mkdir(path.join(root, 'resources', 'fonts', 'renamed'));
  await fs.rename(path.join(root, metadata.payload.path), path.join(root, 'resources', 'fonts', 'renamed', 'book.ttf'));
  await fs.unlink(path.join(root, metadataPath));
  await putJson(root, 'resources/fonts/renamed/book.resource.json', { ...metadata, payload: { path: 'resources/fonts/renamed/book.ttf', format: 'ttf' } });
  const second = await build(root, first.state, SOURCE_B);
  assert.equal(resource(second).versionCode, 1);
  assert.equal(resource(second).payload.path, 'resources/fonts/renamed/book.ttf');
});

test('deletion retains version history and reintroduction does not reset it', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  const first = await build(root);
  await put(root, metadata.payload.path, 'second version');
  const second = await build(root, first.state, SOURCE_B);
  await fs.unlink(path.join(root, metadataPath));
  const deleted = await build(root, second.state, SOURCE_C);
  assert.deepEqual(deleted.indexes.fonts.resources, []);
  assert.equal(deleted.state.resources[metadata.id].active, false);
  assert.equal(deleted.state.resources[metadata.id].versionCode, 2);
  await putJson(root, metadataPath, metadata);
  const restored = await build(root, deleted.state, SOURCE_C);
  assert.equal(resource(restored).versionCode, 2);
  assert.equal(restored.state.resources[metadata.id].active, true);
  await fs.unlink(path.join(root, metadataPath));
  const removedAgain = await build(root, restored.state, SOURCE_C);
  await put(root, metadata.payload.path, 'third version after reintroduction');
  await putJson(root, metadataPath, metadata);
  assert.equal(resource(await build(root, removedAgain.state, SOURCE_C)).versionCode, 3);
});

test('restoring older payload bytes is a new published revision', async (t) => {
  const { root } = await fixture(t);
  await addFont(root, { content: 'old' });
  const first = await build(root);
  await put(root, 'resources/fonts/serif.ttf', 'new');
  const second = await build(root, first.state, SOURCE_B);
  await put(root, 'resources/fonts/serif.ttf', 'old');
  const rollback = await build(root, second.state, SOURCE_C);
  assert.equal(resource(rollback).versionCode, 3);
  assert.equal(resource(rollback).payload.sha256, resource(first).payload.sha256);
});

test('one resource ID cannot change its installation type', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  const first = await build(root);
  await fs.unlink(path.join(root, metadataPath));
  await put(root, 'resources/backgrounds/same.png', 'png bytes');
  await putJson(root, 'resources/backgrounds/same.resource.json', { ...metadata, payload: { path: 'resources/backgrounds/same.png', format: 'png' } });
  await assert.rejects(build(root, first.state, SOURCE_B));
});

test('duplicate IDs are rejected across resources', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  await addFont(root, { payloadPath: 'resources/fonts/other.ttf', metadataPath: 'resources/fonts/other.resource.json' });
  await assert.rejects(build(root));
});

test('two IDs cannot claim the same payload', async (t) => {
  const { root } = await fixture(t);
  const { metadata } = await addFont(root);
  await putJson(root, 'resources/fonts/other.resource.json', { ...metadata, id: 'font.example.other' });
  await assert.rejects(build(root));
});

test('two TTS resources cannot claim the same native engine identity', async (t) => {
  const { root } = await fixture(t);
  const metadata = await addTts(root);
  await put(root, 'resources/tts/other.js', ttsSource('function synthesize() {}'));
  await putJson(root, 'resources/tts/other.resource.json', {
    ...metadata, id: 'tts.example.other', payload: { path: 'resources/tts/other.js', format: 'js' },
  });
  await assert.rejects(build(root));
});

test('an existing TTS resource cannot change its native engine identity', async (t) => {
  const { root } = await fixture(t);
  await addTts(root);
  const first = await build(root);
  assert.equal(first.state.resources['tts.example.engine'].engineId, 'fixture_engine');
  await put(root, 'resources/tts/engine.js', ttsSource().replace('@uuid fixture_engine', '@uuid different_engine'));
  await assert.rejects(build(root, first.state, SOURCE_B));
});

test('deleted TTS resources retain ownership of their native engine identity', async (t) => {
  const { root } = await fixture(t);
  const metadata = await addTts(root);
  const first = await build(root);
  await fs.unlink(path.join(root, 'resources', 'tts', 'engine.resource.json'));
  const deleted = await build(root, first.state, SOURCE_B);
  assert.equal(deleted.state.resources[metadata.id].active, false);
  assert.equal(deleted.state.resources[metadata.id].engineId, 'fixture_engine');
  await putJson(root, 'resources/tts/engine.resource.json', { ...metadata, id: 'tts.example.replacement' });
  await assert.rejects(build(root, deleted.state, SOURCE_C));
});

test('case-only resource IDs collide across current categories', async (t) => {
  const { root } = await fixture(t);
  await addFont(root, { id: 'Example.Resource' });
  await put(root, 'resources/backgrounds/paper.png', 'image bytes');
  await putJson(root, 'resources/backgrounds/paper.resource.json', {
    schemaVersion: 1, id: 'example.resource', name: '纸张', author: 'A', license: 'NOASSERTION',
    payload: { path: 'resources/backgrounds/paper.png', format: 'png' },
  });
  await assert.rejects(build(root));
});

test('case-only identity changes cannot bypass published history', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root, { id: 'Example.Resource' });
  const first = await build(root);
  await fs.unlink(path.join(root, metadataPath));
  const deleted = await build(root, first.state, SOURCE_B);
  await put(root, 'resources/backgrounds/paper.png', 'image bytes');
  await putJson(root, 'resources/backgrounds/paper.resource.json', {
    schemaVersion: 1, id: 'example.resource', name: '纸张', author: 'A', license: 'NOASSERTION',
    payload: { path: 'resources/backgrounds/paper.png', format: 'png' },
  });
  await assert.rejects(build(root, deleted.state, SOURCE_C));
  assert.equal(deleted.state.resources[metadata.id].active, false);
});

test('TTS history missing native identity is rejected instead of guessed', async (t) => {
  const { root } = await fixture(t);
  await addTts(root);
  const first = await build(root);
  const damaged = structuredClone(first.state);
  delete damaged.resources['tts.example.engine'].engineId;
  await assert.rejects(build(root, damaged, SOURCE_B));
});

test('TTS metadata after executable source cannot override the catalog identity', async (t) => {
  const { root } = await fixture(t);
  await addTts(root, { content: ttsSource('function synthesize() {}\n// @uuid different_engine') });
  await assert.rejects(build(root));
});

test('late TTS metadata beyond a preview prefix cannot override the catalog identity', async (t) => {
  const { root } = await fixture(t);
  const content = ttsSource(`var padding = "${'x'.repeat(70000)}";\n// @uuid different_engine`);
  await addTts(root, { content });
  await assert.rejects(build(root));
});

test('TTS metadata beyond 256 comment lines is checked for identity overrides', async (t) => {
  const { root } = await fixture(t);
  const comments = Array.from({ length: 300 }, (_, index) => `// Comment ${index}`).join('\n');
  await addTts(root, { content: ttsSource(`${comments}\n// @uuid different_engine`) });
  await assert.rejects(build(root));
});

test('an empty late TTS UUID cannot erase the identity used by the app', async (t) => {
  const { root } = await fixture(t);
  await addTts(root, { content: ttsSource('function synthesize() {}\n// @uuid   ') });
  await assert.rejects(build(root));
});

test('unrecognized or mismatched categories are rejected', async (t) => {
  const { root } = await fixture(t);
  for (const invalid of [
    [{ id: 'executables', name: '未知类型', type: 'executable' }],
    [{ id: 'fonts', name: '字体', type: 'tts' }],
    [categories[0], categories[0]],
  ]) {
    await putJson(root, 'catalog.config.json', { schemaVersion: 1, categories: invalid });
    await assert.rejects(build(root));
  }
});

const purposes = [
  { id: 'reading', name: '阅读' }, { id: 'appearance', name: '外观' },
  { id: 'listening', name: '听书' }, { id: 'pets', name: '宠物' },
];
const purposeByType = { font: 'reading', background: 'reading', theme: 'appearance', tts: 'listening' };
const classifiedCategories = categories.map(category => ({ ...category, purpose: purposeByType[category.type] }));

test('catalog publishes purpose hierarchy and retains an empty purpose without fake resources', async t => {
  const { root, scratch } = await fixture(t);
  await addTts(root);
  await putJson(root, 'catalog.config.json', { schemaVersion: 1, purposes, categories: classifiedCategories });
  const result = await build(root);
  assert.deepEqual(result.catalog.purposes, purposes);
  assert.equal(result.catalog.categories.find(category => category.id === 'tts').purpose, 'listening');
  assert.equal(result.catalog.categories.some(category => category.purpose === 'pets'), false);
  const output = path.join(scratch, 'published');
  await writeCatalog(result, output);
  await writeCatalog(result, output);
  const published = JSON.parse(await fs.readFile(path.join(output, 'catalog.json'), 'utf8'));
  assert.deepEqual(published.categories.map(({ indexSha256, ...category }) => category), result.catalog.categories);
  assert.deepEqual(published.purposes, result.catalog.purposes);
});

test('classification labels and order never bump installation versions or dates', async t => {
  const { root } = await fixture(t);
  await addFont(root);
  await addTts(root);
  const initial = await buildCatalog({ root, sourceCommit: SOURCE_A, sourceTime: '2026-10-26T00:00:00Z' });
  const renamed = [...classifiedCategories].reverse().map(category => ({ ...category, name: `新${category.name}` }));
  await putJson(root, 'catalog.config.json', { schemaVersion: 1, purposes, categories: renamed });
  const changed = await buildCatalog({ root, sourceCommit: SOURCE_B, sourceTime: '2026-11-05T00:00:00Z', previousState: initial.state });
  assert.deepEqual(changed.state.resources, initial.state.resources);
  for (const category of categories) assert.deepEqual(changed.indexes[category.id].resources, initial.indexes[category.id].resources);
  assert.deepEqual(changed.catalog.categories.map(category => category.id), renamed.map(category => category.id));
});

test('invalid purposes and unresolved category purpose references are rejected', async t => {
  const { root } = await fixture(t);
  const invalid = [
    { purposes: [] },
    { purposes: [{ id: 'unknown', name: '未知' }] },
    { purposes: [purposes[0], purposes[0]] },
    { purposes: [{ ...purposes[0], extra: true }] },
    { categories },
    { categories: classifiedCategories.map(category => ({ ...category, purpose: 'missing' })) },
    { categories: classifiedCategories.map(category => ({ ...category, purpose: 'pets' })) },
  ];
  for (const changes of invalid) {
    await putJson(root, 'catalog.config.json', { schemaVersion: 1, purposes, categories: classifiedCategories, ...changes });
    await assert.rejects(build(root));
  }
  await putJson(root, 'catalog.config.json', { schemaVersion: 1, categories: classifiedCategories });
  await assert.rejects(build(root));
});

for (const [label, badPath] of [
  ['legacy root category path', 'fonts/serif.ttf'],
  ['parent traversal', '../outside.ttf'],
  ['absolute POSIX path', '/outside.ttf'],
  ['Windows drive path', 'C:/outside.ttf'],
  ['backslash path', 'fonts\\serif.ttf'],
  ['embedded traversal', 'resources/fonts/../fonts/serif.ttf'],
  ['different category', 'resources/backgrounds/serif.ttf'],
]) {
  test(`rejects payload ${label}`, async (t) => {
    const { root, scratch } = await fixture(t);
    const { metadata, metadataPath } = await addFont(root);
    await fs.writeFile(path.join(scratch, 'outside.ttf'), 'outside');
    await put(root, 'resources/backgrounds/serif.ttf', 'other category');
    await putJson(root, metadataPath, { ...metadata, payload: { path: badPath, format: 'ttf' } });
    await assert.rejects(build(root));
  });
}

test('missing payload and format/extension mismatch are rejected', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  await fs.unlink(path.join(root, metadata.payload.path));
  await assert.rejects(build(root));
  await put(root, metadata.payload.path, 'font');
  await putJson(root, metadataPath, { ...metadata, payload: { ...metadata.payload, format: 'otf' } });
  await assert.rejects(build(root));
});

test('unresolved Git LFS pointers cannot be published as actual resources', async (t) => {
  const { root } = await fixture(t);
  await addFont(root, { content: `version https://git-lfs.github.com/spec/v1\noid sha256:${'1'.repeat(64)}\nsize 4096\n` });
  await assert.rejects(build(root));
});

test('payload symlinks are rejected', async (t) => {
  const { root, scratch } = await fixture(t);
  const { metadata } = await addFont(root);
  await fs.unlink(path.join(root, metadata.payload.path));
  const target = path.join(scratch, 'outside.ttf');
  await fs.writeFile(target, 'outside');
  if (!await makeSymlink(t, target, path.join(root, metadata.payload.path), 'file')) return;
  await assert.rejects(build(root));
});

test('metadata symlinks are rejected', async (t) => {
  const { root, scratch } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  await fs.unlink(path.join(root, metadataPath));
  const target = path.join(scratch, 'outside.resource.json');
  await fs.writeFile(target, JSON.stringify(metadata));
  if (!await makeSymlink(t, target, path.join(root, metadataPath), 'file')) return;
  await assert.rejects(build(root));
});

test('symlinked resource subdirectories cannot bypass category boundaries', async (t) => {
  const { root, scratch } = await fixture(t);
  await fs.mkdir(path.join(root, 'resources', 'fonts'));
  const outside = path.join(scratch, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'font.ttf'), 'outside');
  await fs.writeFile(path.join(outside, 'font.resource.json'), JSON.stringify(fontMeta(undefined, 'resources/fonts/link/font.ttf')));
  if (!await makeSymlink(t, outside, path.join(root, 'resources', 'fonts', 'link'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  await assert.rejects(build(root));
});

for (const [label, value] of [
  ['missing', undefined], ['branch name', 'main'], ['short hash', 'abc123'],
  ['invalid hex', 'z'.repeat(40)], ['injected whitespace', `${SOURCE_A}\n`],
]) {
  test(`rejects ${label} sourceCommit`, async (t) => {
    const { root } = await fixture(t);
    await addFont(root);
    await assert.rejects(buildCatalog({ root, sourceCommit: value }));
  });
}

test('a full SHA-256 Git object ID is accepted', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  const sourceCommit = 'a'.repeat(64);
  assert.equal((await build(root, null, sourceCommit)).catalog.sourceCommit, sourceCommit);
});

test('invalid old state is rejected instead of resetting resource versions', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  const first = await build(root);
  const mutations = [
    (state) => { state.schemaVersion = 99; },
    (state) => { delete state.resources; },
    (state) => { state.sourceCommit = 'main'; },
    (state) => { state.resources['font.example.serif'].versionCode = 0; },
    (state) => { state.resources['font.example.serif'].versionCode = 1.5; },
    (state) => { state.resources['font.example.serif'].fingerprint = 'broken'; },
    (state) => { state.resources['font.example.serif'].active = 'yes'; },
    (state) => { state.resources['font.example.serif'].type = 'arbitrary-code'; },
    (state) => {
      state.resources[' font.example.serif'] = state.resources['font.example.serif'];
      delete state.resources['font.example.serif'];
    },
    (state) => {
      state.resources['font.example.serif '] = state.resources['font.example.serif'];
      delete state.resources['font.example.serif'];
    },
  ];
  for (const mutate of mutations) {
    const state = structuredClone(first.state);
    mutate(state);
    await assert.rejects(build(root, state, SOURCE_B));
  }
});

test('version counter overflow is rejected', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  const first = await build(root);
  const state = structuredClone(first.state);
  state.resources['font.example.serif'].versionCode = Number.MAX_SAFE_INTEGER;
  await put(root, 'resources/fonts/serif.ttf', 'changed bytes');
  await assert.rejects(build(root, state, SOURCE_B));
});

for (const [label, change] of [
  ['versionCode', (meta) => { meta.versionCode = 100; }],
  ['sourceCommit', (meta) => { meta.sourceCommit = SOURCE_A; }],
  ['publishedAt', (meta) => { meta.publishedAt = '2026-10-26T10:00:00Z'; }],
  ['updatedAt', (meta) => { meta.updatedAt = '2026-10-26T11:00:00Z'; }],
  ['root sha256', (meta) => { meta.sha256 = '1'.repeat(64); }],
  ['payload sha256', (meta) => { meta.payload.sha256 = '1'.repeat(64); }],
  ['payload size', (meta) => { meta.payload.size = 1; }],
]) {
  test(`manual machine field ${label} is rejected`, async (t) => {
    const { root } = await fixture(t);
    const { metadata, metadataPath } = await addFont(root);
    change(metadata);
    await putJson(root, metadataPath, metadata);
    await assert.rejects(build(root));
  });
}

test('invalid metadata and missing TTS native identity are rejected', async (t) => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  for (const change of [
    (meta) => { meta.license = ''; },
    (meta) => { delete meta.name; },
    (meta) => { meta.name = 5; },
    (meta) => { meta.requirements = { minAppVersionCode: -1 }; },
    (meta) => { meta.id = '../bad'; },
  ]) {
    const copy = structuredClone(metadata);
    change(copy);
    await putJson(root, metadataPath, copy);
    await assert.rejects(build(root));
  }
  await putJson(root, metadataPath, metadata);
  await addTts(root, { content: ttsSource().replace('// @uuid fixture_engine\n', '') });
  await assert.rejects(build(root));
});

test('arbitrary JSON and data files are not silently treated as resource metadata', async (t) => {
  const { root } = await fixture(t);
  await addFont(root);
  await put(root, 'resources/fonts/manifest.json', '{ old unrelated format');
  await put(root, 'resources/fonts/source-catalogs/sample.json', '{ unrelated');
  await put(root, 'resources/fonts/unregistered.ttf', 'not listed');
  assert.equal((await build(root)).indexes.fonts.resources.length, 1);
});

test('catalog output is stable regardless of metadata file creation order', async (t) => {
  const firstFixture = await fixture(t);
  const secondFixture = await fixture(t);
  for (const [target, names] of [[firstFixture, ['z', 'a']], [secondFixture, ['a', 'z']]]) {
    for (const name of names) {
      await addFont(target.root, { id: `font.example.${name}`, payloadPath: `resources/fonts/${name}.ttf`, metadataPath: `resources/fonts/${name}.resource.json`, content: name });
    }
  }
  const first = await build(firstFixture.root);
  const second = await build(secondFixture.root);
  assert.deepEqual(first, second);
  assert.deepEqual(first.indexes.fonts.resources.map((entry) => entry.id), ['font.example.a', 'font.example.z']);
});

test('writeCatalog writes a coherent snapshot and can replace its own generated output', async (t) => {
  const { root, scratch } = await fixture(t);
  await addFont(root);
  const first = await build(root);
  const output = path.join(scratch, 'catalog-output');
  await writeCatalog(first, output);
  const catalogFile = path.join(output, 'catalog.json');
  const published = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
  assert.deepEqual(published.categories.map(({ indexSha256, ...category }) => category), first.catalog.categories);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'state.json'), 'utf8')), JSON.parse(JSON.stringify(first.state)));
  for (const category of categories) {
    const folder = path.join(output, 'resources', category.id);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'index.json'), 'utf8')), first.indexes[category.id]);
    const bytes = await fs.readFile(path.join(folder, 'index.content.json'));
    const { sourceCommit, ...content } = first.indexes[category.id];
    assert.deepEqual(JSON.parse(bytes), content);
    assert.equal(published.categories.find(entry => entry.id === category.id).indexSha256, digest(bytes));
  }
  await put(root, 'resources/fonts/serif.ttf', 'second content');
  const second = await build(root, first.state, SOURCE_B);
  await writeCatalog(second, output);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'resources', 'fonts', 'index.json'), 'utf8')).resources[0].versionCode, 2);
  const updated = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
  for (const old of published.categories) {
    const next = updated.categories.find(category => category.id === old.id);
    if (old.id === 'fonts') assert.notEqual(next.indexSha256, old.indexSha256);
    else assert.equal(next.indexSha256, old.indexSha256);
  }
});

test('writeCatalog refuses source roots and directories containing unrelated user files', async (t) => {
  const { root, scratch } = await fixture(t);
  await addFont(root);
  const built = await build(root);
  const original = await filesSnapshot(root);
  await assert.rejects(writeCatalog(built, root));
  assert.deepEqual(await filesSnapshot(root), original);
  const output = path.join(scratch, 'user-output');
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'keep.txt'), 'existing user data');
  await assert.rejects(writeCatalog(built, output));
  assert.deepEqual(await filesSnapshot(output), { 'keep.txt': digest('existing user data') });
  const generated = path.join(scratch, 'generated-output');
  await writeCatalog(built, generated);
  await put(generated, 'resources/fonts/keep.txt', 'unrelated nested file');
  const before = await filesSnapshot(generated);
  await assert.rejects(writeCatalog(built, generated));
  assert.deepEqual(await filesSnapshot(generated), before);
});

test('CLI generation failure preserves the previous published output', async (t) => {
  const { root, scratch } = await fixture(t);
  const output = path.join(scratch, 'catalog');
  const args = [cliPath, 'generate', '--root', root, '--source-commit', SOURCE_A, '--source-time', '2026-10-26T10:00:00Z', '--out', output];
  const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  const before = await filesSnapshot(output);
  const { metadata, metadataPath } = await addFont(root);
  await putJson(root, metadataPath, { ...metadata, payload: { ...metadata.payload, path: '../outside.ttf' } });
  const failure = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(failure.status, 0);
  assert.deepEqual(await filesSnapshot(output), before);
});

test('CLI rejects an explicitly null state file without resetting published versions', async (t) => {
  const { root, scratch } = await fixture(t);
  await addFont(root);
  const first = await build(root);
  await put(root, 'resources/fonts/serif.ttf', 'second content');
  const second = await build(root, first.state, SOURCE_B);
  const output = path.join(scratch, 'catalog');
  await writeCatalog(second, output);
  const before = await filesSnapshot(output);
  const nullState = path.join(scratch, 'broken-state.json');
  await fs.writeFile(nullState, 'null\n');
  const result = spawnSync(process.execPath, [
    cliPath, 'generate', '--root', root, '--source-commit', SOURCE_C, '--source-time', '2026-10-27T10:00:00Z',
    '--state', nullState, '--out', output,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await filesSnapshot(output), before);
});

test('CLI validate uses published history to reject native identity changes', async (t) => {
  const { root, scratch } = await fixture(t);
  await addTts(root);
  const first = await build(root);
  const stateFile = path.join(scratch, 'state.json');
  await fs.writeFile(stateFile, JSON.stringify(first.state));
  const args = [cliPath, 'validate', '--root', root, '--state', stateFile];
  const firstCheck = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(firstCheck.status, 0, firstCheck.stderr);
  await put(root, 'resources/tts/engine.js', ttsSource().replace('@uuid fixture_engine', '@uuid replacement_engine'));
  const before = await filesSnapshot(root);
  const secondCheck = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(secondCheck.status, 0);
  assert.deepEqual(await filesSnapshot(root), before);
});

test('CLI validate rejects an explicitly null history', async (t) => {
  const { root, scratch } = await fixture(t);
  await addTts(root);
  const stateFile = path.join(scratch, 'state.json');
  await fs.writeFile(stateFile, 'null\n');
  const result = spawnSync(process.execPath, [cliPath, 'validate', '--root', root, '--state', stateFile], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

const TIME_A = '2026-10-26T10:00:00.000Z';
const TIME_B = '2026-10-26T11:00:00.000Z';
const TIME_C = '2026-10-27T10:00:00.000Z';

test('license is optional without inventing a permission declaration', async t => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  delete metadata.license;
  await putJson(root, metadataPath, metadata);
  const result = await build(root);
  assert.equal(Object.hasOwn(result.indexes.fonts.resources[0], 'license'), false);
});

test('dates follow content versions and survive metadata moves deletion and readdition', async t => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  const first = await buildCatalog({ root, sourceCommit: SOURCE_A, sourceTime: TIME_A });
  const firstItem = first.indexes.fonts.resources[0];
  assert.equal(firstItem.publishedAt, TIME_A);
  assert.equal(firstItem.updatedAt, TIME_A);
  assert.deepEqual(await buildCatalog({ root, sourceCommit: SOURCE_A, sourceTime: TIME_A, previousState: first.state }), first);
  metadata.description = '更正说明';
  metadata.payload.path = 'resources/fonts/moved.ttf';
  await put(root, metadata.payload.path, 'font content v1');
  await putJson(root, metadataPath, metadata);
  const moved = await buildCatalog({ root, sourceCommit: SOURCE_B, sourceTime: TIME_B, previousState: first.state });
  assert.equal(moved.indexes.fonts.resources[0].updatedAt, TIME_A);
  await put(root, metadata.payload.path, 'font content v2');
  const changed = await buildCatalog({ root, sourceCommit: SOURCE_B, sourceTime: TIME_B, previousState: moved.state });
  assert.equal(changed.indexes.fonts.resources[0].publishedAt, TIME_A);
  assert.equal(changed.indexes.fonts.resources[0].updatedAt, TIME_B);
  assert.equal(changed.indexes.fonts.resources[0].versionCode, 2);
  await fs.unlink(path.join(root, metadataPath));
  const removed = await buildCatalog({ root, sourceCommit: SOURCE_C, sourceTime: TIME_C, previousState: changed.state });
  assert.equal(removed.state.resources[metadata.id].updatedAt, TIME_B);
  await putJson(root, metadataPath, metadata);
  const restored = await buildCatalog({ root, sourceCommit: SOURCE_C, sourceTime: TIME_C, previousState: removed.state });
  assert.equal(restored.indexes.fonts.resources[0].publishedAt, TIME_A);
  assert.equal(restored.indexes.fonts.resources[0].updatedAt, TIME_B);
  assert.equal(restored.indexes.fonts.resources[0].versionCode, 2);
});

test('invalid dates and backwards content times are rejected without repairing state', async t => {
  const { root } = await fixture(t);
  await addFont(root);
  for (const sourceTime of ['2026-02-30T10:00:00Z', '2026-10-26', 'not a date', '2026-10-26T10:00:00+08:00']) {
    await assert.rejects(buildCatalog({ root, sourceCommit: SOURCE_A, sourceTime }), /timestamp/);
  }
  const first = await buildCatalog({ root, sourceCommit: SOURCE_A, sourceTime: TIME_B });
  for (const mutate of [
    record => { delete record.updatedAt; },
    record => { record.publishedAt = '2026-02-30T10:00:00Z'; },
    record => { record.updatedAt = TIME_A; },
  ]) {
    const state = structuredClone(first.state);
    mutate(state.resources['font.example.serif']);
    await assert.rejects(buildCatalog({ root, sourceCommit: SOURCE_B, sourceTime: TIME_C, previousState: state }));
  }
  await put(root, 'resources/fonts/serif.ttf', 'later content');
  await assert.rejects(buildCatalog({ root, sourceCommit: SOURCE_B, sourceTime: TIME_A, previousState: first.state }), /backwards/);
});

test('legacy dates require explicit complete history while validation remains read only', async t => {
  const { root } = await fixture(t);
  const { metadata, metadataPath } = await addFont(root);
  const first = await build(root);
  await build(root, first.state);
  await assert.rejects(buildCatalog({ root, sourceCommit: SOURCE_A, sourceTime: TIME_A, previousState: first.state }), /--initialize-dates/);
  await put(root, metadata.payload.path, 'font content v2');
  const changed = await build(root, first.state, SOURCE_B);
  await fs.unlink(path.join(root, metadataPath));
  const removed = await build(root, changed.state, SOURCE_C);
  const history = [{ state: first.state, sourceTime: TIME_A }, { state: changed.state, sourceTime: TIME_B }, { state: removed.state, sourceTime: TIME_C }];
  const initialized = initializeCatalogDates(history);
  assert.equal(initialized.resources[metadata.id].publishedAt, TIME_A);
  assert.equal(initialized.resources[metadata.id].updatedAt, TIME_B);
  assert.equal(initialized.resources[metadata.id].active, false);
  assert.equal(initialized.resources[metadata.id].versionCode, 2);
  assert.equal(initialized.resources[metadata.id].fingerprint, removed.state.resources[metadata.id].fingerprint);
  assert.deepEqual(initializeCatalogDates([...history, { state: initialized, sourceTime: TIME_C }]), initialized);
  assert.equal(first.state.resources[metadata.id].publishedAt, undefined);
  assert.throws(() => initializeCatalogDates(history.slice(1)), /incomplete/);
  for (const mutate of [
    h => { h[1].state.resources[metadata.id].versionCode = 7; },
    h => { h[1].state.resources[metadata.id].type = 'background'; },
    h => { delete h[1].state.resources[metadata.id]; },
    h => { h[1].sourceTime = '2026-10-25T10:00:00.000Z'; },
    h => { h[1].state.resources[metadata.id].publishedAt = TIME_B; h[1].state.resources[metadata.id].updatedAt = TIME_B; },
  ]) {
    const malformed = structuredClone(history);
    mutate(malformed);
    assert.throws(() => initializeCatalogDates(malformed));
  }
});

test('CLI generation requires an explicit source timestamp', async t => {
  const { root, scratch } = await fixture(t);
  await addFont(root);
  const result = spawnSync(process.execPath, [cliPath, 'generate', '--root', root, '--source-commit', SOURCE_A, '--out', path.join(scratch, 'output')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--source-time/);
});
