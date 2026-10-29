import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// crypto.js 是 classic script：执行后把 API 挂在 globalThis 上。
require('../../web/crypto.js');
const crypto = globalThis.QingdhCrypto;

const PAYLOAD = {
  version: 2,
  settings: { name: '小夏', engine: 'bing' },
  groups: [
    {
      id: 'g1',
      name: '常用',
      links: [{ id: 'l1', title: 'GitHub', url: 'https://github.com/' }],
    },
  ],
};
const PASSWORD = 'correct horse battery';

test('v3 setup / unlock round trip and wrong password rejection', async () => {
  const created = await crypto.setup(PASSWORD, PAYLOAD);
  assert.equal(created.envelope.version, 3);
  assert.equal(created.recoveryCode.length, 40);

  const opened = await crypto.unlock(created.envelope, PASSWORD);
  assert.deepEqual(opened.payload, PAYLOAD);
  assert.equal(Buffer.from(opened.dataKeyRaw).toString('hex'), Buffer.from(created.dataKeyRaw).toString('hex'));

  await assert.rejects(crypto.unlock(created.envelope, 'wrong password'), (error) => error.code === 'unlock_failed');
});

test('A3 a regenerated recovery code replaces the old one without touching data', async () => {
  const created = await crypto.setup(PASSWORD, PAYLOAD);
  const rotated = await crypto.rewrapRecovery(created.envelope, PASSWORD);

  assert.notEqual(rotated.recoveryCode, created.recoveryCode);
  assert.notEqual(rotated.envelope.recovery.wrappedKey, created.envelope.recovery.wrappedKey);
  // salt / wrappedKey / check / data 保持不变，Device Vault 继续有效。
  for (const field of ['salt', 'wrappedKey', 'check', 'data', 'iterations', 'kdf']) {
    assert.equal(rotated.envelope[field], created.envelope[field], field);
  }

  // 旧恢复码失效，新恢复码可用，密码解锁不受影响。
  await assert.rejects(
    crypto.unlockWithRecovery(rotated.envelope, created.recoveryCode),
    (error) => error.code === 'unlock_failed'
  );
  const viaRecovery = await crypto.unlockWithRecovery(rotated.envelope, rotated.recoveryCode);
  assert.deepEqual(viaRecovery.payload, PAYLOAD);
  const viaPassword = await crypto.unlock(rotated.envelope, PASSWORD);
  assert.deepEqual(viaPassword.payload, PAYLOAD);
});

test('A3 recovery rotation can be authorised by the old recovery code', async () => {
  const created = await crypto.setup(PASSWORD, PAYLOAD);
  const rotated = await crypto.rewrapRecovery(created.envelope, created.recoveryCode, { useRecovery: true });

  const opened = await crypto.unlockWithRecovery(rotated.envelope, rotated.recoveryCode);
  assert.deepEqual(opened.payload, PAYLOAD);
  await assert.rejects(
    crypto.unlockWithRecovery(rotated.envelope, created.recoveryCode),
    (error) => error.code === 'unlock_failed'
  );
});

test('A3 rotating recovery with a wrong password fails cleanly', async () => {
  const created = await crypto.setup(PASSWORD, PAYLOAD);
  await assert.rejects(
    crypto.rewrapRecovery(created.envelope, 'wrong password'),
    (error) => error.code === 'unlock_failed'
  );
  // 失败后原恢复码仍然有效。
  const opened = await crypto.unlockWithRecovery(created.envelope, created.recoveryCode);
  assert.deepEqual(opened.payload, PAYLOAD);
});

test('tampered ciphertext and AAD/kind confusion are rejected', async () => {
  const created = await crypto.setup(PASSWORD, PAYLOAD);
  const tampered = {
    ...created.envelope,
    data: created.envelope.data.slice(0, -4) + 'AAAA',
  };
  await assert.rejects(
    crypto.unlockWithKey(tampered, created.dataKeyRaw),
    (error) => error.code === 'unlock_failed'
  );

  // 把 check 当 data 用：AAD 不同，必须失败。
  const swapped = { ...created.envelope, data: created.envelope.check };
  await assert.rejects(
    crypto.unlockWithKey(swapped, created.dataKeyRaw),
    (error) => error.code === 'unlock_failed'
  );

  const memo = await crypto.sealSecret('memo', created.dataKeyRaw, { memos: ['a'] });
  const wrongKind = await crypto.openSecret(memo, 'ai', created.dataKeyRaw).then(
    () => null,
    (error) => error
  );
  assert.equal(wrongKind && wrongKind.code, 'secret_kind_mismatch');

  // 换一把 dataKey 也解不开 memo。
  const other = await crypto.setup('another password', PAYLOAD);
  await assert.rejects(
    crypto.openSecret(memo, 'memo', other.dataKeyRaw),
    (error) => error.code === 'unlock_failed'
  );
});
