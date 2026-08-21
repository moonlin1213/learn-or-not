import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OAuthCredentialStore, readOAuthCredentialFile } from '../server/oauth-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learnornot-oauth-'));
const file = path.join(tmp, 'oauth-credentials.json');
const store = new OAuthCredentialStore(file);
const credential = {
  type: 'oauth', access: 'access-token-for-test', refresh: 'refresh-token-for-test',
  expires: Date.now() + 3_600_000, counter: 0,
};

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('OAuth credentials are owner-only, atomic and never exposed by list()', async () => {
  assert.equal(await store.read('xai'), undefined);
  await store.modify('xai', async () => credential);

  const saved = await store.read('xai');
  assert.equal(saved.access, credential.access);
  assert.equal(saved.refresh, credential.refresh);
  assert.deepEqual(await store.list(), [{ providerId: 'xai', type: 'oauth' }]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  await Promise.all([
    store.modify('xai', async current => ({ ...current, counter: current.counter + 1 })),
    store.modify('xai', async current => ({ ...current, counter: current.counter + 1 })),
  ]);
  assert.equal((await store.read('xai')).counter, 2);

  // 不同 provider 也共享同一 JSON；并发刷新不得互相覆盖。
  const secondProcessStore = new OAuthCredentialStore(file);
  await Promise.all([
    store.modify('xai', async current => { await Promise.resolve(); return { ...current, counter: current.counter + 1 }; }),
    secondProcessStore.modify('openai-codex', async () => { await Promise.resolve(); return { ...credential, accountId: 'test-account' }; }),
  ]);
  assert.equal((await store.read('xai')).counter, 3);
  assert.equal((await store.read('openai-codex')).accountId, 'test-account');
});

test('DSH OAuth import reads only the requested valid credential', () => {
  const dshFile = path.join(tmp, 'everything-oauth.json');
  fs.writeFileSync(dshFile, JSON.stringify({
    version: 1,
    credentials: {
      'openai-codex': credential,
      unrelated: { type: 'api_key', key: 'must-not-import' },
    },
  }), { mode: 0o600 });
  const imported = readOAuthCredentialFile(dshFile, 'openai-codex');
  assert.equal(imported.type, 'oauth');
  assert.equal(imported.access, credential.access);
  assert.throws(() => readOAuthCredentialFile(dshFile, 'unrelated'), /没有找到可用/);
});
