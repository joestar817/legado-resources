import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPetPlugin } from '../tools/pet-plugins.mjs';
import { buildCatalog } from '../tools/catalog.mjs';

function zip(entries) {
  const locals=[], central=[]; let offset=0;
  for(const [name,body] of entries) {
    const filename=Buffer.from(name), data=Buffer.from(body), local=Buffer.alloc(30), entry=Buffer.alloc(46);
    let crc=0xffffffff; for(const b of data){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);} crc=(crc^0xffffffff)>>>0;
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
    locals.push(local,filename,data);central.push(entry,filename);offset+=local.length+filename.length+data.length;
  }
  const body=Buffer.concat(locals),directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(body.length,16);
  return Buffer.concat([body,directory,end]);
}
const manifest=(extra={})=>({schemaVersion:1,apiVersion:1,id:'gugugaga',name:'咕嘎',versionCode:1,entryClass:'io.legado.plugins.pets.gugugaga.GuguGagaPlugin',...extra});
const pack=(extra={},entries=[])=>zip([['classes.dex','dex\n035\0'],['assets/pet-plugin.json',JSON.stringify(manifest(extra))],...entries]);
async function scratch(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ng-pet-test-'));t.after(async()=>{assert.ok(path.basename(root).startsWith('ng-pet-test-')&&path.dirname(root)===os.tmpdir());await fs.rm(root,{recursive:true,force:true});});return root;}
test('compiled pet manifest is read without executing code',async t=>{const root=await scratch(t),file=path.join(root,'pet.ngpet');await fs.writeFile(file,pack());assert.deepEqual(await readPetPlugin(file),manifest());});
for(const [name,bytes] of [
 ['API mismatch',pack({apiVersion:2})],['missing DEX',zip([['assets/pet-plugin.json',JSON.stringify(manifest())]])],
 ['non-DEX payload',zip([['classes.dex','not-dex'],['assets/pet-plugin.json',JSON.stringify(manifest())]])],
 ['native library',pack({},[['lib/arm64-v8a/evil.so','x']])],['path traversal',pack({},[['assets/../evil','x']])],
 ['duplicate path',pack({},[['classes.dex','dex\n035\0']])],['invalid ID',pack({id:'../escape'})],
])test(`rejects ${name}`,async t=>{const root=await scratch(t),file=path.join(root,'pet.ngpet');await fs.writeFile(file,bytes);await assert.rejects(readPetPlugin(file));});
test('pet catalog owns identity and requires compiled version to match automatic revision',async t=>{
 const root=await scratch(t);await fs.mkdir(path.join(root,'resources/pets'),{recursive:true});
 await fs.writeFile(path.join(root,'catalog.config.json'),JSON.stringify({schemaVersion:1,purposes:[{id:'pets',name:'宠物'}],categories:[{id:'pets',name:'宠物插件',type:'pet',purpose:'pets'}]}));
 const file=path.join(root,'resources/pets/gugu.ngpet'),metaFile=path.join(root,'resources/pets/gugu.resource.json');
 const meta={schemaVersion:1,id:'pet.gugugaga',name:'咕嘎',author:'测试',payload:{path:'resources/pets/gugu.ngpet',format:'ngpet',pluginId:'gugugaga'}};
 await fs.writeFile(file,pack());await fs.writeFile(metaFile,JSON.stringify(meta));
 const first=await buildCatalog({root,sourceCommit:'a'.repeat(40),sourceTime:'2026-11-05T00:00:00Z'});
 assert.equal(first.indexes.pets.resources[0].payload.pluginId,'gugugaga');assert.equal(first.state.resources['pet.gugugaga'].versionCode,1);
 const opts={root,sourceCommit:'b'.repeat(40),sourceTime:'2026-11-05T01:00:00Z',previousState:first.state};
 const repeat=await buildCatalog(opts);assert.equal(repeat.indexes.pets.resources[0].versionCode,1);
 await fs.writeFile(file,pack({name:'名字变化'}));await assert.rejects(buildCatalog(opts),/version/);
 await fs.writeFile(file,pack({versionCode:2}));const updated=await buildCatalog(opts);assert.equal(updated.indexes.pets.resources[0].versionCode,2);
 await fs.writeFile(file,pack({id:'blue_fish',versionCode:2}));await assert.rejects(buildCatalog(opts),/identity/);
});

test('all five real categories can coexist in the published catalog',async t=>{
 const root=await scratch(t);await fs.mkdir(path.join(root,'resources'));
 const categories=[['fonts','font'],['backgrounds','background'],['tts','tts'],['themes','theme'],['pets','pet']].map(([id,type])=>({id,type,name:id}));
 await fs.writeFile(path.join(root,'catalog.config.json'),JSON.stringify({schemaVersion:1,categories}));
 const result=await buildCatalog({root,sourceCommit:'a'.repeat(40)});assert.equal(result.catalog.categories.length,5);
});

const petV2 = {
  schemaVersion: 2,
  kind: 'pet',
  apiVersion: 2,
  id: 'light_orb',
  name: '测试光球',
  versionCode: 1,
  entryClass: 'example.orb.OrbPlugin',
};

function packV2(overrides = {}, extraEntries = []) {
  return zip([
    ['classes.dex', 'dex\n035\0'],
    ['assets/plugin.json', JSON.stringify({ ...petV2, ...overrides })],
    ...extraEntries,
  ]);
}

test('ZIP supports independent entry packages and zero artwork', async t => {
  const file = path.join(await scratch(t), 'orb.zip');
  await fs.writeFile(file, packV2());
  assert.deepEqual(await readPetPlugin(file), petV2);
});

for (const [name, bytes, error] of [
  ['legacy bytes renamed to ZIP', pack(), /manifest does not match/],
  ['two competing manifests', packV2({}, [['assets/pet-plugin.json', '{}']]), /manifest does not match/],
  ['wrong extension kind', packV2({ kind: 'theme' }), /kind/],
  ['unknown API', packV2({ apiVersion: 3 }), /API/],
  ['unknown schema', packV2({ schemaVersion: 3 }), /schema/],
  ['reserved button ID', packV2({ id: 'button' }), /reserved/],
  ['reserved none ID', packV2({ id: 'none' }), /reserved/],
  ['missing plugin identity', packV2({ id: undefined }), /invalid manifest/],
  ['invalid class name', packV2({ entryClass: 'example.1bad' }), /invalid manifest/],
]) {
  test(`v2 rejects ${name}`, async t => {
    const file = path.join(await scratch(t), 'test.zip');
    await fs.writeFile(file, bytes);
    await assert.rejects(readPetPlugin(file), error);
  });
}

test('migration keeps v1 identity and dates and advertises v2 host compatibility on new ZIP', async t => {
  const root = await scratch(t);
  const folder = path.join(root, 'resources/pets');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(root, 'catalog.config.json'), JSON.stringify({
    schemaVersion: 1,
    categories: [{ id: 'pets', name: '宠物插件', type: 'pet' }],
  }));
  const metadataFile = path.join(folder, 'one.resource.json');
  const metadata = {
    schemaVersion: 1,
    id: 'pet.gugugaga',
    name: '咕嘎',
    author: '测试',
    payload: { path: 'resources/pets/one.ngpet', format: 'ngpet', pluginId: 'gugugaga' },
  };
  const saveMetadata = () => fs.writeFile(metadataFile, JSON.stringify(metadata));
  await saveMetadata();
  await fs.writeFile(path.join(folder, 'one.ngpet'), pack());
  const old = await buildCatalog({ root, sourceCommit: 'a'.repeat(40), sourceTime: '2026-11-05T00:00:00Z' });

  metadata.payload = { path: 'resources/pets/one.zip', format: 'zip', pluginId: 'gugugaga' };
  await fs.writeFile(path.join(folder, 'one.zip'), packV2({ id: 'gugugaga', versionCode: 2 }));
  await saveMetadata();
  const current = { root, sourceCommit: 'b'.repeat(40), sourceTime: '2026-11-05T00:01:00Z', previousState: old.state };
  await assert.rejects(buildCatalog(current), /requires the pet.api.2 host capability/);
  metadata.requirements = { capabilities: ['pet.api.2'] };
  await saveMetadata();
  const updated = await buildCatalog(current);
  const [item] = updated.indexes.pets.resources;
  assert.equal(item.id, metadata.id);
  assert.equal(item.versionCode, 2);
  assert.equal(item.payload.pluginId, 'gugugaga');
  assert.equal(item.payload.format, 'zip');
  assert.deepEqual(item.requirements, metadata.requirements);
  assert.equal(item.publishedAt, old.indexes.pets.resources[0].publishedAt);
  assert.equal(item.updatedAt, '2026-11-05T00:01:00.000Z');

  const repeated = await buildCatalog({ ...current, sourceCommit: 'c'.repeat(40), previousState: updated.state });
  assert.deepEqual(repeated.indexes.pets.resources, updated.indexes.pets.resources);
  const noHistoryValidate = await buildCatalog({ root, sourceCommit: current.sourceCommit });
  assert.equal(noHistoryValidate.indexes.pets.resources[0].versionCode, 2);
  await assert.rejects(buildCatalog({ ...current, previousState: null }), /version must match/);

  metadata.id = 'pet.another-owner';
  await saveMetadata();
  await assert.rejects(buildCatalog(current), /belongs to another resource/);
});
