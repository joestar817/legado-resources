import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog } from '../tools/catalog.mjs';

// Stored entries are enough to exercise the catalog's format and purpose checks.
function zip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const key = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(key.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(key.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, key, data);
    centralParts.push(central, key);
    offset += local.length + key.length + data.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

test('listening-effect packages belong to listening and only accept the standalone player format', async t => {
  const temp = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'ng-listening-catalog-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temp);
    assert.ok(path.basename(root).startsWith('ng-listening-catalog-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const category = { id: 'listening-effects', name: '听书动效', type: 'listening_effect', purpose: 'listening' };
  const payload = 'resources/listening-effects/demo.zip';
  await fs.mkdir(path.join(root, 'resources', category.id), { recursive: true });
  await fs.writeFile(path.join(root, 'catalog.config.json'), JSON.stringify({
    schemaVersion: 1, purposes: [{ id: 'listening', name: '听书' }], categories: [category],
  }));
  const preview = 'assets/preview.png';
  const manifest = {
    format: 'reading-ng-listening-effect', version: 2, lightBackgroundAsset: preview, darkBackgroundAsset: preview,
    theme: { id: 'effect.demo', publication: { versionCode: 1 }, effect: { targets: ['player'], apiVersion: 1, preview } },
  };
  const writePack = value => fs.writeFile(path.join(root, payload),
    zip({ 'manifest.json': JSON.stringify(value), 'classes.dex': 'dex\n035\0', [preview]: 'preview' }));
  const writeMeta = capabilities => fs.writeFile(path.join(root, 'resources/listening-effects/demo.resource.json'), JSON.stringify({
    schemaVersion: 1, id: 'listening.effect.demo', name: '示例', author: '测试',
    license: 'NOASSERTION', payload: { path: payload, format: 'zip' },
    requirements: { capabilities },
  }));
  const build = () => buildCatalog({ root, sourceCommit: 'a'.repeat(40) });
  await writePack(manifest);
  await writeMeta(['listening.effect.1']);
  const result = await build();
  assert.equal(result.catalog.categories[0].purpose, 'listening');
  assert.equal(result.indexes[category.id].resources[0].id, 'listening.effect.demo');
  await writePack({ ...manifest, format: 'reading-ng-theme' });
  await assert.rejects(build, /standalone player package/);
  await writePack(manifest);
  await writeMeta(['theme.effect.1']);
  await assert.rejects(build, /listening\.effect\.1 host capability/);
});
