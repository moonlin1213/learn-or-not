// LLM 适配层：openai-completions / openai-responses / anthropic-messages
// + 从 DSH (~/.dsh) 导入已配置 provider
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { oauthChat } from './oauth.js';

const DSH_DIR = path.join(os.homedir(), '.dsh');
const PI_AI_DATA = '/Applications/DeepSeek Harness.app/Contents/Resources/app/node_modules/@earendil-works/pi-ai/dist/providers/data';

// ---------- 协议适配 ----------

async function request(url, { method = 'POST', headers = {}, body, timeoutMs = 300000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    if (!text.trim()) throw new Error('上游返回空响应（检查 baseURL 是否缺少 /v1 或协议不匹配）');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function anthropicUrl(baseURL) {
  const b = baseURL.replace(/\/+$/, '');
  return b.endsWith('/v1') ? `${b}/messages` : `${b}/v1/messages`;
}

// messages: [{role:'system'|'user'|'assistant', content:string}]
// 统一返回 string
export async function chat(provider, model, messages, { maxTokens = 16000, temperature } = {}) {
  if (provider.source === 'oauth') {
    return oauthChat(provider.source_id, model, messages, { maxTokens, temperature });
  }
  const { protocol, base_url, api_key, extra_headers = {} } = provider;
  if (protocol === 'openai-completions') {
    const body = { model, messages, max_tokens: maxTokens };
    if (temperature != null) body.temperature = temperature;
    const data = await request(`${base_url.replace(/\/+$/, '')}/chat/completions`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}`, ...extra_headers },
      body,
    });
    const c = data?.choices?.[0]?.message?.content;
    if (!c) throw new Error('openai-completions 响应缺少 choices[0].message.content');
    return typeof c === 'string' ? c : c.map(p => p.text || '').join('');
  }
  if (protocol === 'openai-responses') {
    const input = messages.map(m => ({ role: m.role === 'system' ? 'developer' : m.role, content: m.content }));
    const body = { model, input, max_output_tokens: Math.max(maxTokens, 16000) };
    if (temperature != null) body.temperature = temperature;
    const data = await request(`${base_url.replace(/\/+$/, '')}/responses`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}`, ...extra_headers },
      body,
    });
    if (data.output_text) return data.output_text;
    const msg = (data.output || []).find(o => o.type === 'message');
    const text = (msg?.content || []).filter(p => p.type === 'output_text').map(p => p.text).join('');
    if (!text) throw new Error('openai-responses 响应缺少 output_text');
    return text;
  }
  if (protocol === 'anthropic-messages') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const body = { model, max_tokens: maxTokens, messages: msgs };
    if (system) body.system = system;
    if (temperature != null) body.temperature = temperature;
    const data = await request(anthropicUrl(base_url), {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        ...extra_headers,
      },
      body,
    });
    const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) throw new Error('anthropic-messages 响应缺少 content text');
    return text;
  }
  throw new Error(`未知协议: ${protocol}`);
}

// 从 LLM 输出中提取 JSON（容忍 markdown 围栏与前后杂文本）
export function extractJson(text) {
  let s = text.trim();
  // 只把包住整个响应的围栏当作 JSON 外壳。讲义 JSON 的字符串内部经常
  // 包含 ```python 等 Markdown 代码块，不能把内部代码块误截成待解析内容。
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  // 从后往前找匹配的收尾
  for (let end = s.length; end > start; end--) {
    const tail = s[end - 1];
    if (tail !== '}' && tail !== ']') continue;
    try { return JSON.parse(s.slice(0, end)); } catch { /* 继续缩短 */ }
  }
  throw new Error('模型返回的内容格式不完整，无法读取');
}

// ---------- DSH 导入 ----------

export function importFromDsh() {
  const settingsPath = path.join(DSH_DIR, 'settings.yaml');
  const credPath = path.join(DSH_DIR, '.credentials.yaml');
  if (!fs.existsSync(settingsPath)) throw new Error('未找到 ~/.dsh/settings.yaml');
  const settings = YAML.parse(fs.readFileSync(settingsPath, 'utf8'));
  const creds = fs.existsSync(credPath) ? YAML.parse(fs.readFileSync(credPath, 'utf8')) : {};
  const providers = settings?.['llm-pi-ai']?.providers || {};
  const out = [];
  for (const [id, cfg] of Object.entries(providers)) {
    const apiKey = cfg.apiKeyEnv ? creds[cfg.apiKeyEnv] : null;
    if (!apiKey) continue; // 没 key 的跳过（如 OAuth 类）
    let protocol = cfg.api || null;
    let baseURL = cfg.baseURL || null;
    let extraHeaders = {};
    let models = (cfg.models || []).map(m => ({ id: m.id, name: m.name || m.id }));

    // settings 里没写全的字段，去模型目录补全
    if (!protocol || !baseURL || !models.length) {
      const cat = loadPiAiCatalog(id);
      if (cat) {
        protocol = protocol || cat.api;
        baseURL = baseURL || cat.baseUrl;
        extraHeaders = cat.headers || {};
        if (!models.length) models = cat.models;
      }
    }
    if (!protocol || !baseURL) continue;
    out.push({
      source: 'dsh',
      source_id: id,
      name: cfg.displayName || id,
      protocol,
      base_url: baseURL,
      api_key: apiKey,
      extra_headers: extraHeaders,
      models,
    });
  }
  return out;
}

function loadPiAiCatalog(providerId) {
  try {
    const p = path.join(PI_AI_DATA, `${providerId}.json`);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 结构：{ "<protocol>": { "<modelId>": {baseUrl, api, headers, ...} } }
    for (const [proto, modelsObj] of Object.entries(data)) {
      const entries = Object.values(modelsObj || {});
      if (!entries.length) continue;
      const first = entries[0];
      return {
        api: first.api || proto,
        baseUrl: first.baseUrl,
        headers: first.headers || {},
        models: entries.map(m => ({ id: m.id, name: m.name || m.id })),
      };
    }
  } catch { /* ignore */ }
  return null;
}
