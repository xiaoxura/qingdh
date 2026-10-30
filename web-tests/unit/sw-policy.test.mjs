import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('../../web/js/lib/sw-policy.js');

test('B5 only real shell entry points may replace the offline shell', () => {
  for (const path of ['/', '/index.html', '/ai', '/ai/']) {
    assert.equal(policy.isShellNavigation(path), true, path);
  }
  for (const path of ['/missing', '/404', '/admin', '/admin/', '/verify-email', '/change-email', '/api/v1/workspace']) {
    assert.equal(policy.isShellNavigation(path), false, path);
  }
});

test('B5 navigation policy tolerates odd input', () => {
  assert.equal(policy.isShellNavigation(''), false);
  assert.equal(policy.isShellNavigation(null), false);
  assert.equal(policy.isShellNavigation(undefined), false);
});
