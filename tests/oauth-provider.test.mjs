import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnornot-oauth-provider-'));
process.env.LEARNLOOP_DATA_DIR = dataDir;
const { store, dumpAll } = await import('../server/db.js');
const { oauthStatus, oauthCredentials, logoutOAuth, autoImportDshOAuth, reconcileOAuthProviders } = await import('../server/oauth.js');

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

test('OAuth logout does not auto reconnect from DSH during the same response', async () => {
  await oauthCredentials.modify('xai', async () => ({
    type: 'oauth', access: 'local-access', refresh: 'local-refresh', expires: Date.now() + 3_600_000,
  }));
  store.upsertOAuthProvider({
    name: 'Grok', source_id: 'grok', protocol: 'openai-responses',
    base_url: 'https://api.x.ai/v1', api_key: 'oauth-managed',
    models: [{ id: 'grok-4.5', name: 'Grok 4.5' }], default_model: 'grok-4.5',
  });
  const status = await logoutOAuth('grok');
  const grok = status.platforms.find(platform => platform.id === 'grok');
  assert.equal(grok.signed_in, false);
  assert.equal(await oauthCredentials.read('xai'), undefined);
});
