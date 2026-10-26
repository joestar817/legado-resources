import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { buildCatalog, writeCatalog, checkState, catalogTimestamp, initializeCatalogDates } from './catalog.mjs';
import { attachFontPreviews } from './font-previews.mjs';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function gitRunner(executable, environment) {
  return (cwd, args, { input, binary = false, allowStatus = [] } = {}) => {
    const result = spawnSync(executable, ['-c', 'core.autocrlf=false', '-C', cwd, ...args], {
      env: environment, input, encoding: binary ? null : 'utf8', maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw new Error(`Git ${args[0]} failed: ${result.error.message}`);
    if (result.status !== 0 && !allowStatus.includes(result.status)) {
      throw new Error(`Git ${args[0]} failed (${result.status}): ${String(result.stderr).trim()}`);
    }
    return { output: result.stdout, status: result.status };
  };
}

function tokenEnvironment(remoteUrl, token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!token) return env;
  const remote = new URL(remoteUrl);
  const server = new URL(process.env.GITHUB_SERVER_URL || 'https://github.com');
  if (remote.protocol !== 'https:' || remote.origin !== server.origin || remote.username || remote.password) {
    throw new Error('Token authentication requires an HTTPS remote on GITHUB_SERVER_URL');
  }
  const offset = Number(env.GIT_CONFIG_COUNT || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid GIT_CONFIG_COUNT');
  env.GIT_CONFIG_COUNT = String(offset + 1);
  env[`GIT_CONFIG_KEY_${offset}`] = `http.${server.origin}/.extraheader`;
  env[`GIT_CONFIG_VALUE_${offset}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return env;
}

function checkBranch(git, root, value) {
  if (!REF_NAME.test(value) || value.startsWith('-')) throw new Error('Invalid branch name');
  git(root, ['check-ref-format', `refs/heads/${value}`]);
}

function remoteHead(git, cwd, remote, branch) {
  const result = git(cwd, ['ls-remote', '--refs', remote, `refs/heads/${branch}`]).output.trim();
  if (!result) return null; // Only a successful empty response permits bootstrap.
  const lines = result.split(/\r?\n/);
  if (lines.length !== 1) throw new Error('Ambiguous remote branch response');
  const [sha, ref] = lines[0].split(/\s+/);
  if (!SHA.test(sha) || ref !== `refs/heads/${branch}`) throw new Error('Invalid remote branch response');
  return sha;
}

function isAncestor(git, root, ancestor, descendant) {
  const result = git(root, ['merge-base', '--is-ancestor', ancestor, descendant], { allowStatus: [1] });
  return result.status === 0;
}

function safeSourceFile(root, relative) {
  if (relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Invalid tracked source path');
  }
  let current = root;
  for (const piece of relative.split('/')) {
    current = path.join(current, piece);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${relative}`);
  }
  return current;
}

// Read exact Git blob bytes, not a filtered/CRLF checkout. LFS object bytes are
// taken from the materialized checkout only after matching its committed pointer.
async function materializeSource(git, root, commit, destination) {
  fs.mkdirSync(destination);
  const entries = git(root, ['ls-tree', '-rz', '--full-tree', commit], { binary: true }).output.toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, kind, object] = entry.slice(0, tab).split(' ');
    const relative = entry.slice(tab + 1);
    if (tab < 0 || kind !== 'blob' || !['100644', '100755'].includes(mode) || !SHA.test(object)) {
      throw new Error('Source snapshot must contain ordinary tracked files only');
    }
    const sourcePath = safeSourceFile(root, relative);
    const target = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let bytes = git(root, ['cat-file', 'blob', object], { binary: true }).output;
    if (bytes.subarray(0, 42).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
      const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/.exec(bytes.toString('utf8'));
      if (!pointer) throw new Error(`Invalid LFS pointer: ${relative}`);
      const expectedSize = Number(pointer[2]);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error(`Invalid LFS size: ${relative}`);
      const before = fs.statSync(sourcePath);
      if (before.size !== expectedSize) throw new Error(`LFS object is missing or does not match its pointer: ${relative}`);
      const digest = createHash('sha256');
      let size = 0;
      await pipeline(fs.createReadStream(sourcePath), new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > expectedSize) return callback(new Error(`LFS object grew while reading: ${relative}`));
          digest.update(chunk);
          callback(null, chunk);
        },
      }), fs.createWriteStream(target, { flags: 'wx' }));
      const after = fs.statSync(sourcePath);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev || size !== expectedSize || digest.digest('hex') !== pointer[1]) {
        throw new Error(`LFS object is missing or does not match its pointer: ${relative}`);
      }
      continue;
    }
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
}

