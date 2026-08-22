import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnornot-oauth-provider-'));
const dshOAuthFile = path.join(dataDir, 'dsh-oauth.json');
process.env.LEARNLOOP_DATA_DIR = dataDir;
process.env.LEARNLOOP_DSH_OAUTH_FILE = dshOAuthFile;
fs.writeFileSync(dshOAuthFile, JSON.stringify({
  version: 1,
  credentials: {
    'openai-codex': { type: 'oauth', access: 'dsh-codex-access', refresh: 'dsh-codex-refresh', expires: Date.now() + 3_600_000 },
    xai: { type: 'oauth', access: 'dsh-xai-access', refresh: 'dsh-xai-refresh', expires: Date.now() + 3_600_000 },
  },
}, null, 2) + '\n', { mode: 0o600 });
const { store, dumpAll, restoreAll } = await import('../server/db.js');
const {
  oauthStatus, oauthCredentials, logoutOAuth, importOAuthFromDsh, startOAuthLogin,
  autoImportDshOAuth, reconcileOAuthProviders,
} = await import('../server/oauth.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('OAuth provider upsert preserves model choice and delete repairs default', () => {
  const manual = Number(store.addProvider({
    name: 'Manual', protocol: 'openai-responses', base_url: 'https://example.invalid/v1',
    api_key: 'test-key', models: [{ id: 'manual-model', name: 'Manual Model' }],
  }).lastInsertRowid);
  const first = Number(store.upsertOAuthProvider({
    name: 'Codex', source_id: 'codex', protocol: 'openai-codex-responses',
    base_url: 'https://chatgpt.com/backend-api', api_key: 'oauth-managed',
    models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }, { id: 'gpt-5.5', name: 'GPT-5.5' }],
    default_model: 'gpt-5.4',
  }));
  store.setDefaultProvider(first, 'gpt-5.5');

  const same = Number(store.upsertOAuthProvider({
    name: 'Codex', source_id: 'codex', protocol: 'openai-codex-responses',
    base_url: 'https://chatgpt.com/backend-api', api_key: 'oauth-managed',
    models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }, { id: 'gpt-5.5', name: 'GPT-5.5' }],
    default_model: 'gpt-5.4',
  }));
  assert.equal(same, first);
  assert.equal(store.getProvider(first).default_model, 'gpt-5.5');
  assert.equal(store.getProvider(first).is_default, 1);
  const backupProviders = dumpAll().tables.providers;
  assert.deepEqual(backupProviders.map(provider => provider.id), [manual]);
  assert.ok(!JSON.stringify(dumpAll()).includes('oauth-managed'));

  store.deleteProviderBySource('oauth', 'codex');
  assert.equal(store.getProvider(first), undefined);
  assert.equal(store.getProvider(manual).is_default, 1);
  assert.equal(store.defaultProvider().id, manual);
});

test('OAuth status read reconciles only after auto-import and explicit cleanup', async () => {
  const grok = Number(store.upsertOAuthProvider({
    name: 'Grok', source_id: 'grok', protocol: 'openai-responses',
    base_url: 'https://api.x.ai/v1', api_key: 'oauth-managed',
    models: [{ id: 'grok-4.5', name: 'Grok 4.5' }], default_model: 'grok-4.5',
  }));
  await oauthStatus();
  assert.equal(store.getProvider(grok).source_id, 'grok');
  let imported = await autoImportDshOAuth();
  if (!imported.includes('grok') && await oauthCredentials.read('xai')) imported.push('grok');
  if (imported.includes('grok')) {
    assert.equal(store.getProviderBySource('oauth', 'grok').id, grok);
    await oauthCredentials.delete('xai');
    await oauthCredentials.delete('grok-oauth');
    store.deleteProviderBySource('oauth', 'grok');
  } else {
    await reconcileOAuthProviders();
  }
  assert.equal(store.getProvider(grok), undefined);
});

test('OAuth logout remains disconnected across later status reads until explicit reconnect', async () => {
  await importOAuthFromDsh('codex');
  assert.equal((await oauthStatus()).platforms.find(platform => platform.id === 'codex').signed_in, true);
  const preDisconnectBackup = dumpAll();
  assert.equal(preDisconnectBackup.tables.settings.some(row => row.key.startsWith('oauth_auto_import_disabled_')), false);

  const disconnected = await logoutOAuth('codex');
  assert.equal(disconnected.platforms.find(platform => platform.id === 'codex').signed_in, false);
  assert.equal(await oauthCredentials.read('openai-codex'), undefined);

  const laterStatus = await oauthStatus();
  assert.equal(laterStatus.platforms.find(platform => platform.id === 'codex').signed_in, false);
  assert.equal(await oauthCredentials.read('openai-codex'), undefined);

  restoreAll(preDisconnectBackup);
  const afterRestore = await oauthStatus();
  assert.equal(afterRestore.platforms.find(platform => platform.id === 'codex').signed_in, false);
  assert.equal(await oauthCredentials.read('openai-codex'), undefined);

  await importOAuthFromDsh('codex');
  assert.equal((await oauthStatus()).platforms.find(platform => platform.id === 'codex').signed_in, true);
});

test('OAuth status reports local login availability per platform', async () => {
  const original = fs.readFileSync(dshOAuthFile, 'utf8');
  try {
    const document = JSON.parse(original);
    delete document.credentials.xai;
    fs.writeFileSync(dshOAuthFile, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    const status = await oauthStatus({ autoImport: false });
    assert.equal(status.platforms.find(platform => platform.id === 'codex').local_login_available, true);
    assert.equal(status.platforms.find(platform => platform.id === 'grok').local_login_available, false);
    await assert.rejects(importOAuthFromDsh('grok'), /没有找到可用的 Grok 本机登录态/);
  } finally {
    fs.writeFileSync(dshOAuthFile, original, { mode: 0o600 });
  }
});

test('subscription platforms reject direct official OAuth and expose local import only', async () => {
  const status = await oauthStatus({ autoImport: false });
  assert.equal(status.platforms.find(platform => platform.id === 'codex').direct_login, false);
  assert.equal(status.platforms.find(platform => platform.id === 'grok').direct_login, false);
  for (const platformId of ['codex', 'grok']) {
    await assert.rejects(
      startOAuthLogin(platformId, 'device_code'),
      error => {
        assert.equal(error.code, 400);
        assert.match(error.message, /仅支持导入本机登录态，不会打开官网授权页面/);
        return true;
      },
    );
  }
});
