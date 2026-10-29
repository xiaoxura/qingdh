import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../web/lib/core.js');
const { createDataModel } = require('../../web/lib/data.js');

const ENGINES = [
  { id: 'bing', name: 'Bing', bang: 'b' },
  { id: 'google', name: 'Google', bang: 'g' },
];

function model(nowValue = 1_700_000_000_000) {
  return createDataModel({
    uid: () => `id-${Math.random().toString(36).slice(2, 8)}`,
    toTimestamp: core.toTimestamp,
    toTombstone: core.toTombstone,
    normalizeUrl: core.normalizeUrl,
    engines: ENGINES,
    now: () => nowValue,
  });
}

test('C1 default navigation data is stable', () => {
  const data = model().createDefaultData();
  assert.equal(data.version, 2);
  assert.equal(data.groups.length, 3);
  assert.equal(data.groups.flatMap((group) => group.links).length, 12);
  assert.equal(data.settings.engine, 'bing');
});

test('C1 normalizeData repairs ids, URLs and settings', () => {
  const data = model().normalizeData({
    version: 2,
    settings: { name: '  小夏  ', engine: 'missing', customEngines: [
      { id: 'c-docs', name: '文档', template: 'https://example.com/?q={query}', bang: 'DOCS' },
      { name: '坏引擎', template: 'ftp://example.com/?q={query}' },
    ], engineOrder: ['c-docs', 'nope'] },
    groups: [
      { id: 'g1', name: ' 常用 ', links: [
        { id: 'l1', title: 'A', url: 'https://example.com' },
        { id: 'l1', title: 'B', url: 'javascript:alert(1)' },
      ] },
      { id: 'g1', name: '重复 id', links: [] },
    ],
  });
  assert.equal(data.settings.name, '小夏');
  assert.equal(data.settings.engine, 'bing');
  assert.equal(data.settings.customEngines.length, 1);
  assert.equal(data.settings.customEngines[0].bang, 'docs');
  assert.deepEqual(data.settings.engineOrder, ['c-docs']);
  assert.equal(new Set(data.groups.map((group) => group.id)).size, 2);
  assert.equal(data.groups[0].links.length, 1);
  assert.equal(data.groups[0].links[0].url, 'https://example.com/');
});

test('C1 tombstones older than 30 days are pruned', () => {
  const nowValue = 1_700_000_000_000;
  const m = model(nowValue);
  const old = nowValue - 31 * 24 * 60 * 60 * 1000;
  const recent = nowValue - 24 * 60 * 60 * 1000;
  const data = m.normalizeData({
    version: 2,
    groups: [
      { id: 'gone', name: '旧', deletedAt: old, links: [] },
      { id: 'fresh', name: '新', deletedAt: recent, links: [] },
      { id: 'live', name: '在', links: [
        { id: 'old-link', title: '旧链接', url: 'https://example.com/old', deletedAt: old },
        { id: 'live-link', title: '新链接', url: 'https://example.com/new', deletedAt: null },
      ] },
    ],
  });
  assert.deepEqual(data.groups.map((group) => group.id).sort(), ['fresh', 'live']);
  assert.deepEqual(data.groups.find((group) => group.id === 'live').links.map((link) => link.id), ['live-link']);
});

test('C1 count helpers ignore tombstones', () => {
  const m = model();
  const data = m.normalizeData({
    version: 2,
    groups: [
      { id: 'g1', name: 'A', links: [
        { id: 'l1', title: 'A', url: 'https://a.com' },
        { id: 'l2', title: 'B', url: 'https://b.com', deletedAt: Date.now() },
      ] },
      { id: 'g2', name: 'B', deletedAt: Date.now(), links: [] },
    ],
  });
  assert.equal(m.countLinks(data), 1);
  assert.equal(m.countGroups(data), 1);
});
