import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../web/lib/core.js');
const { createRenderer } = require('../../web/lib/render.js');

function makeRenderer({ prefs = {}, state = {} } = {}) {
  return createRenderer({
    escapeHTML: core.escapeHTML,
    hostOf: core.hostOf,
    faviconOf: core.faviconOf,
    hueOf: (value) => String(value).length,
    glyphOf: (link) => (link.title || '?').slice(0, 1),
    directFaviconOf: (url) => `${url.replace(/\/.*$/, '')}/favicon.ico`,
    icons: { plus: '+', x: 'x' },
    getPrefs: () => prefs,
    getState: () => state,
  });
}

test('C1 links are escaped and deleted links are skipped', () => {
  const renderer = makeRenderer();
  assert.equal(renderer.renderLink({ id: 'l1', title: 'x', url: 'https://e.com/', deletedAt: 1 }), '');

  const html = renderer.renderLink({
    id: 'l1',
    title: '<script>alert(1)</script>',
    url: 'https://e.com/?a=1&b=2',
    deletedAt: null,
  });
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('a=1&amp;b=2'));
  assert.ok(!html.includes('<script>'));
});

test('C1 batch mode renders a checked checkbox only for selected links', () => {
  const state = { batchMode: true, batchSelected: new Set(['l1']) };
  const renderer = makeRenderer({ state });
  const selected = renderer.renderLink({ id: 'l1', title: 'a', url: 'https://e.com/', deletedAt: null });
  const other = renderer.renderLink({ id: 'l2', title: 'b', url: 'https://e.com/', deletedAt: null });
  assert.ok(selected.includes('is-batch-selected') && selected.includes('data-batch-toggle="l1" checked'));
  assert.ok(!other.includes('checked'));
});

test('C1 groups honour collapse state and hide tombstones', () => {
  const prefs = { collapsedGroups: { g1: true } };
  const renderer = makeRenderer({ prefs, state: { editing: false } });
  const html = renderer.renderGroup({
    id: 'g1',
    name: '常用',
    deletedAt: null,
    links: [
      { id: 'l1', title: 'A', url: 'https://e.com/', deletedAt: null },
      { id: 'l2', title: 'B', url: 'https://e.com/', deletedAt: 1 },
    ],
  });
  assert.ok(html.includes('is-collapsed'));
  assert.ok(html.includes('data-link-id="l1"'));
  assert.ok(!html.includes('data-link-id="l2"'));

  const groups = renderer.renderGroups([
    { id: 'g2', name: '删除', deletedAt: 2, links: [] },
    { id: 'g3', name: '保留', deletedAt: null, links: [] },
  ]);
  assert.ok(groups.includes('data-group-id="g3"'));
  assert.ok(!groups.includes('data-group-id="g2"'));
});

test('C1 empty groups show the placeholder', () => {
  const renderer = makeRenderer();
  const html = renderer.renderGroup({ id: 'g', name: '空', deletedAt: null, links: [] });
  assert.ok(html.includes('暂无链接'));
});
