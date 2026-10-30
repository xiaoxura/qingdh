import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../web/js/lib/core.js');
const { createDataModel } = require('../../web/js/lib/data.js');
const { create } = require('../../web/js/lib/settings.js');

const ENGINES = [
  { id: 'bing', name: 'Bing', bang: 'b' },
  { id: 'google', name: 'Google', bang: 'g' },
];
const dataModel = createDataModel({
  uid: () => `id-${Math.random().toString(36).slice(2, 8)}`,
  toTimestamp: core.toTimestamp,
  toTombstone: core.toTombstone,
  normalizeUrl: core.normalizeUrl,
  engines: ENGINES,
  now: () => 1_700_000_000_000,
});

function makeSettings({ data = { version: 2, settings: {}, groups: [] } } = {}) {
  return create({
    ENGINES,
    MAX_GROUPS: 50,
    MAX_LINKS: 500,
    normalizeData: dataModel.normalizeData,
    normalizeLink: dataModel.normalizeLink,
    normalizeUrl: core.normalizeUrl,
    clone: (value) => JSON.parse(JSON.stringify(value)),
    now: () => 1_700_000_000_000,
    countGroups: dataModel.countGroups,
    countLinks: dataModel.countLinks,
    getData: () => data,
    setData: (next) => {
      data = next;
    },
  });
}

const validDoc = {
  version: 2,
  settings: { name: '小夏', engine: 'bing' },
  groups: [
    { id: 'g1', name: '常用', links: [{ id: 'l1', title: 'GitHub', url: 'https://github.com/' }] },
  ],
};

test('C1 JSON import validation accepts a valid v2 document', () => {
  const settings = makeSettings();
  assert.equal(settings.validateJSONImport(validDoc), '');
});

test('C1 JSON import validation rejects versions, duplicate ids and bad URLs', () => {
  const settings = makeSettings();
  assert.match(settings.validateJSONImport({ ...validDoc, version: 3 }), /版本/);
  assert.match(
    settings.validateJSONImport({
      ...validDoc,
      groups: [{ id: 'g1', name: 'G', links: [
        { id: 'l1', title: 'A', url: 'https://a.com/' },
        { id: 'l1', title: 'B', url: 'https://b.com/' },
      ] }],
    }),
    /id/
  );
  assert.match(
    settings.validateJSONImport({
      ...validDoc,
      groups: [{ id: 'g1', name: 'G', links: [{ id: 'l1', title: 'A', url: 'javascript:alert(1)' }] }],
    }),
    /链接地址/
  );
  assert.match(
    settings.validateJSONImport({ ...validDoc, settings: { engine: 'missing' } }),
    /默认搜索引擎/
  );
});

test('C1 JSON import plan merges without duplicating URLs', () => {
  const current = {
    version: 2,
    settings: { name: '', engine: 'bing', customEngines: [], engineOrder: [], updatedAt: 1 },
    groups: [
      { id: 'g1', name: '常用', updatedAt: 1, deletedAt: null, links: [
        { id: 'l1', title: 'GitHub', url: 'https://github.com/', icon: '', updatedAt: 1, deletedAt: null },
      ] },
    ],
  };
  const settings = makeSettings({ data: current });
  const plan = settings.planJSONImport(
    {
      version: 2,
      settings: {},
      groups: [
        { id: 'g1', name: '常用', links: [
          { id: 'l2', title: 'GitHub again', url: 'https://github.com' },
          { id: 'l3', title: 'MDN', url: 'https://developer.mozilla.org/' },
        ] },
      ],
    },
    'merge'
  );
  assert.equal(plan.addedGroups, 0);
  assert.equal(plan.addedLinks, 1);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.next.groups.length, 1);
});
