import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publishCatalog, readCatalogState } from '../tools/publish-catalog.mjs';
import { buildCatalog, writeCatalog } from '../tools/catalog.mjs';

const gitExecutable = process.env.GIT || (process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

function git(cwd, args, input, environment = {}) {
  const result = spawnSync(gitExecutable, ['-c', 'core.autocrlf=false', '-c', 'user.name=Catalog Test', '-c', 'user.email=catalog-test@example.invalid', '-C', cwd, ...args], {
    encoding: 'utf8', input, windowsHide: true, env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result.stdout.trim();
}

function script(text = 'v1') {
  return `// @uuid fixture_engine\n// @name 示例引擎\n// @author 测试作者\n// @version 1.0.0\nfunction voices() { throw new Error('must not execute ${text}'); }\n`;
}

function fixture(t, firstDate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-catalog-publish-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source');
  const remote = path.join(directory, 'remote.git');
  fs.mkdirSync(root);
  fs.mkdirSync(remote);
  git(remote, ['init', '--bare', '--quiet']);
  git(root, ['init', '--initial-branch=main', '--quiet']);
  git(root, ['remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(root, 'resources', 'tts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'catalog.config.json'), JSON.stringify({ schemaVersion: 1, categories: [{ id: 'tts', name: 'TTS', type: 'tts' }] }));
  fs.writeFileSync(path.join(root, 'resources/tts/example.js'), script());
  fs.writeFileSync(path.join(root, 'resources/tts/example.resource.json'), JSON.stringify({ schemaVersion: 1, id: 'tts.example', license: 'NOASSERTION', payload: { path: 'resources/tts/example.js', format: 'js' } }));
  const commit = (message = '更新测试资源', date) => {
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', message], undefined, date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
    git(root, ['push', '--quiet', 'origin', 'main']);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const first = commit('初始化测试资源', firstDate);
  const publish = options => publishCatalog({ root, gitExecutable, token: '', ...options });
  const head = () => git(remote, ['rev-parse', 'refs/heads/catalog']);
  const read = (filename = 'state.json') => JSON.parse(git(remote, ['show', `refs/heads/catalog:${filename}`]));
  return { directory, root, remote, first, commit, publish, head, read };
}

test('first publication creates a complete catalog and repeated publication is a no-op', async t => {
  const f = fixture(t);
  await assert.rejects(f.publish(), /explicit --bootstrap/);
  const published = await f.publish({ allowBootstrap: true });
  assert.equal(published.status, 'published');
  assert.equal(published.sourceCommit, f.first);
  assert.equal(f.read().resources['tts.example'].versionCode, 1);
  assert.equal(f.read('catalog.json').sourceCommit, f.first);
  assert.equal(f.read('resources/tts/index.json').resources[0].payload.engineId, 'fixture_engine');
  const treeFiles = git(f.remote, ['ls-tree', '-r', '--name-only', f.head()]).split('\n');
  assert.deepEqual(treeFiles.sort(), ['catalog.json', 'resources/tts/index.json', 'state.json']);
  const firstHead = f.head();
  assert.equal((await f.publish()).status, 'unchanged');
  assert.equal(f.head(), firstHead);
  await assert.rejects(f.publish({ allowBootstrap: true }), /already exists/);
  assert.equal(git(f.root, ['status', '--porcelain=v1']), '');
});

test('publishes content revisions, deletion tombstones and re-addition without resetting versions', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('v2'));
  f.commit();
  await f.publish();
  assert.equal(f.read().resources['tts.example'].versionCode, 2);
  fs.unlinkSync(path.join(f.root, 'resources/tts/example.resource.json'));
  f.commit('移除目录项');
  await f.publish();
  assert.equal(f.read().resources['tts.example'].active, false);
  assert.equal(f.read().resources['tts.example'].versionCode, 2);
  assert.equal(f.read('resources/tts/index.json').resources.length, 0);
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.resource.json'), JSON.stringify({ schemaVersion: 1, id: 'tts.example', license: 'NOASSERTION', payload: { path: 'resources/tts/example.js', format: 'js' } }));
  f.commit('重新收录');
  await f.publish();
  assert.equal(f.read().resources['tts.example'].active, true);
  assert.equal(f.read().resources['tts.example'].versionCode, 2);
});

test('an older queued source commit cannot overwrite a newer published catalog', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('newer'));
  f.commit();
  await f.publish();
  const latest = f.head();
  git(f.root, ['checkout', '--quiet', '--detach', f.first]);
  const result = await f.publish();
  assert.equal(result.status, 'skipped-stale');
  assert.equal(f.head(), latest);
});

