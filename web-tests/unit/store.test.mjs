import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStorage } = require('../../web/js/lib/store.js');

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('C1 storage JSON round trip and malformed values', () => {
  const storage = fakeStorage();
  const store = createStorage({ storage });
  assert.equal(store.readJSON('missing'), null);
  assert.equal(store.writeJSON('a', { x: 1 }), true);
  assert.deepEqual(store.readJSON('a'), { x: 1 });
  storage.setItem('broken', '{oops');
  assert.equal(store.readJSON('broken'), null);
  store.removeKey('a');
  assert.equal(store.readJSON('a'), null);
});

test('C1 storage reports quota errors without throwing', () => {
  let errors = 0;
  const store = createStorage({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    },
    onError: () => {
      errors += 1;
    },
  });
  assert.equal(store.writeJSON('a', { x: 1 }), false);
  assert.equal(errors, 1);
});

test('C1 storage flags are persisted as 0/1', () => {
  const storage = fakeStorage();
  const store = createStorage({ storage });
  assert.equal(store.readFlag('dirty'), false);
  store.writeFlag('dirty', true);
  assert.equal(storage.map.get('dirty'), '1');
  assert.equal(store.readFlag('dirty'), true);
  store.writeFlag('dirty', false);
  assert.equal(store.readFlag('dirty'), false);
});

test('C1 storage works without a backing store', () => {
  const store = createStorage({});
  assert.equal(store.readJSON('a'), null);
  assert.equal(store.writeJSON('a', 1), false);
  store.removeKey('a');
  assert.equal(store.readFlag('a'), false);
  store.writeFlag('a', true);
});
