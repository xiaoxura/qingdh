import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../web/lib/core.js');

test('escapeHTML escapes every dangerous character', () => {
  assert.equal(core.escapeHTML(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(core.escapeHTML(null), 'null');
});

test('normalizeUrl accepts http(s), localhost and bare domains', () => {
  assert.equal(core.normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(core.normalizeUrl('http://example.com/a?b=1'), 'http://example.com/a?b=1');
  assert.equal(core.normalizeUrl('localhost:8080/x'), 'http://localhost:8080/x');
  assert.equal(core.normalizeUrl('example.com', { allowShortHost: true }), 'https://example.com/');
});

test('normalizeUrl rejects scripts, credentials and malformed hosts', () => {
  assert.equal(core.normalizeUrl('javascript:alert(1)'), '');
  assert.equal(core.normalizeUrl('https://user:pass@example.com'), '');
  assert.equal(core.normalizeUrl('https://exa mple.com'), '');
  assert.equal(core.normalizeUrl('intranet', { allowShortHost: false }), '');
});

test('isURL recognises addresses without a scheme', () => {
  assert.equal(core.isURL('github.com'), true);
  assert.equal(core.isURL('localhost:3000'), true);
  assert.equal(core.isURL('hello world'), false);
});

test('hostOf strips www and rejects invalid URLs', () => {
  assert.equal(core.hostOf('https://www.example.com/a'), 'example.com');
  assert.equal(core.hostOf('not a url'), '');
});

test('faviconOf always points at the same-origin proxy', () => {
  assert.equal(core.faviconOf('https://example.com/page'), '/api/favicon?u=https%3A%2F%2Fexample.com');
  assert.equal(core.faviconOf('file:///etc/passwd'), '');
});

test('timestamp helpers reject non-positive values', () => {
  assert.equal(core.toTimestamp('12'), 12);
  assert.equal(core.toTimestamp(-1), 0);
  assert.equal(core.toTombstone(0), null);
  assert.equal(core.toTombstone('5'), 5);
});

/* ------------------------------------------------------------------ *
 * B1：限额保留最新数据，且不会让后面的分组饿死
 * ------------------------------------------------------------------ */

function makeLink(id, updatedAt, deletedAt = null) {
  return { id, title: id, url: `https://example.com/${id}`, updatedAt, deletedAt };
}

function makeGroup(id, updatedAt, links, deletedAt = null) {
  return { id, name: id, updatedAt, deletedAt, links };
}

function linksOf(document) {
  return document.groups.flatMap((group) => group.links);
}

test('B1 limits keep the newest groups and links', () => {
  const groups = [];
  for (let g = 0; g < 51; g++) {
    const links = [];
    for (let l = 0; l < 10; l++) links.push(makeLink(`g${g}-l${l}`, g * 1000 + l));
    groups.push(makeGroup(`g${g}`, g, links));
  }
  const doc = { version: 2, settings: {}, groups };

  const dropped = core.enforceLimits(doc, { maxGroups: 50, maxLinks: 500 });

  assert.equal(dropped, 1);
  assert.equal(doc.groups.length, 50);
  // 最旧的分组被丢掉，最新的分组仍在。
  assert.equal(doc.groups.some((group) => group.id === 'g0'), false);
  assert.equal(doc.groups.some((group) => group.id === 'g50'), true);
  assert.equal(linksOf(doc).length, 500);
  // 每个分组都保留 10 条，没有分组被前面的分组饿死。
  assert.deepEqual([...new Set(doc.groups.map((group) => group.links.length))], [10]);
  // 组内保留的是较新的链接。
  assert.equal(doc.groups.find((group) => group.id === 'g50').links[0].id, 'g50-l0');
});

test('B1 per-group quota prevents starvation when one group hogs the budget', () => {
  const oldLinks = [];
  for (let i = 0; i < 490; i++) oldLinks.push(makeLink(`old-${i}`, i));
  const newLinks = [];
  for (let i = 0; i < 20; i++) newLinks.push(makeLink(`new-${i}`, 10_000 + i));
  const doc = {
    version: 2,
    groups: [makeGroup('old', 1, oldLinks), makeGroup('new', 2, newLinks)],
  };

  const dropped = core.enforceLimits(doc, { maxGroups: 50, maxLinks: 500 });

  assert.equal(dropped, 10);
  assert.equal(linksOf(doc).length, 500);
  const oldGroup = doc.groups.find((group) => group.id === 'old');
  const newGroup = doc.groups.find((group) => group.id === 'new');
  // 新分组完整保留；旧分组保留剩余名额里最新的 480 条，两个分组都不会被清空。
  assert.equal(newGroup.links.length, 20);
  assert.equal(oldGroup.links.length, 480);
  assert.equal(oldGroup.links.some((link) => link.id === 'old-0'), false);
  assert.equal(oldGroup.links.some((link) => link.id === 'old-489'), true);
});

test('B1 tombstones are dropped before live links', () => {
  const doc = {
    version: 2,
    groups: [
      makeGroup('a', 1, [makeLink('a-live', 100), makeLink('a-dead', 50, 50)]),
      makeGroup('b', 2, [makeLink('b-live', 200), makeLink('b-dead', 60, 60)]),
    ],
  };

  const dropped = core.enforceLimits(doc, { maxGroups: 50, maxLinks: 2 });

  assert.equal(dropped, 2);
  assert.deepEqual(
    linksOf(doc).map((link) => link.id).sort(),
    ['a-live', 'b-live']
  );
});

test('B1 surviving links keep their display order', () => {
  const doc = {
    version: 2,
    groups: [
      makeGroup('g', 1, [
        makeLink('a', 10),
        makeLink('b', 30),
        makeLink('c', 20),
        makeLink('d', 40),
      ]),
    ],
  };

  core.enforceLimits(doc, { maxGroups: 50, maxLinks: 2 });

  assert.deepEqual(doc.groups[0].links.map((link) => link.id), ['b', 'd']);
});

test('B1 tombstone groups are dropped before live groups', () => {
  const doc = {
    version: 2,
    groups: [
      makeGroup('live-old', 1, []),
      makeGroup('live-new', 2, []),
      makeGroup('dead-old', 3, [], 3),
      makeGroup('dead-new', 4, [], 4),
    ],
  };

  const dropped = core.enforceLimits(doc, { maxGroups: 2, maxLinks: 500 });

  assert.equal(dropped, 2);
  assert.deepEqual(doc.groups.map((group) => group.id).sort(), ['live-new', 'live-old']);
});