test('missing remote state is an error, not a bootstrap/reset', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  const previous = f.head();
  const tree = git(f.remote, ['mktree'], '');
  const broken = git(f.remote, ['commit-tree', tree, '-p', previous, '-m', 'test missing state']);
  git(f.remote, ['update-ref', 'refs/heads/catalog', broken, previous]);
  await assert.rejects(f.publish(), /state\.json|does not exist/i);
  assert.equal(f.head(), broken);
});

test('invalid remote state fails closed and leaves the public commit intact', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  const previous = f.head();
  const blob = git(f.remote, ['hash-object', '-w', '--stdin'], '{"schemaVersion":1,"sourceCommit":"broken"}');
  const tree = git(f.remote, ['mktree'], `100644 blob ${blob}\tstate.json\n`);
  const broken = git(f.remote, ['commit-tree', tree, '-p', previous, '-m', 'test invalid state']);
  git(f.remote, ['update-ref', 'refs/heads/catalog', broken, previous]);
  await assert.rejects(f.publish(), /invalid/i);
  assert.equal(f.head(), broken);
});

test('a competing catalog writer is preserved; publisher never force pushes', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('race'));
  f.commit();
  let competitor;
  await assert.rejects(f.publish({ beforePush: ({ priorHead }) => {
    const tree = git(f.remote, ['rev-parse', `${priorHead}^{tree}`]);
    competitor = git(f.remote, ['commit-tree', tree, '-p', priorHead, '-m', 'competing writer']);
    git(f.remote, ['update-ref', 'refs/heads/catalog', competitor, priorHead]);
  } }), /advanced before publication/);
  assert.equal(f.head(), competitor);
  assert.equal(f.read().resources['tts.example'].versionCode, 1);
  assert.equal((await f.publish()).status, 'published');
  assert.equal(f.read().resources['tts.example'].versionCode, 2);
});

test('a remote push rejection leaves the last successful catalog available', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  const previous = f.head();
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('rejected'));
  f.commit();
  const hook = path.join(f.remote, 'hooks/pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  await assert.rejects(f.publish(), /push failed/);
  assert.equal(f.head(), previous);
  assert.equal(f.read().resources['tts.example'].versionCode, 1);
});

test('dirty or unapproved source snapshots are not published', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  const previous = f.head();
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('dirty'));
  await assert.rejects(f.publish(), /must be clean/);
  git(f.root, ['add', '--all']);
  git(f.root, ['commit', '--quiet', '-m', 'not pushed']);
  await assert.rejects(f.publish(), /not on the approved remote branch/);
  assert.equal(f.head(), previous);
});

test('uses exact committed bytes and ignores untracked files excluded by Git', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'resources/tts/ignored.resource.json\n');
  f.commit('add ignore rule');
  fs.writeFileSync(path.join(f.root, 'resources/tts/ignored.resource.json'), '{broken json');
  const result = await f.publish({ allowBootstrap: true });
  assert.equal(result.status, 'published');
  assert.equal(f.read('resources/tts/index.json').resources.length, 1);
});

test('remote lookup failure is not treated as an absent catalog', async t => {
  const f = fixture(t);
  const absent = path.join(f.directory, 'missing-remote.git');
  git(f.root, ['remote', 'set-url', 'origin', absent]);
  await assert.rejects(f.publish(), /ls-remote failed/);
});

test('an accidentally deleted catalog branch cannot reset version history automatically', async t => {
  const f = fixture(t);
  await f.publish({ allowBootstrap: true });
  git(f.remote, ['update-ref', '-d', 'refs/heads/catalog']);
  await assert.rejects(f.publish(), /explicit --bootstrap/);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/catalog']), '');
});

test('PR state is read only from the official catalog and absent state fails closed', async t => {
  const f = fixture(t);
  const options = { root: f.root, gitExecutable, token: '' };
  await assert.rejects(readCatalogState(options), /Official catalog is absent/);
  await f.publish({ allowBootstrap: true });
  const result = await readCatalogState(options);
  assert.equal(result.catalogCommit, f.head());
  assert.equal(result.state.resources['tts.example'].versionCode, 1);
  fs.writeFileSync(path.join(f.root, 'state.json'), '{"sourceCommit":"forged"}');
  assert.equal((await readCatalogState(options)).catalogCommit, result.catalogCommit);
});

