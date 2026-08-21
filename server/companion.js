// 陪伴 agent 通用适配器（Companion Contract 参考实现）
//
// 契约（任何本地 agent 系统实现两个端点即可成为「学不学」的老师）：
//   GET  {url}{statusPath}                      → 2xx 即「在家」，非 2xx/超时即「不在家」
//   POST {url}{sendPath}  body={content, model_content}
//                                               → SSE 流：data: {"type":"chunk","content":"增量文本"}
//                                                 流结束即完成；content=用户原话，model_content=附加上下文（可选实现）
// sendPath 支持 {conv} 占位（多会话型 agent 用来指定投递的会话，如某些伙伴系统的主会话）。
//
// 全部参数在设置页可配（companion_* settings）；「本地实例预设」一键填充常见默认值。

import { store } from './db.js';

// 常见本地伙伴实例的预设连接参数（name 留空，由用户给自己的伙伴起名字；
// conv 也可在设置页留空后用「自动发现」获取）
export const LOCAL_PRESET = {
  name: '',
  url: 'http://127.0.0.1:8081',
  status_path: '/api/conversations',
  send_path: '/api/conversations/{conv}/send',
  conv: '',
};

export function companionConfig() {
  return {
    name: store.getSetting('companion_name') || '',
    url: (store.getSetting('companion_url') || '').replace(/\/+$/, ''),
    statusPath: store.getSetting('companion_status_path') || '/status',
    sendPath: store.getSetting('companion_send_path') || '/chat',
    conv: store.getSetting('companion_conv') || '',
  };
}

export function companionConfigured() {
  const c = companionConfig();
  return !!(c.name && c.url);
}

const fillConv = (path, conv) => path.replace('{conv}', encodeURIComponent(conv || ''));

export async function companionStatus() {
  const c = companionConfig();
  if (!companionConfigured()) return { configured: false, home: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      // 陪伴 agent 生成回答时可能占住自己的存储，探测给宽一点
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${c.url}${fillConv(c.statusPath, c.conv)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('bad status');
      return { configured: true, home: true, name: c.name };
    } catch {
      if (attempt === 0) await new Promise(r => setTimeout(r, 300));
    }
  }
  return { configured: true, home: false, name: c.name };
}

// 去掉陪伴流里的内部标签（<meta>…</meta> / <think>…</think>），未闭合的部分先不显示
function visibleText(raw) {
  let t = raw
    .replace(/\s*<meta>[\s\S]*?<\/meta>/g, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/g, '');
  const cut = t.search(/<(?:meta|think|thinking)\b/);
  if (cut >= 0) t = t.slice(0, cut);
  return t;
}

// onText(截至目前可见全文) 每个 chunk 回调一次；返回最终全文（已去标签）
export async function companionChat({ content, modelContent, onText }) {
  const c = companionConfig();
  if (!companionConfigured()) throw new Error('还没有配置陪伴 agent——去设置页填地址吧');
  const res = await fetch(`${c.url}${fillConv(c.sendPath, c.conv)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, model_content: modelContent || '' }),
  });
  if (!res.ok || !res.body) throw new Error(`${c.name} 服务返回 ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let raw = '';
  let lastShown = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === 'chunk' && typeof ev.content === 'string') {
          raw += ev.content;
          const vis = visibleText(raw);
          if (vis !== lastShown) { lastShown = vis; onText?.(vis); }
        }
      }
    }
  }
  const answer = visibleText(raw).trim();
  if (!answer) throw new Error(`${c.name} 没有回话（流为空）`);
  return answer;
}
