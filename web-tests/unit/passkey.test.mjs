import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('passkey capability identifies IP hosts and localhost', async () => {
  globalThis.isSecureContext = true;
  globalThis.location = { hostname: '127.0.0.1', origin: 'http://127.0.0.1:8080' };
  globalThis.PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { credentials: { create() {}, get() {} } },
  });

  require('../../web/passkey.js');
  const passkey = globalThis.QingdhPasskey;

  assert.equal(passkey.supported(), false);
  assert.match(passkey.unsupportedReason(), /IP/);
  assert.equal(passkey.relyingPartyId(), '');

  globalThis.location = { hostname: 'localhost', origin: 'http://localhost:8080' };
  assert.equal(passkey.supported(), true);
  assert.equal(passkey.relyingPartyId(), 'localhost');
  assert.equal(await passkey.platformAvailable(), true);
});