test('materialized LFS bytes are verified against the committed pointer without contacting LFS', async t => {
  const f = fixture(t);
  const bytes = Buffer.from(script('large-object') + '// padding\n'.repeat(300000));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${bytes.length}\n`;
  const cleanScript = path.join(f.directory, 'test-clean.mjs');
  fs.writeFileSync(cleanScript, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(pointer)}));\n`);
  git(f.root, ['config', 'filter.fixture-lfs.clean', `"${process.execPath.replaceAll('\\', '/')}" "${cleanScript.replaceAll('\\', '/')}"`]);
  git(f.root, ['config', 'filter.fixture-lfs.required', 'true']);
  fs.writeFileSync(path.join(f.root, '.gitattributes'), 'resources/tts/example.js filter=fixture-lfs -text\n');
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), bytes);
  f.commit('track materialized LFS fixture');
  assert.equal(git(f.root, ['show', 'HEAD:resources/tts/example.js']), pointer.trim());
  await f.publish({ allowBootstrap: true });
  assert.equal(f.read('resources/tts/index.json').resources[0].payload.sha256, digest);
  assert.equal(f.read('resources/tts/index.json').resources[0].payload.size, bytes.length);
  const published = f.head();
  // The clean filter deliberately still returns the old pointer. Git is clean,
  // so the publisher must independently reject mismatching materialized bytes.
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), bytes);
  assert.equal(git(f.root, ['status', '--porcelain=v1']), '');
  await assert.rejects(f.publish(), /LFS object.*does not match/);
  assert.equal(f.head(), published);
});

async function legacyPublication(f, previousState = null) {
  const sourceCommit = git(f.root, ['rev-parse', 'HEAD']);
  const generated = await buildCatalog({ root: f.root, sourceCommit, previousState });
  const scratch = fs.mkdtempSync(path.join(f.directory, 'legacy-'));
  const output = path.join(scratch, 'output');
  const checkout = path.join(scratch, 'catalog');
  await writeCatalog(generated, output);
  fs.mkdirSync(checkout);
  git(checkout, ['init', '--initial-branch=catalog', '--quiet']);
  git(checkout, ['remote', 'add', 'origin', f.remote]);
  if (previousState) {
    git(checkout, ['fetch', '--quiet', 'origin', 'catalog']);
    git(checkout, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
  }
  fs.cpSync(output, checkout, { recursive: true });
  git(checkout, ['add', '--all']);
  git(checkout, ['commit', '--quiet', '-m', '旧版目录夹具']);
  git(checkout, ['push', '--quiet', 'origin', 'catalog']);
  return generated.state;
}

test('publisher uses source committer time and preserves dates on metadata-only commits', async t => {
  const f = fixture(t, '2026-10-26T10:00:00Z');
  await f.publish({ allowBootstrap: true });
  const first = f.read().resources['tts.example'];
  assert.equal(first.publishedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(first.updatedAt, first.publishedAt);
  const metaPath = path.join(f.root, 'resources/tts/example.resource.json');
  const metadata = JSON.parse(fs.readFileSync(metaPath));
  delete metadata.license;
  metadata.description = '仅改说明';
  fs.writeFileSync(metaPath, JSON.stringify(metadata));
  f.commit('更正说明', '2026-10-26T11:00:00Z');
  await f.publish();
  assert.deepEqual(f.read().resources['tts.example'], first);
  assert.equal(Object.hasOwn(f.read('resources/tts/index.json').resources[0], 'license'), false);
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('v2'));
  f.commit('更新载荷', '2026-10-26T12:00:00Z');
  await f.publish();
  assert.equal(f.read().resources['tts.example'].publishedAt, first.publishedAt);
  assert.equal(f.read().resources['tts.example'].updatedAt, '2026-10-26T12:00:00.000Z');
});

test('legacy catalog dates are initialized only explicitly without changing resource versions', async t => {
  const f = fixture(t, '2026-10-26T10:00:00Z');
  const first = await legacyPublication(f);
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('v2'));
  f.commit('更新载荷', '2026-10-26T12:00:00Z');
  const second = await legacyPublication(f, first);
  const previousHead = f.head();
  await assert.rejects(f.publish(), /--initialize-dates/);
  assert.equal(f.head(), previousHead);
  assert.equal((await f.publish({ initializeDates: true })).status, 'published');
  const current = f.read().resources['tts.example'];
  assert.equal(current.publishedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(current.updatedAt, '2026-10-26T12:00:00.000Z');
  assert.equal(current.versionCode, second.resources['tts.example'].versionCode);
  assert.equal(current.fingerprint, second.resources['tts.example'].fingerprint);
  const initializedHead = f.head();
  assert.equal((await f.publish()).status, 'unchanged');
  assert.equal((await f.publish({ initializeDates: true })).status, 'unchanged');
  assert.equal(f.head(), initializedHead);
});

test('incomplete legacy version history fails before any catalog ref moves', async t => {
  const f = fixture(t, '2026-10-26T10:00:00Z');
  const first = await buildCatalog({ root: f.root, sourceCommit: f.first });
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('v2'));
  f.commit('更新载荷', '2026-10-26T12:00:00Z');
  // Publish v2 as an orphan catalog: there is no evidence for the first publication.
  const changed = await buildCatalog({ root: f.root, sourceCommit: git(f.root, ['rev-parse', 'HEAD']), previousState: first.state });
  const scratch = path.join(f.directory, 'incomplete');
  await writeCatalog(changed, scratch);
  git(scratch, ['init', '--initial-branch=catalog', '--quiet']);
  git(scratch, ['remote', 'add', 'origin', f.remote]);
  git(scratch, ['add', '--all']);
  git(scratch, ['commit', '--quiet', '-m', '不完整历史']);
  git(scratch, ['push', '--quiet', 'origin', 'catalog']);
  const before = f.head();
  await assert.rejects(f.publish({ initializeDates: true }), /incomplete/);
  assert.equal(f.head(), before);
});

