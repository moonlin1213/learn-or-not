// Codex / Grok 订阅 OAuth：登录、刷新、模型目录与调用统一交给 pi-ai。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { store } from './db.js';
import { OAuthCredentialStore, readOAuthCredentialFile } from './oauth-store.js';

const DATA_DIR = process.env.LEARNLOOP_DATA_DIR || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data');
const OAUTH_FILE = path.join(DATA_DIR, 'oauth-credentials.json');
const DSH_OAUTH_FILE = path.join(os.homedir(), '.dsh', '.everything-oauth.json');

const PLATFORM = Object.freeze({
  codex: {
    id: 'codex', name: 'Codex', providerId: 'openai-codex', protocol: 'openai-codex-responses',
    baseURL: 'https://chatgpt.com/backend-api', defaultModel: 'gpt-5.4',
    description: '使用 ChatGPT Plus / Pro 订阅',
  },
  grok: {
    id: 'grok', name: 'Grok', providerId: 'xai', protocol: 'openai-responses',
    baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-4.5',
    description: '使用 SuperGrok / X Premium 订阅',
  },
});

function platformOf(id) {
  const platform = PLATFORM[id];
  if (!platform) throw new Error('不支持的 OAuth 平台');
  return platform;
}

function createRuntimeModels(credentials) {
  const runtime = createModels({ credentials });
  runtime.setProvider(openaiCodexProvider());
  const xai = xaiProvider();
  const shipped = [...xai.getModels()];
  if (!shipped.some(model => model.id === 'grok-4.6')) {
    const template = shipped.find(model => model.id === 'grok-4.5');
    if (template) shipped.push({ ...template, id: 'grok-4.6', name: 'Grok 4.6' });
  }
  runtime.setProvider({ ...xai, getModels: () => shipped });
  return runtime;
}

export const oauthCredentials = new OAuthCredentialStore(OAUTH_FILE);
const oauthModels = createRuntimeModels(oauthCredentials);

function publicModels(platform) {
  return oauthModels.getModels(platform.providerId).map(model => ({ id: model.id, name: model.name || model.id }));
}

function syncProvider(platformId) {
  const platform = platformOf(platformId);
  const models = publicModels(platform);
  const id = Number(store.upsertOAuthProvider({
    name: platform.name,
    source_id: platform.id,
    protocol: platform.protocol,
    base_url: platform.baseURL,
    api_key: 'oauth-managed',
    models,
    default_model: models.some(model => model.id === platform.defaultModel) ? platform.defaultModel : models[0]?.id,
  }));
  if (!store.listProviders().some(provider => provider.is_default)) {
    const provider = store.getProvider(id);
    store.setDefaultProvider(id, provider.default_model || models[0]?.id);
  }
  return id;
}

function safeError(error) {
  return String(error?.message || error || 'OAuth 登录失败')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{20,})\b/g, '[已隐藏凭据]')
    .slice(0, 400);
}

class LoginRunner {
  constructor(platformId) {
    this.platformId = platformId;
    this.operation = null;
    this.abortController = null;
    this.challenge = null;
    this.error = null;
    this.waiters = [];
    this.promptRejectors = [];
  }

