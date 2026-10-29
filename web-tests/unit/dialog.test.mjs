import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createModal } = require('../../web/lib/dialog.js');

function fakeDialog() {
  const dialog = {
    open: false,
    showCount: 0,
    closeCount: 0,
    showModal() {
      if (dialog.open) throw new Error('InvalidStateError');
      dialog.open = true;
      dialog.showCount += 1;
    },
    close() {
      dialog.open = false;
      dialog.closeCount += 1;
    },
  };
  return dialog;
}

test('B4 a second prompt settles the previous promise instead of leaving it hanging', async () => {
  const dialog = fakeDialog();
  const modal = createModal(dialog);

  const results = [];
  const first = new Promise((resolve) => modal.prompt((value) => { results.push(['first', value]); resolve(value); }));
  const second = new Promise((resolve) => modal.prompt((value) => { results.push(['second', value]); resolve(value); }, () => {
    results.push(['setup', null]);
  }));

  assert.equal(await first, null);
  assert.equal(dialog.open, true);
  assert.equal(dialog.showCount, 1, 'an already open dialog must not be shown twice');
  assert.deepEqual(results[0], ['first', null]);

  modal.settle('answer');
  assert.equal(await second, 'answer');
  assert.equal(dialog.open, false);
  assert.equal(dialog.closeCount, 1);
});

test('B4 settle is idempotent and closes the dialog once', async () => {
  const dialog = fakeDialog();
  const modal = createModal(dialog);
  let resolved = 0;
  const pending = new Promise((resolve) => {
    modal.prompt((value) => {
      resolved += 1;
      resolve(value);
    });
  });

  assert.equal(modal.isPending(), true);
  assert.equal(modal.settle('first'), true);
  assert.equal(modal.settle('second'), false);
  assert.equal(await pending, 'first');
  assert.equal(resolved, 1);
  assert.equal(modal.isPending(), false);
  assert.equal(dialog.closeCount, 1);
});

test('B4 a closed dialog can be reopened for a later prompt', async () => {
  const dialog = fakeDialog();
  const modal = createModal(dialog);

  const first = new Promise((resolve) => modal.prompt(resolve));
  modal.settle(null);
  assert.equal(await first, null);

  const second = new Promise((resolve) => modal.prompt(resolve));
  assert.equal(dialog.open, true);
  assert.equal(dialog.showCount, 2);
  modal.settle('again');
  assert.equal(await second, 'again');
});
