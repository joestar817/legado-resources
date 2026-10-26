import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = p => fs.readFileSync(path.join(root, p));

test('title font preserves the supplied bytes and has its own two-file resource directory', () => {
  const directory = 'resources/fonts/ss-fengyun-title';
  const font = read(`${directory}/font.ttf`);
  assert.equal(createHash('sha256').update(font).digest('hex'), '4b3cb885a37565825b925c48cbcaaea108b672f1994d0cad664ebd6e4958056f');
  assert.equal(font.readUInt32BE(0), 0x00010000);
  const metadata = JSON.parse(read(`${directory}/font.resource.json`));
  assert.equal(metadata.id, 'font.ss-fengyun-title');
  assert.equal(metadata.payload.path, `${directory}/font.ttf`);
  assert.equal(metadata.payload.format, 'ttf');
  assert.deepEqual(fs.readdirSync(path.join(root, directory)).sort(), ['font.resource.json', 'font.ttf']);
  assert.equal(fs.existsSync(path.join(root, 'resources/fonts/noto-sans-example')), false);
});

test('background example contains complete RGB pixels at the documented size', () => {
  const png = read('resources/backgrounds/warm-paper-example/warm-paper.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const parts = [];
  let width, height, ended = false;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    assert.equal(data.length, size);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[9], 2);
    }
    if (kind === 'IDAT') parts.push(data);
    if (kind === 'IEND') ended = true;
    offset += size + 12;
  }
  assert.deepEqual([width, height], [1080, 1440]);
  assert(ended);
  assert.equal(inflateSync(Buffer.concat(parts)).length, height * (1 + width * 3));
});

test('theme example packages the same complete native manifest as the readable source', () => {
  const zip = read('resources/themes/warm-paper-example/warm-paper.ngtheme');
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(8), 0); // Stored ZIP entry, no external decoder needed.
  const size = zip.readUInt32LE(18), nameLength = zip.readUInt16LE(26), extraLength = zip.readUInt16LE(28);
  assert.equal(zip.toString('utf8', 30, 30 + nameLength), 'manifest.json');
  const start = 30 + nameLength + extraLength;
  const manifest = zip.subarray(start, start + size);
  assert.deepEqual(manifest, read('resources/themes/warm-paper-example/manifest.json'));
  const data = JSON.parse(manifest);
  assert.equal(data.format, 'reading-ng-theme');
  assert.equal(data.version, 1); assert.equal(data.theme.schemaVersion, 1);
  for (const mode of ['manualLight', 'manualDark']) {
    for (const key of ['primary', 'secondary', 'primaryText', 'secondaryText', 'background', 'labelContainer']) {
      assert(Number.isInteger(data.theme.colors[mode][key]));
    }
  }
  assert.equal(data.theme.packageRootPath, null);
});

test('TTS example is a disabled syntax-valid template with no configured service', () => {
  const relative = 'resources/tts/http-template-example/engine.js';
  const source = read(relative).toString();
  assert.match(source, /@enabled false/);
  assert.match(source, /@uuid ng_resource_example_http_template/);
  assert.match(source, /key: "endpoint"[^\n]+defaultValue: ""/);
  const checked = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});
