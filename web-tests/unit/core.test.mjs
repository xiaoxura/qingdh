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
