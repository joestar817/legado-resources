#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { readPetPlugin } from './pet-plugins.mjs';
import { attachFontPreviews, readPreviewFiles, validatePreviewFiles } from './font-previews.mjs';

const TYPES = Object.freeze({ fonts: 'font', backgrounds: 'background', tts: 'tts', themes: 'theme', pets: 'pet' });
const PURPOSE_BY_TYPE = Object.freeze({ font: 'reading', background: 'reading', theme: 'appearance', tts: 'listening', pet: 'pets' });
const PURPOSE_IDS = new Set([...Object.values(PURPOSE_BY_TYPE), 'pets']);
const RESOURCE_ROOT = 'resources';
const FORMATS = Object.freeze({
  font: ['ttf', 'otf'], background: ['png', 'jpg', 'jpeg', 'webp'],
  tts: ['js'], theme: ['ngtheme', 'zip'], pet: ['ngpet'],
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const HASH = /^[a-f0-9]{64}$/i;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCES = 10000;
const EMPTY_COMMIT = '0'.repeat(40);

function fail(message) { throw new Error(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function fields(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: unsupported field ${key}`);
}
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) {
    fail(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}
function optionalText(value, label, max) {
  return value === undefined ? undefined : text(value, label, max);
}
function catalogPurposes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > PURPOSE_IDS.size) fail('purposes must list one to four supported purposes');
  const seen = new Set();
  return value.map(purpose => {
    fields(purpose, ['id', 'name'], 'purpose');
    if (!PURPOSE_IDS.has(purpose.id) || seen.has(purpose.id)) fail('Unsupported or duplicate purpose');
    seen.add(purpose.id);
    return { id: purpose.id, name: text(purpose.name, 'purpose.name', 64) };
  });
}
function categoryPurpose(category, purposes) {
  if (purposes === undefined) {
    if (category.purpose !== undefined) fail('category.purpose requires catalog purposes');
    return {};
  }
  if (!purposes.some(purpose => purpose.id === category.purpose)) fail('category.purpose must reference a declared purpose');
  if (PURPOSE_BY_TYPE[category.type] !== category.purpose) fail('category.purpose does not match the supported type mapping');
  return { purpose: category.purpose };
}
function identifier(value, label) {
  const result = text(value, label, 160);
  if (!ID.test(result)) fail(`${label} contains invalid characters`);
  return result;
}
function commit(value, label = 'sourceCommit') {
  if (typeof value !== 'string' || !COMMIT.test(value)) fail(`${label} must be a full Git commit hash`);
  return value.toLowerCase();
}
function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be SHA-256`);
  return value.toLowerCase();
}
function strings(value, label, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} must be an array of at most ${maxItems} strings`);
  const result = value.map((item, i) => text(item, `${label}[${i}]`, maxLength));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return result;
}
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => createHash('sha256').update(value).digest('hex');

async function lstatOrNull(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ordinary(filename, kind) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    fail(`${filename} must be a regular ${kind}, not a link`);
  }
  return stat;
}
async function readJson(filename, max = MAX_JSON_BYTES) {
  const stat = await ordinary(filename, 'file');
  if (stat.size > max) fail(`${filename} exceeds the JSON size limit`);
  const source = await fs.readFile(filename, 'utf8');
  if (Buffer.byteLength(source) > max) fail(`${filename} exceeds the JSON size limit`);
  try { return JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { fail(`${filename} is not valid JSON`); }
}
function relativePath(value, category) {
  const result = text(value, 'payload.path', 1024);
  if (value !== result || result.includes('\\') || path.posix.isAbsolute(result) || path.win32.isAbsolute(result)) {
    fail('payload.path must be a repository-relative POSIX path');
  }
  const parts = result.split('/');
  if (parts[0] !== RESOURCE_ROOT || parts[1] !== category || parts.length < 3) {
    fail(`payload.path must stay inside ${RESOURCE_ROOT}/${category}/`);
  }
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\x00-\x1F\x7F<>:"|?*]/.test(part)
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      fail('payload.path contains an unsafe path segment');
    }
  }
  return result;
}
async function safePayload(root, relative) {
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    await ordinary(current, i === parts.length - 1 ? 'file' : 'directory');
  }
  const real = await fs.realpath(current);
  const relation = path.relative(root, real);
  if (relation.startsWith(`..${path.sep}`) || relation === '..' || path.isAbsolute(relation)) fail('payload escapes the repository');
  return current;
}
async function metadataFiles(directory, depth = 0) {
  if (depth > 24) fail('Resource directory nesting is too deep');
  await ordinary(directory, 'directory');
  const results = [];
  const names = sorted(await fs.readdir(directory));
  const foldedNames = new Set();
  for (const name of names) {
    const folded = name.toLowerCase();
    if (foldedNames.has(folded)) fail(`Case-only resource path collision in ${directory}`);
    foldedNames.add(folded);
    const filename = path.join(directory, name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) fail(`Resource links are not allowed: ${filename}`);
    if (stat.isDirectory()) results.push(...await metadataFiles(filename, depth + 1));
    else if (!stat.isFile()) fail(`Unsupported resource filesystem entry: ${filename}`);
    else if (name.endsWith('.resource.json')) results.push(filename);
    if (results.length > MAX_RESOURCES) fail('Too many resource metadata files');
  }
  return results;
}
async function payloadDigest(filename, readScriptMetadata = false) {
  const handle = await fs.open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail('Payload is not a regular file');
    if (!Number.isSafeInteger(before.size) || before.size < 1) fail('Payload must be a non-empty file');
    const sha = createHash('sha256');
    const prefixParts = [];
    let prefixLength = 0;
    let size = 0;
    const metadata = readScriptMetadata ? Object.create(null) : null;
    const decoder = readScriptMetadata ? new StringDecoder('utf8') : null;
    let pendingLine = '';
    function consumeScriptText(value, final = false) {
      if (!metadata) return;
      const lines = (pendingLine + value).split(/\r\n|[\r\n\u0085\u2028\u2029]/);
      pendingLine = final ? '' : lines.pop();
      for (const line of lines) readScriptMetadataLine(metadata, line);
    }
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      sha.update(chunk);
      size += chunk.length;
      if (prefixLength < 65536) {
        const part = chunk.subarray(0, 65536 - prefixLength);
        prefixParts.push(part);
        prefixLength += part.length;
      }
      if (decoder) consumeScriptText(decoder.write(chunk));
    }
    if (decoder) consumeScriptText(decoder.end(), true);
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail('Payload changed while its digest was calculated');
    }
    const prefix = Buffer.concat(prefixParts).toString('utf8').replace(/^\uFEFF/, '');
    if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/.test(prefix)) {
      fail(`Unresolved Git LFS pointer: ${filename}`);
    }
    if (metadata) identifier(metadata.uuid, 'TTS @uuid');
    return { size, sha256: sha.digest('hex'), metadata };
  } finally { await handle.close(); }
}
function readScriptMetadataLine(data, line) {
  // NG scans metadata throughout the script, including comments after executable code.
  // Match that grammar without evaluating JavaScript, then reject ambiguous redefinitions.
  const match = line.match(/^\s*\/\/\s*@([A-Za-z][\w-]*)\s*(.*)$/);
  if (!match) return;
  const key = match[1].toLowerCase();
  if (!['name', 'author', 'version', 'uuid', 'description'].includes(key)) return;
  if (Object.hasOwn(data, key)) fail(`Duplicate TTS metadata @${key}`);
  data[key] = match[2].trim();
}
function requirements(value) {
  if (value === undefined) return undefined;
  fields(value, ['minAppVersionCode', 'capabilities'], 'requirements');
  const result = {};
  if (value.minAppVersionCode !== undefined) {
    if (!Number.isSafeInteger(value.minAppVersionCode) || value.minAppVersionCode < 1) fail('requirements.minAppVersionCode must be a positive safe integer');
    result.minAppVersionCode = value.minAppVersionCode;
  }
  if (value.capabilities !== undefined) result.capabilities = sorted(strings(value.capabilities, 'requirements.capabilities', 128, 128));
  return result;
}
function verification(value) {
  if (value === undefined) return undefined;
  fields(value, ['checkedOn', 'status', 'note'], 'verification');
  const result = {};
  if (value.checkedOn !== undefined) {
    const date = text(value.checkedOn, 'verification.checkedOn', 10);
    const parsed = new Date(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('verification.checkedOn must be an ISO date');
    result.checkedOn = date;
  }
  if (value.status !== undefined) result.status = text(value.status, 'verification.status', 128);
  if (value.note !== undefined) result.note = text(value.note, 'verification.note', 5000);
  return result;
}
export function catalogTimestamp(value, label = 'sourceTime') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(`${label} must be an ISO UTC timestamp`);
  const parsed = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== canonical) fail(`${label} must be a valid ISO UTC timestamp`);
  return canonical;
}
function recordDates(record, label) {
  if (record.publishedAt === undefined && record.updatedAt === undefined) return {};
  const publishedAt = catalogTimestamp(record.publishedAt, `${label}.publishedAt`);
  const updatedAt = catalogTimestamp(record.updatedAt, `${label}.updatedAt`);
  if (updatedAt < publishedAt) fail(`${label}.updatedAt precedes publishedAt`);
  return { publishedAt, updatedAt };
}
export function checkState(value) {
  if (value === null || value === undefined) return null;
  fields(value, ['schemaVersion', 'sourceCommit', 'resources'], 'state');
  if (value.schemaVersion !== 1) fail('Unsupported state.schemaVersion');
  commit(value.sourceCommit, 'state.sourceCommit');
  object(value.resources, 'state.resources');
  if (Object.keys(value.resources).length > MAX_RESOURCES * 10) fail('Version history is too large');
  const result = Object.create(null);
  const foldedIds = new Set();
  const engineIds = new Set();
  const pluginIds = new Set();
  for (const id of sorted(Object.keys(value.resources))) {
    if (identifier(id, 'state resource ID') !== id) fail('Historical resource IDs must not contain surrounding whitespace');
    if (foldedIds.has(id.toLowerCase())) fail('Case-only resource ID collision in state');
    foldedIds.add(id.toLowerCase());
    const record = value.resources[id];
    fields(record, ['type', 'versionCode', 'fingerprint', 'active', 'engineId', 'pluginId', 'publishedAt', 'updatedAt'], `state.resources.${id}`);
    if (!Object.values(TYPES).includes(record.type)) fail(`Invalid historical type for ${id}`);
    if (!Number.isSafeInteger(record.versionCode) || record.versionCode < 1) fail(`Invalid historical version for ${id}`);
    if (typeof record.active !== 'boolean') fail(`Invalid historical active state for ${id}`);
    result[id] = { type: record.type, versionCode: record.versionCode, fingerprint: hash(record.fingerprint, `${id} fingerprint`), active: record.active, ...recordDates(record, id) };
    if (record.type === 'tts') {
      const engineId = identifier(record.engineId, `${id} historical engine ID`);
      if (engineIds.has(engineId)) fail(`Duplicate historical TTS engine ID ${engineId}`);
      engineIds.add(engineId);
      result[id].engineId = engineId;
    }
    else if (record.engineId !== undefined) fail(`Unexpected engineId on ${id}`);
    if (record.type === 'pet') {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(record.pluginId)) fail(`Invalid pluginId on ${id}`);
      if (pluginIds.has(record.pluginId)) fail('Duplicate historical pet plugin identity');
      pluginIds.add(record.pluginId);
      result[id].pluginId = record.pluginId;
    } else if (record.pluginId !== undefined) fail(`Unexpected pluginId on ${id}`);
  }
  return result;
}

/** Explicitly recover dates from the complete, oldest-first published state history. No files or refs are changed. */
export function initializeCatalogDates(history) {
  if (!Array.isArray(history) || !history.length || history.length > 100000) fail('A complete catalog history is required to initialize dates');
  let previous = Object.create(null);
  let lastState;
  for (const entry of history) {
    const sourceTime = catalogTimestamp(entry.sourceTime);
    const current = checkState(entry.state);
    if (!current) fail('Historical catalog state is missing');
    for (const id of Object.keys(previous)) if (!Object.hasOwn(current, id)) fail(`Catalog history lost resource ${id}`);
    for (const [id, record] of Object.entries(current)) {
      const prior = previous[id];
      const changed = prior && prior.fingerprint !== record.fingerprint;
      if (!prior) {
        if (record.versionCode !== 1 || !record.active) fail(`Catalog history is incomplete for ${id}`);
      } else {
        if (prior.type !== record.type || prior.engineId !== record.engineId || prior.pluginId !== record.pluginId) fail(`Catalog history changed identity for ${id}`);
        if (record.versionCode !== prior.versionCode + (changed ? 1 : 0) || (changed && !record.active)) fail(`Catalog history has inconsistent versions for ${id}`);
        if (changed && sourceTime < prior.updatedAt) fail(`Source time moved backwards for ${id}`);
      }
      const dates = { publishedAt: prior?.publishedAt ?? sourceTime, updatedAt: !prior || changed ? sourceTime : prior.updatedAt };
      if (record.publishedAt !== undefined && (record.publishedAt !== dates.publishedAt || record.updatedAt !== dates.updatedAt)) fail(`Catalog history has inconsistent dates for ${id}`);
      current[id] = { ...record, ...dates };
    }
    previous = current;
    lastState = entry.state;
  }
  return { ...lastState, resources: previous };
}

/** Read resources without evaluating code. Omit sourceTime only for validation, never publication. */
export async function buildCatalog({ root, sourceCommit, sourceTime, previousState = null }) {
  if (typeof root !== 'string' || !root) fail('root is required');
  await ordinary(path.resolve(root), 'directory');
  root = await fs.realpath(path.resolve(root));
  sourceCommit = commit(sourceCommit);
  const previous = checkState(previousState);
  if (sourceTime !== undefined) {
    sourceTime = catalogTimestamp(sourceTime);
    if (Object.values(previous || {}).some(record => record.publishedAt === undefined)) fail('Catalog dates are missing; publish with explicit --initialize-dates first');
  }
  const config = await readJson(path.join(root, 'catalog.config.json'));
  fields(config, ['schemaVersion', 'purposes', 'categories'], 'catalog.config');
  if (config.schemaVersion !== 1) fail('Unsupported catalog.config.schemaVersion');
  if (!Array.isArray(config.categories) || !config.categories.length || config.categories.length > Object.keys(TYPES).length) fail('categories must list supported categories');
  const categoryIds = new Set();
  const purposes = catalogPurposes(config.purposes);
  const categories = config.categories.map(category => {
    fields(category, ['id', 'name', 'type', 'purpose'], 'category');
    if (!Object.hasOwn(TYPES, category.id) || TYPES[category.id] !== category.type) fail('Unsupported category/type mapping');
    if (categoryIds.has(category.id)) fail(`Duplicate category ${category.id}`);
    categoryIds.add(category.id);
    return { id: category.id, name: text(category.name, 'category.name', 64), type: category.type,
      ...categoryPurpose(category, purposes) };
  });
  const stateResources = Object.create(null);
  for (const id of Object.keys(previous || {})) stateResources[id] = { ...previous[id], active: false };
  const seenIds = new Set();
  const foldedIds = new Map(Object.keys(previous || {}).map(id => [id.toLowerCase(), id]));
  const seenPayloads = new Set();
  const seenEngineIds = new Set();
  const seenPluginIds = new Set();
  const pluginOwners = new Map(Object.entries(previous || {}).filter(([, record]) => record.type === 'pet').map(([id, record]) => [record.pluginId, id]));
  const engineOwners = new Map(Object.entries(previous || {}).filter(([, record]) => record.type === 'tts').map(([id, record]) => [record.engineId, id]));
  const indexes = Object.create(null);
  const catalogCategories = [];
  const resourceRoot = path.join(root, RESOURCE_ROOT);
  await ordinary(resourceRoot, 'directory');
  for (const category of categories) {
    const directory = path.join(resourceRoot, category.id);
    const present = await lstatOrNull(directory);
    const resources = [];
    for (const metadataFile of present ? await metadataFiles(directory) : []) {
      const meta = await readJson(metadataFile);
      fields(meta, ['schemaVersion', 'id', 'name', 'author', 'description', 'license', 'versionName', 'payload', 'requirements', 'changelog', 'tags', 'verification'], metadataFile);
      if (meta.schemaVersion !== 1) fail(`Unsupported resource schema in ${metadataFile}`);
      const id = identifier(meta.id, 'resource.id');
      if (seenIds.has(id)) fail(`Duplicate resource ID ${id}`);
      const sameCaseInsensitive = foldedIds.get(id.toLowerCase());
      if (sameCaseInsensitive !== undefined && sameCaseInsensitive !== id) fail(`Case-only resource ID collision for ${id}`);
      foldedIds.set(id.toLowerCase(), id);
      seenIds.add(id);
      if (seenIds.size > MAX_RESOURCES) fail('Too many resources');
      fields(meta.payload, ['path', 'format', 'pluginId'], `${id}.payload`);
      const relative = relativePath(meta.payload.path, category.id);
      const collisionKey = relative.toLowerCase();
      if (seenPayloads.has(collisionKey)) fail(`Payload path used by multiple resources: ${relative}`);
      seenPayloads.add(collisionKey);
      const format = text(meta.payload.format, 'payload.format', 16);
      if (!FORMATS[category.type].includes(format) || path.posix.extname(relative).toLowerCase() !== `.${format}`) fail(`Payload format/extension mismatch for ${id}`);
      const filename = await safePayload(root, relative);
      const file = await payloadDigest(filename, category.type === 'tts');
      const pet = category.type === 'pet' ? await readPetPlugin(filename) : null;
      if (pet && meta.payload.pluginId !== pet.id) fail('Pet plugin identity mismatch');
      if (!pet && meta.payload.pluginId !== undefined) fail('Unexpected pluginId');
      if (pet && seenPluginIds.has(pet.id)) fail('Duplicate pet plugin identity');
      if (pet && pluginOwners.has(pet.id) && pluginOwners.get(pet.id) !== id) fail('Pet plugin identity belongs to another resource');
      if (pet) seenPluginIds.add(pet.id);
      const header = file.metadata;
      if (header) {
        if (seenEngineIds.has(header.uuid)) fail(`Duplicate TTS engine ID ${header.uuid}`);
        if (engineOwners.has(header.uuid) && engineOwners.get(header.uuid) !== id) fail(`TTS engine ID ${header.uuid} belongs to a different resource`);
        seenEngineIds.add(header.uuid);
      }
      const payload = { path: relative, format, size: file.size, sha256: file.sha256 };
      if (header) payload.engineId = header.uuid;
      if (pet) payload.pluginId = pet.id;
      const fingerprint = digest(JSON.stringify({ type: category.type, format, sha256: file.sha256, ...(header ? { engineId: header.uuid } : {}), ...(pet ? { pluginId: pet.id } : {}) }));
      const prior = previous?.[id];
      if (prior && prior.type !== category.type) fail(`Resource ${id} cannot change type`);
      if (prior?.type === 'tts' && prior.engineId !== header.uuid) fail(`Resource ${id} cannot change its TTS engine ID`);
      const versionCode = prior ? prior.versionCode + (prior.fingerprint === fingerprint ? 0 : 1) : 1;
      if (pet && prior && prior.pluginId !== pet.id) fail('Pet plugin cannot change identity');
      if (pet && pet.versionCode !== versionCode) fail('Pet plugin version must match catalog version');
      if (!Number.isSafeInteger(versionCode)) fail(`Version overflow for ${id}`);
      let dates = {};
      if (prior?.publishedAt !== undefined && prior.fingerprint === fingerprint) dates = recordDates(prior, id);
      else if (sourceTime !== undefined) {
        if (prior && sourceTime < prior.updatedAt) fail(`Source time moved backwards for ${id}`);
        dates = { publishedAt: prior?.publishedAt ?? sourceTime, updatedAt: sourceTime };
      }
      const resource = {
        id,
        name: text(meta.name ?? header?.name, `${id}.name`, 256),
        author: text(meta.author ?? header?.author, `${id}.author`, 256),
        versionCode,
        ...dates,
        payload,
      };
      const optionals = {
        license: optionalText(meta.license, `${id}.license`, 256),
        description: optionalText(meta.description ?? header?.description, `${id}.description`, 5000),
        versionName: optionalText(meta.versionName ?? header?.version, `${id}.versionName`, 128),
        requirements: requirements(meta.requirements),
        changelog: optionalText(meta.changelog, `${id}.changelog`, 10000),
        tags: meta.tags === undefined ? undefined : strings(meta.tags, `${id}.tags`, 32, 64),
        verification: verification(meta.verification),
      };
      for (const [key, value] of Object.entries(optionals)) if (value !== undefined) resource[key] = value;
      resources.push(resource);
      stateResources[id] = { type: category.type, versionCode, fingerprint, active: true, ...dates };
      if (header) stateResources[id].engineId = header.uuid;
      if (pet) stateResources[id].pluginId = pet.id;
    }
    resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    indexes[category.id] = { schemaVersion: 1, sourceCommit, type: category.type, resources };
    catalogCategories.push({ ...category, index: `${RESOURCE_ROOT}/${category.id}/index.json`, count: resources.length });
  }
  const orderedState = Object.create(null);
  for (const id of sorted(Object.keys(stateResources))) orderedState[id] = stateResources[id];
  return {
    catalog: { schemaVersion: 1, sourceCommit, ...(purposes === undefined ? {} : { purposes }), categories: catalogCategories },
    indexes,
    state: { schemaVersion: 1, sourceCommit, resources: orderedState },
  };
}

async function checkOutputDirectory(directory) {
  const exists = await lstatOrNull(directory);
  if (!exists) return;
  await ordinary(directory, 'directory');
  const names = await fs.readdir(directory);
  if (!names.length) return;
  if (!names.includes('catalog.json') || !names.includes('state.json')) fail('Refusing to replace a non-catalog output directory');
  const oldState = await readJson(path.join(directory, 'state.json'), MAX_STATE_BYTES);
  checkState(oldState);
  const oldCatalog = await readJson(path.join(directory, 'catalog.json'));
  fields(oldCatalog, ['schemaVersion', 'sourceCommit', 'purposes', 'categories'], 'existing output catalog');
  if (oldCatalog.schemaVersion !== 1 || !Array.isArray(oldCatalog.categories)) fail('Existing output catalog is invalid');
  const purposes = catalogPurposes(oldCatalog.purposes);
  for (const category of oldCatalog.categories) categoryPurpose(category, purposes);
  if (commit(oldCatalog.sourceCommit) !== commit(oldState.sourceCommit)) fail('Existing output has inconsistent commits');
  const oldIndexes = Object.create(null);
  for (const name of names) {
    const item = path.join(directory, name);
    if (name === 'catalog.json' || name === 'state.json') { await ordinary(item, 'file'); continue; }
    if (name === 'previews') { await ordinary(item, 'directory'); continue; }
    if (name !== RESOURCE_ROOT) fail(`Refusing to replace output containing ${name}`);
    await ordinary(item, 'directory');
    for (const category of await fs.readdir(item)) {
      if (!Object.hasOwn(TYPES, category)) fail(`Refusing to replace output containing ${name}/${category}`);
      const categoryDirectory = path.join(item, category);
      await ordinary(categoryDirectory, 'directory');
      const children = await fs.readdir(categoryDirectory);
      if (children.length !== 1 || children[0] !== 'index.json') fail('Refusing to replace output with non-generated category files');
      const index = await readJson(path.join(categoryDirectory, 'index.json'), MAX_STATE_BYTES);
      if (index.schemaVersion !== 1 || index.type !== TYPES[category] || index.sourceCommit !== oldCatalog.sourceCommit) fail('Existing output index is inconsistent');
      oldIndexes[category] = index;
    }
  }
  const expectedCategories = oldCatalog.categories.map(category => category.id).sort();
  if (JSON.stringify(expectedCategories) !== JSON.stringify(Object.keys(oldIndexes).sort())) fail('Existing output categories are incomplete');
  validatePreviewFiles(oldIndexes, await readPreviewFiles(path.join(directory, 'previews')));
}

/** Publish a complete generated directory locally; never delete arbitrary existing files. */
export async function writeCatalog(result, outDir) {
  object(result, 'result');
  if (typeof outDir !== 'string' || !outDir) fail('outDir is required');
  const target = path.resolve(outDir);
  const parent = path.dirname(target);
  if (target === parent) fail('Output cannot be a filesystem root');
  checkState(result.state);
  object(result.catalog, 'catalog');
  if (result.catalog.sourceCommit !== result.state.sourceCommit) fail('Generated catalog/state commits differ');
  object(result.indexes, 'indexes');
  for (const [category, index] of Object.entries(result.indexes)) {
    if (!Object.hasOwn(TYPES, category) || index?.type !== TYPES[category] || index.sourceCommit !== result.state.sourceCommit) fail('Invalid generated index');
  }
  const previewFiles = validatePreviewFiles(result.indexes, result.previewFiles);
  await fs.mkdir(parent, { recursive: true });
  const parentReal = await fs.realpath(parent);
  if (path.resolve(parentReal) !== path.resolve(parent)) fail('Output parent must not contain symbolic links');
  await checkOutputDirectory(target);
  const stage = await fs.mkdtemp(path.join(parent, '.catalog-stage-'));
  let backup = null;
  let stageMoved = false;
  try {
    await fs.writeFile(path.join(stage, 'catalog.json'), json(result.catalog), { flag: 'wx' });
    await fs.writeFile(path.join(stage, 'state.json'), json(result.state), { flag: 'wx' });
    await fs.mkdir(path.join(stage, RESOURCE_ROOT));
    for (const category of sorted(Object.keys(result.indexes))) {
      await fs.mkdir(path.join(stage, RESOURCE_ROOT, category));
      await fs.writeFile(path.join(stage, RESOURCE_ROOT, category, 'index.json'), json(result.indexes[category]), { flag: 'wx' });
    }
    if (Object.keys(previewFiles).length) {
      await fs.mkdir(path.join(stage, 'previews'));
      for (const filename of sorted(Object.keys(previewFiles))) {
        await fs.writeFile(path.join(stage, filename), previewFiles[filename], { flag: 'wx' });
      }
    }
    // Revalidate immediately before replacement, after all serialisation and writes succeeded.
    await checkOutputDirectory(target);
    if (await lstatOrNull(target)) {
      backup = await fs.mkdtemp(path.join(parent, '.catalog-backup-'));
      await fs.rmdir(backup);
      await fs.rename(target, backup);
    }
    try { await fs.rename(stage, target); stageMoved = true; }
    catch (error) {
      if (backup) { await fs.rename(backup, target); backup = null; }
      throw error;
    }
    if (backup) {
      // backup was created in this parent from a fully validated generated directory.
      // The new output is already installed. Cleanup failure must not report a failed publication.
      await fs.rm(backup, { recursive: true }).catch(error => {
        process.stderr.write(`Catalog cleanup warning: retained previous output at ${backup}: ${error.message}\n`);
      });
      backup = null;
    }
  } finally {
    if (!stageMoved) await fs.rm(stage, { recursive: true, force: true });
  }
}

async function main(args) {
  const command = args.shift();
  if (!['validate', 'generate'].includes(command)) fail('Usage: catalog.mjs validate --root PATH [--state FILE] | generate --root PATH --source-commit SHA --source-time ISO_UTC [--state FILE] --out PATH');
  const options = Object.create(null);
  const allowed = command === 'validate' ? ['--root', '--state'] : ['--root', '--source-commit', '--source-time', '--state', '--out'];
  while (args.length) {
    const option = args.shift();
    if (!allowed.includes(option) || Object.hasOwn(options, option) || !args.length || args[0].startsWith('--')) fail(`Invalid CLI option: ${option}`);
    options[option] = args.shift();
  }
  if (!options['--root']) fail('--root is required');
  if (command === 'generate' && (!options['--source-commit'] || !options['--source-time'] || !options['--out'])) fail('generate requires --source-commit, --source-time and --out');
  const previousState = options['--state'] ? await readJson(path.resolve(options['--state']), MAX_STATE_BYTES) : null;
  if (options['--state']) object(previousState, 'Explicit state file');
  const result = await buildCatalog({ root: options['--root'], sourceCommit: options['--source-commit'] || EMPTY_COMMIT, sourceTime: options['--source-time'], previousState });
  if (command === 'generate') await writeCatalog(await attachFontPreviews(result, { root: options['--root'] }), options['--out']);
  const count = result.catalog.categories.reduce((sum, category) => sum + category.count, 0);
  process.stdout.write(`${command === 'validate' ? 'Validated' : 'Generated'} ${count} resources in ${result.catalog.categories.length} categories.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Catalog error: ${error.message}\n`); process.exitCode = 1; });
}