  async start(mode) {
    if (this.operation) {
      if (this.challenge) return this.challenge;
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    const platform = platformOf(this.platformId);
    this.abortController = new AbortController();
    this.challenge = null;
    this.error = null;
    this.operation = oauthModels.login(platform.providerId, 'oauth', {
      signal: this.abortController.signal,
      prompt: prompt => {
        if (prompt.type === 'select') {
          const wanted = mode === 'browser' ? 'browser' : 'device_code';
          return Promise.resolve(prompt.options.find(option => option.id === wanted)?.id ?? prompt.options[0]?.id ?? wanted);
        }
        return this.waitForPrompt(prompt);
      },
      notify: event => this.onEvent(event),
    }).then(() => {
      syncProvider(this.platformId);
      this.challenge = null;
    }).catch(error => {
      this.challenge = null;
      this.error = safeError(error);
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(this.error));
    }).finally(() => {
      this.operation = null;
      this.abortController = null;
      this.promptRejectors = [];
    });
    if (this.challenge) return this.challenge;
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  waitForPrompt(prompt) {
    if (prompt.signal?.aborted) return Promise.reject(prompt.signal.reason);
    return new Promise((_resolve, reject) => {
      const cancel = reason => reject(reason instanceof Error ? reason : new Error('登录已取消'));
      this.promptRejectors.push(cancel);
      prompt.signal?.addEventListener('abort', () => cancel(prompt.signal.reason), { once: true });
    });
  }

  onEvent(event) {
    let challenge;
    if (event.type === 'auth_url') challenge = { url: event.url, kind: 'browser' };
    if (event.type === 'device_code') {
      challenge = {
        url: event.verificationUri,
        user_code: event.userCode || '',
        kind: 'device_code',
        expires_in: event.expiresInSeconds || null,
      };
    }
    if (!challenge) return;
    const url = new URL(challenge.url);
    if (url.protocol !== 'https:') {
      this.error = 'OAuth 服务返回了不安全的授权地址';
      this.abortController?.abort(new Error(this.error));
      return;
    }
    this.challenge = challenge;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(challenge);
  }

  async cancel() {
    const operation = this.operation;
    const reason = new Error('登录已取消');
    for (const reject of this.promptRejectors.splice(0)) reject(reason);
    this.abortController?.abort(reason);
    this.challenge = null;
    if (operation) await operation;
    this.error = null;
  }

  publicState() {
    return { running: Boolean(this.operation), challenge: this.challenge, error: this.error };
  }
}

const loginRunners = new Map(Object.keys(PLATFORM).map(id => [id, new LoginRunner(id)]));

async function importDshOAuthCredential(platform) {
  if (!fs.existsSync(DSH_OAUTH_FILE)) return false;
  await oauthModels.logout(platform.providerId).catch(() => {});
  let credential;
  try {
    credential = readOAuthCredentialFile(DSH_OAUTH_FILE, platform.providerId);
  } catch (error) {
    if (!String(error?.message || '').includes('没有找到可用')) throw error;
    credential = readOAuthCredentialFile(DSH_OAUTH_FILE, `${platform.id}-oauth`);
  }
  await oauthCredentials.modify(platform.providerId, async () => credential);
  return true;
}

export async function autoImportDshOAuth() {
  const imported = [];
  for (const platform of Object.values(PLATFORM)) {
    if (loginRunners.get(platform.id).publicState().running) continue;
    try {
      if (await oauthCredentials.read(platform.providerId)) continue;
      if (await importDshOAuthCredential(platform)) imported.push(platform.id);
    } catch (error) {
      console.error(`[oauth] DSH 登录自动同步跳过 ${platform.id}:`, safeError(error));
    }
  }
  return imported;
}

export async function reconcileOAuthProviders() {
  const credentials = new Map((await oauthCredentials.list()).map(item => [item.providerId, item]));
  for (const platform of Object.values(PLATFORM)) {
    const signedIn = credentials.get(platform.providerId)?.type === 'oauth';
    const provider = store.getProviderBySource('oauth', platform.id);
    if (signedIn && !provider) syncProvider(platform.id);
    if (!signedIn && provider) store.deleteProviderBySource('oauth', platform.id);
  }
}

export async function oauthStatus({ autoImport = true } = {}) {
  if (autoImport) await autoImportDshOAuth();
  const credentials = new Map((await oauthCredentials.list()).map(item => [item.providerId, item]));
  return {
    dsh_available: fs.existsSync(DSH_OAUTH_FILE),
    platforms: Object.values(PLATFORM).map(platform => {
      const provider = store.getProviderBySource('oauth', platform.id);
      return {
        id: platform.id,
        name: platform.name,
        description: platform.description,
        signed_in: credentials.get(platform.providerId)?.type === 'oauth',
        provider_id: provider?.id || null,
        default_model: provider?.default_model || platform.defaultModel,
        models: publicModels(platform),
        login: loginRunners.get(platform.id).publicState(),
      };
    }),
  };
}

export async function startOAuthLogin(platformId, mode) {
  platformOf(platformId);
  return loginRunners.get(platformId).start(mode);
}

export async function cancelOAuthLogin(platformId) {
  platformOf(platformId);
  await loginRunners.get(platformId).cancel();
  return oauthStatus();
}

export async function logoutOAuth(platformId) {
  const platform = platformOf(platformId);
  await loginRunners.get(platformId).cancel();
  await oauthModels.logout(platform.providerId);
  store.deleteProviderBySource('oauth', platform.id);
  return oauthStatus({ autoImport: false });
}

export async function importOAuthFromDsh(platformId) {
  const platform = platformOf(platformId);
  if (!fs.existsSync(DSH_OAUTH_FILE)) throw new Error('没有找到 DSH Everything OAuth 登录文件');
  await importDshOAuthCredential(platform);
  const providerId = syncProvider(platform.id);
  return { ok: true, provider_id: providerId, ...(await oauthStatus()) };
}

const ZERO_USAGE = Object.freeze({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function contextFor(model, messages) {
  const systemPrompt = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const history = messages.filter(message => message.role !== 'system').map((message, index) => {
    const timestamp = Date.now() + index;
    if (message.role === 'assistant') {
      return {
        role: 'assistant', content: [{ type: 'text', text: String(message.content) }],
        api: model.api, provider: model.provider, model: model.id,
        usage: structuredClone(ZERO_USAGE), stopReason: 'stop', timestamp,
      };
    }
    return { role: 'user', content: String(message.content), timestamp };
  });
  return { ...(systemPrompt ? { systemPrompt } : {}), messages: history };
}

export async function oauthChat(platformId, modelId, messages, { maxTokens = 16000, temperature } = {}) {
  const platform = platformOf(platformId);
  const model = oauthModels.getModel(platform.providerId, modelId);
  if (!model) throw new Error(`${platform.name} 不支持模型 ${modelId}`);
  const options = { maxTokens: Math.min(maxTokens, model.maxTokens || maxTokens) };
  if (temperature != null) options.temperature = temperature;
  // 代理链路（chatgpt.com / x.ai）偶发抖动：失败自动重试一次，
  // 避免交卷阅卷等多步连续调用被单次抖动整体带崩。
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      const answer = await oauthModels.complete(model, contextFor(model, messages), options);
      if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
        throw new Error(safeError(answer.errorMessage || `${platform.name} 请求失败`));
      }
      const text = answer.content.filter(part => part.type === 'text').map(part => part.text || '').join('');
      if (!text.trim()) throw new Error(`${platform.name} 返回了空响应`);
      return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export const oauthInternals = { OAUTH_FILE, DSH_OAUTH_FILE, PLATFORM, createRuntimeModels };