/** Read only the official published state; absent/unreachable is never empty. */
export async function readCatalogState({ root = '.', remote = 'origin', branch = 'catalog', gitExecutable = process.env.GIT || 'git', token = process.env.CATALOG_GITHUB_TOKEN } = {}) {
  root = fs.realpathSync(root);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) throw new Error('Invalid remote name');
  const initialGit = gitRunner(gitExecutable, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
  const remoteUrl = initialGit(root, ['remote', 'get-url', remote]).output.trim();
  if (/^https?:\/\/[^/]*@/i.test(remoteUrl)) throw new Error('Do not embed credentials in the remote URL');
  const git = gitRunner(gitExecutable, tokenEnvironment(remoteUrl, token));
  checkBranch(git, root, branch);
  const commit = remoteHead(git, root, remoteUrl, branch);
  if (!commit) throw new Error('Official catalog is absent; bootstrap it from trusted main before checking contributions');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-catalog-state-'));
  try {
    git(scratch, ['init', '--quiet']);
    git(scratch, ['fetch', '--no-tags', remoteUrl, `refs/heads/${branch}`]);
    if (git(scratch, ['rev-parse', 'FETCH_HEAD']).output.trim() !== commit) throw new Error('Catalog advanced during fetch; retry');
    const state = JSON.parse(git(scratch, ['show', `${commit}:state.json`]).output);
    if (!state || state.schemaVersion !== 1 || !SHA.test(state.sourceCommit)) throw new Error('Catalog state is missing or invalid');
    return { catalogCommit: commit, state };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Publish one approved source snapshot. beforePush is an integration-test seam. */
export async function publishCatalog({
  root = '.', remote = 'origin', sourceBranch = 'main', branch = 'catalog',
  gitExecutable = process.env.GIT || 'git', token = process.env.CATALOG_GITHUB_TOKEN,
  allowBootstrap = false, initializeDates = false, beforePush,
} = {}) {
  root = fs.realpathSync(root);
  const initialGit = gitRunner(gitExecutable, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
  const top = fs.realpathSync(initialGit(root, ['rev-parse', '--show-toplevel']).output.trim());
  if (top !== root) throw new Error('--root must be the repository root');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) throw new Error('Invalid remote name');
  const remoteUrl = initialGit(root, ['remote', 'get-url', remote]).output.trim();
  if (/^https?:\/\/[^/]*@/i.test(remoteUrl)) throw new Error('Do not embed credentials in the remote URL');
  const git = gitRunner(gitExecutable, tokenEnvironment(remoteUrl, token));
  checkBranch(git, root, sourceBranch);
  checkBranch(git, root, branch);
  if (sourceBranch === branch) throw new Error('Source and catalog branches must be different');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']).output.trim()) {
    throw new Error('Source checkout must be clean before publication');
  }
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).output.trim();
  if (!SHA.test(sourceCommit)) throw new Error('Invalid source commit');
  if (!remoteHead(git, root, remoteUrl, sourceBranch)) throw new Error('Approved source branch does not exist remotely');
  git(root, ['fetch', '--no-tags', remoteUrl, `refs/heads/${sourceBranch}`]);
  const approvedCommit = git(root, ['rev-parse', 'FETCH_HEAD']).output.trim();
  if (!isAncestor(git, root, sourceCommit, approvedCommit)) throw new Error('Source commit is not on the approved remote branch');

  const priorHead = remoteHead(git, root, remoteUrl, branch);
  if (!priorHead && !allowBootstrap) throw new Error('Catalog branch is absent; first publication requires explicit --bootstrap');
  if (priorHead && allowBootstrap) throw new Error('Catalog already exists; bootstrap cannot overwrite its history');
  if (initializeDates && !priorHead) throw new Error('--initialize-dates requires an existing catalog');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-catalog-publish-'));
  try {
    const publishRoot = path.join(scratch, 'catalog');
    fs.mkdirSync(publishRoot);
    git(publishRoot, ['init', '--quiet']);
    git(publishRoot, ['remote', 'add', 'origin', remoteUrl]);
    let previousState = null;
    if (priorHead) {
      git(publishRoot, ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
      if (git(publishRoot, ['rev-parse', 'FETCH_HEAD']).output.trim() !== priorHead) {
        throw new Error('Catalog advanced during fetch; retry against the new baseline');
      }
      previousState = JSON.parse(git(publishRoot, ['show', `${priorHead}:state.json`]).output);
      if (!previousState || previousState.schemaVersion !== 1 || !SHA.test(previousState.sourceCommit)) {
        throw new Error('Catalog state is missing or invalid');
      }
      if (sourceCommit !== previousState.sourceCommit) {
        if (isAncestor(git, root, sourceCommit, previousState.sourceCommit)) {
          return { status: 'skipped-stale', sourceCommit, catalogCommit: priorHead };
        }
        if (!isAncestor(git, root, previousState.sourceCommit, sourceCommit)) {
          throw new Error('Source history diverged from the published catalog');
        }
      }
    }
    if (previousState) {
      const records = checkState(previousState);
      if (initializeDates) {
        if (git(publishRoot, ['rev-parse', '--is-shallow-repository']).output.trim() !== 'false') throw new Error('Complete non-shallow catalog history is required to initialize dates');
        const revisions = git(publishRoot, ['rev-list', '--reverse', '--first-parent', priorHead]).output.trim().split(/\r?\n/);
        if (revisions.length > 100000) throw new Error('Catalog history is too large');
        const history = [];
        let lastSource;
        let lastRevision;
        for (const revision of revisions) {
          if (!SHA.test(revision)) throw new Error('Invalid catalog history revision');
          const headers = git(publishRoot, ['cat-file', '-p', revision]).output.split('\n\n', 1)[0];
          const parents = [...headers.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]);
          if (parents.length !== (lastRevision ? 1 : 0) || (lastRevision && parents[0] !== lastRevision)) {
            throw new Error('Complete linear catalog history is required to initialize dates');
          }
          const state = JSON.parse(git(publishRoot, ['show', `${revision}:state.json`]).output);
          checkState(state);
          if (!isAncestor(git, root, state.sourceCommit, sourceCommit) || (lastSource && !isAncestor(git, root, lastSource, state.sourceCommit))) {
            throw new Error('Catalog source history diverged; cannot initialize dates');
          }
          history.push({ state, sourceTime: sourceTimestamp(git, root, state.sourceCommit) });
          lastSource = state.sourceCommit;
          lastRevision = revision;
        }
        previousState = initializeCatalogDates(history);
      } else if (Object.values(records).some(record => record.publishedAt === undefined)) {
        throw new Error('Catalog dates are missing; use explicit --initialize-dates to recover them from history');
      }
    }
    const snapshotRoot = path.join(scratch, 'source');
    await materializeSource(git, root, sourceCommit, snapshotRoot);
    const generated = await buildCatalog({ root: snapshotRoot, sourceCommit, sourceTime: sourceTimestamp(git, root, sourceCommit), previousState });
    const output = path.join(scratch, 'output');
    await writeCatalog(await attachFontPreviews(generated, { root: snapshotRoot }), output);
    fs.cpSync(output, publishRoot, { recursive: true, errorOnExist: true, force: false });
    git(publishRoot, ['add', '--all']);
    const tree = git(publishRoot, ['write-tree']).output.trim();
    if (priorHead && tree === git(publishRoot, ['rev-parse', `${priorHead}^{tree}`]).output.trim()) {
      return { status: 'unchanged', sourceCommit, catalogCommit: priorHead };
    }
    const args = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit-tree', tree];
    if (priorHead) args.push('-p', priorHead);
    args.push('-m', `更新资源目录 ${sourceCommit.slice(0, 12)}`);
    const catalogCommit = git(publishRoot, args).output.trim();
    if (beforePush) await beforePush({ sourceCommit, priorHead, catalogCommit, publishRoot });
    if (remoteHead(git, publishRoot, 'origin', branch) !== priorHead) {
      throw new Error('Catalog advanced before publication; retry against the new baseline');
    }
    // No force: a race after the final read is rejected by Git's fast-forward rule.
    git(publishRoot, ['push', 'origin', `${catalogCommit}:refs/heads/${branch}`]);
    return { status: 'published', sourceCommit, catalogCommit };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function sourceTimestamp(git, root, sourceCommit) {
  const value = git(root, ['show', '-s', '--format=%cI', sourceCommit]).output.trim();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Source commit has no valid committer timestamp');
  return catalogTimestamp(parsed.toISOString());
}

function parseArguments(args, readOnly = false) {
  const options = {};
  const names = readOnly
    ? { '--root': 'root', '--remote': 'remote', '--branch': 'branch', '--out': 'out' }
    : { '--root': 'root', '--remote': 'remote', '--source-branch': 'sourceBranch', '--branch': 'branch' };
  for (let i = 0; i < args.length;) {
    if (!readOnly && args[i] === '--initialize-dates') {
      if (options.initializeDates) throw new Error('Duplicate --initialize-dates');
      options.initializeDates = true;
      i++;
      continue;
    }
    if (!readOnly && args[i] === '--bootstrap') {
      if (options.allowBootstrap) throw new Error('Duplicate --bootstrap');
      options.allowBootstrap = true;
      i++;
      continue;
    }
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected --root PATH [--remote origin] [--source-branch main] [--branch catalog]');
    if (Object.hasOwn(options, names[args[i]])) throw new Error(`Duplicate argument: ${args[i]}`);
    options[names[args[i]]] = args[i + 1];
    i += 2;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'read-state') {
      const { out, ...options } = parseArguments(process.argv.slice(3), true);
      if (!out) throw new Error('read-state requires --out FILE');
      const result = await readCatalogState(options);
      fs.writeFileSync(out, JSON.stringify(result.state, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ catalogCommit: result.catalogCommit }, null, 2));
    } else {
      console.log(JSON.stringify(await publishCatalog(parseArguments(process.argv.slice(2))), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
