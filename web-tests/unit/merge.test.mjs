import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../web/lib/core.js');
const { createDataModel } = require('../../web/lib/data.js');
const { createMergeModel } = require('../../web/lib/merge.js');

const NOW = 1_700_000_000_000;
const dataModel = createDataModel({
  uid: () => `id-${Math.random().toString(36).slice(2, 8)}`,
  toTimestamp: core.toTimestamp,
  toTombstone: core.toTombstone,
  normalizeUrl: core.normalizeUrl,
  engines: [{ id: 'bing', name: 'Bing', bang: 'b' }, { id: 'google', name: 'Google', bang: 'g' }],
  now: () => NOW,
});
const merge = createMergeModel({
  normalizeData: dataModel.normalizeData,
  normalizeUrl: core.normalizeUrl,
  clone: (value) => JSON.parse(JSON.stringify(value)),
  now: () => NOW,
});

function link(id, title, url, updatedAt, deletedAt = null) {
  return { id, title, url, updatedAt, deletedAt };
}
function group(id, name, updatedAt, links, deletedAt = null) {
  return { id, name, updatedAt, deletedAt, links };
}
function doc(groups, settings = {}) {
  return { version: 2, settings: { name: '', engine: 'bing', customEngines: [], engineOrder: [], updatedAt: 1, ...settings }, groups };
}

test('merge keeps additions from both sides and the newer link', () => {
  const local = doc([group('g1', '本地', 10, [
    link('a', 'A 本地', 'https://a.com', 10),
    link('b', 'B 旧', 'https://b.com', 5),
  ])]);
  const cloud = doc([group('g1', '云端', 20, [
    link('b', 'B 新', 'https://b.com', 20),
    link('c', 'C 云端', 'https://c.com', 20),
  ])]);
  const merged = merge.mergeDocuments(local, cloud);
  const links = merged.groups.flatMap((item) => item.links);
  assert.deepEqual(links.map((item) => item.id).sort(), ['a', 'b', 'c']);
  assert.equal(links.find((item) => item.id === 'b').title, 'B 新');
  assert.equal(merged.groups[0].name, '云端');
});

test('merge lets tombstones win over older edits', () => {
  const older = NOW - 60 * 60 * 1000;
  const deleted = NOW - 30 * 60 * 1000;
  const local = doc([group('g1', 'G', older, [
    link('a', 'A', 'https://a.com', deleted, deleted),
  ])]);
  const cloud = doc([group('g1', 'G', older, [
    link('a', 'A', 'https://a.com', older),
  ])]);
  const merged = merge.mergeDocuments(local, cloud);
  assert.equal(merged.groups[0].links[0].deletedAt, deleted);
});

test('merge deduplicates equal URLs inside a group', () => {
  const local = doc([group('g1', 'G', 10, [
    link('a', 'A', 'https://same.com/', 10),
  ])]);
  const cloud = doc([group('g1', 'G', 20, [
    link('b', 'B', 'https://same.com/', 20),
  ])]);
  const merged = merge.mergeDocuments(local, cloud);
  // 较旧的一条被标记为墓碑，避免同一分组出现重复网址。
  assert.equal(merged.groups[0].links.filter((item) => !item.deletedAt).length, 1);
  assert.equal(merged.groups[0].links.find((item) => !item.deletedAt).title, 'B');
});

test('merge settings take the newer updatedAt', () => {
  const local = doc([], { name: '本地', engine: 'bing', updatedAt: 5 });
  const cloud = doc([], { name: '云端', engine: 'google', updatedAt: 10 });
  const merged = merge.mergeDocuments(local, cloud);
  assert.equal(merged.settings.name, '云端');
  assert.equal(merged.settings.engine, 'google');
  assert.equal(merged.settings.updatedAt, 10);
});

test('merge diff reports one-sided and modified links', () => {
  const local = doc([group('g1', 'G', 10, [
    link('a', 'A', 'https://a.com', 10),
    link('b', 'B 本地', 'https://b.com', 10),
  ])]);
  const cloud = doc([group('g1', 'G', 20, [
    link('b', 'B 云端', 'https://b.com', 20),
    link('c', 'C', 'https://c.com', 20),
  ])]);
  const diff = merge.buildMergeDiff(local, cloud);
  assert.equal(diff.localOnly.length, 1);
  assert.equal(diff.cloudOnly.length, 1);
  assert.equal(diff.modified.length, 1);
});