test('backdated content commit cannot move the recorded update time backwards', async t => {
  const f = fixture(t, '2026-10-26T12:00:00Z');
  await f.publish({ allowBootstrap: true });
  const before = f.head();
  fs.writeFileSync(path.join(f.root, 'resources/tts/example.js'), script('v2'));
  f.commit('时间倒退的提交', '2026-10-26T11:00:00Z');
  await assert.rejects(f.publish(), /backwards/);
  assert.equal(f.head(), before);
});

test('shallow history at metadata-only version one cannot invent a later publication date', async t => {
  const f = fixture(t, '2026-10-26T10:00:00Z');
  const first = await legacyPublication(f);
  const metadataPath = path.join(f.root, 'resources/tts/example.resource.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath));
  metadata.description = '稍后的说明更正';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  f.commit('只改说明', '2026-10-26T12:00:00Z');
  await legacyPublication(f, first);
  const truncatedRemote = path.join(f.directory, 'shallow.git');
  git(f.directory, ['clone', '--quiet', '--bare', '--depth=1', '--branch=catalog', pathToFileURL(f.remote).href, truncatedRemote]);
  assert.equal(git(truncatedRemote, ['rev-parse', '--is-shallow-repository']), 'true');
  git(f.root, ['push', '--quiet', truncatedRemote, 'main']);
  git(f.root, ['remote', 'set-url', 'origin', truncatedRemote]);
  const before = git(truncatedRemote, ['rev-parse', 'refs/heads/catalog']);
  await assert.rejects(f.publish({ initializeDates: true }), /non-shallow|shallow|FETCH_HEAD/);
  assert.equal(git(truncatedRemote, ['rev-parse', 'refs/heads/catalog']), before);
});

test('catalog merge history is rejected by explicit date initialization', async t => {
  const f = fixture(t, '2026-10-26T10:00:00Z');
  await legacyPublication(f);
  const first = f.head();
  const tree = git(f.remote, ['rev-parse', `${first}^{tree}`]);
  const other = git(f.remote, ['commit-tree', tree, '-m', '平行目录历史']);
  const merged = git(f.remote, ['commit-tree', tree, '-p', first, '-p', other, '-m', '不支持的目录合并']);
  git(f.remote, ['update-ref', 'refs/heads/catalog', merged]);
  await assert.rejects(f.publish({ initializeDates: true }), /Complete linear catalog history/);
  assert.equal(f.head(), merged);
});
