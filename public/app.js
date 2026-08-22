/* LearnLoop SPA */
'use strict';

// ---------- 基础设施 ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');

async function api(path, opts = {}) {
  const res = await fetch(path, opts.body && !(opts.body instanceof FormData)
    ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }
    : { method: opts.method || 'GET', body: opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 模型选择器：只展开当前 provider，其余按名字折叠；展开状态本地持久化。
const MODEL_MENU_STATE_KEY = 'learnloop.modelMenuExpanded';
function loadModelMenuExpanded() {
  try { return JSON.parse(localStorage.getItem(MODEL_MENU_STATE_KEY) || '{}'); }
  catch { return {}; }
}
function saveModelMenuExpanded(map) {
  localStorage.setItem(MODEL_MENU_STATE_KEY, JSON.stringify(map || {}));
}
function expandedProviderFor(menuKey, activeKey) {
  const saved = loadModelMenuExpanded()[menuKey];
  return saved || activeKey || null;
}
function providerMenuHtml({ menuKey, providers, activeKey, currentChip, companionBlock = null }) {
  const expanded = expandedProviderFor(menuKey, activeKey);
  const groups = [];
  if (companionBlock != null) {
    groups.push(`<div class="llm-provider ${expanded === 'companion' ? 'open' : ''}" data-provider-key="companion">
      <div class="llm-p-name" role="button" tabindex="0">${companionBlock.title}</div>
      <div class="llm-models">${companionBlock.models}</div>
    </div>`);
  }
  for (const p of providers) {
    const models = JSON.parse(p.models || '[]');
    const chips = models.map(m => `<span class="llm-chip ${currentChip?.(p, m) ? 'current' : ''}"
      data-pid="${p.id}" data-model="${esc(m.id)}" data-label="${esc(p.name)} · ${esc(m.id)}">${esc(m.name || m.id)}</span>`).join('');
    groups.push(`<div class="llm-provider ${expanded === String(p.id) ? 'open' : ''}" data-provider-key="${p.id}">
      <div class="llm-p-name" role="button" tabindex="0">${esc(p.name)}<span class="llm-p-proto">${esc(p.protocol)}</span></div>
      <div class="llm-models">${chips}</div>
    </div>`);
  }
  return groups.join('');
}
function paintProviderExpanded(root, key) {
  $$('.llm-provider[data-provider-key]', root).forEach(group => {
    group.classList.toggle('open', group.dataset.providerKey === key);
  });
}
function bindProviderMenuExpansion(root, menuKey, activeKey) {
  let expanded = expandedProviderFor(menuKey, activeKey);
  paintProviderExpanded(root, expanded);
  root.addEventListener('click', event => {
    const name = event.target.closest('.llm-p-name');
    if (!name || event.target.closest('.llm-chip')) return;
    const group = name.closest('.llm-provider[data-provider-key]');
    if (!group) return;
    event.stopPropagation();
    const key = group.dataset.providerKey;
    expanded = expanded === key ? null : key;
    const saved = loadModelMenuExpanded();
    saved[menuKey] = expanded;
    saveModelMenuExpanded(saved);
    paintProviderExpanded(root, expanded);
  });
}

// ---------- 主题 ----------
document.documentElement.dataset.theme = localStorage.getItem('learnloop.theme') || 'egypt';
// 恢复用户上次调好的聊天栏宽度
const savedChatW = Number(localStorage.getItem('learnloop.chatW'));
if (savedChatW) document.documentElement.style.setProperty('--col-right', savedChatW + 'px');
// 阅读排版（字号缩放 + 字间距），设置页可调
function applyTypography() {
  const scale = Number(localStorage.getItem('learnloop.fontScale') || 100);
  const ls = Number(localStorage.getItem('learnloop.letterSpacing') || 0);
  document.documentElement.style.fontSize = (16 * scale / 100) + 'px';
  document.body.style.letterSpacing = ls ? ls + 'px' : '';
}
applyTypography();
const THEME_GLYPHS = {
  egypt:   { cat: '𓃠', scarab: '𓆣', ankh: '𓋹', eye: '𓂀', house: '𓉐', sun: '𓇳', ok: '𓋹', err: '𓂀', empty: '𓃠', plug: '𓉐', dot: '𓆣' },
  morandi: { cat: '✧', scarab: '✧', ankh: '✓', eye: '✕', house: '◈', sun: '✧', ok: '✓', err: '✕', empty: '✧', plug: '◈', dot: '·' },
};
function glyph(k) {
  const t = document.documentElement.dataset.theme || 'egypt';
  return (THEME_GLYPHS[t] || THEME_GLYPHS.egypt)[k] || '';
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function openModal(html) {
  $('#modal-box').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal')?.addEventListener('click', e => { if (e.target.classList.contains('modal-mask')) closeModal(); });

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 迷你 Markdown ----------
// 代码块占位 token：\u0000 定界符不可能出现在正常文本里，避免与正文里的数字混淆误还原
const codeToken = i => `\u0000LONCODE${i}\u0000`;
const CODE_TOKEN_RE = /\u0000LONCODE(\d+)\u0000/g;
function md(src) {
  if (!src) return '';
  const blocks = [];
  // 代码块先抽走
  src = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return codeToken(blocks.length - 1);
  });
  // AI 输出里残留的转义换行还原（后紧跟英文字母的视为 LaTeX 命令，跳过）
  src = src.replace(/\\n\\n/g, '\n\n').replace(/\\n(?![a-zA-Z])/g, '\n');
  // 多行 $$ 公式并成一行（KaTeX auto-render 只在同一文本节点内匹配定界符，跨行会渲染失败）
  src = src.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => '$$' + tex.replace(/\s*\n\s*/g, ' ').trim() + '$$');
  src = src.replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => '\\[' + tex.replace(/\s*\n\s*/g, ' ').trim() + '\\]');
  let html = esc(src);
  html = html
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // 列表
  html = html.replace(/(?:^|\n)((?:[ \t]*[-*] .+(?:\n|$))+)/g, (_, list) => {
    const items = list.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*] /, '')}</li>`).join('');
    return `\n<ul>${items}</ul>`;
  });
  html = html.replace(/(?:^|\n)((?:[ \t]*\d+\. .+(?:\n|$))+)/g, (_, list) => {
    const items = list.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\. /, '')}</li>`).join('');
    return `\n<ol>${items}</ol>`;
  });
  // 表格
  html = html.replace(/(?:^|\n)((?:\|[^\n]+\|[ \t]*\n?)+)/g, (_, block) => {
    const rows = block.trim().split('\n').map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    if (rows.length < 2) return block;
    const isSep = r => r.every(c => /^:?-{2,}:?$/.test(c));
    let head = null, bodyRows = rows;
    if (rows.length >= 2 && isSep(rows[1])) { head = rows[0]; bodyRows = rows.slice(2); }
    const cell = (c, tag) => `<${tag}>${c}</${tag}>`;
    return '\n<table>' + (head ? `<thead><tr>${head.map(c => cell(c, 'th')).join('')}</tr></thead>` : '')
      + `<tbody>${bodyRows.map(r => `<tr>${r.map(c => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`;
  });
  // 段落
  html = html.split(/\n{2,}/).map(p => {
    const t = p.trim();
    if (!t) return '';
    if (/^<(h\d|ul|ol|blockquote|pre|table)/.test(t)) return t;
    if (/^\u0000LONCODE\d+\u0000$/.test(t)) return t; // token 独占段落时不包 <p>，稍后原样还原成顶层代码块
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  // 放回代码块（只匹配真实占位 token，正文数字原样保留）
  html = html.replace(CODE_TOKEN_RE, (m, i) => blocks[Number(i)] ?? m);
  return html;
}

// KaTeX 公式渲染（对 md 渲染结果调用）
function renderMath(el) {
  if (!window.renderMathInElement || !el) return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      ignoredTags: ['script', 'style', 'pre', 'code'],
      throwOnError: false,
    });
  } catch { /* 公式解析失败不影响正文 */ }
}

// ---------- 任务轮询 ----------
async function pollJob(jobId, logEl, onDone) {
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      if (logEl) logEl.textContent = job.logs.join('\n') || '进行中…';
      if (job.status === 'done') { onDone(null, job.result); return; }
      if (job.status === 'failed') { onDone(new Error(job.error || '任务失败')); return; }
      setTimeout(tick, 1200);
    } catch (e) { onDone(e); }
  };
  tick();
}

// ---------- 路由 ----------
const state = { books: [], currentBook: null, currentLesson: null, lessonTab: 'preguide', reviewsTab: 'plan' };

// 视图位置记忆：离开某路由时记下滚动位置，回来时原地恢复（顶栏往返不丢阅读位置）
const viewMemory = new Map(); // hash -> scrollY
let currentHash = null;

// 顶栏「再点一次就返回」：点任何标签记住来路，该标签变成「‹ 返回」；
// 标签页之间横跳时保留最初的来路（链式折叠），不会越陷越深
let navReturnTo = null;    // 要返回的 hash
let navReturnView = null;  // 哪个顶栏标签当前处于「返回」态
const navOrig = new Map(); // data-nav -> 原始 innerHTML（复习里有角标，必须整体存取）

window.addEventListener('hashchange', render);
window.addEventListener('load', async () => {
  await restoreLastChatSession();
  await render();
  refreshBadge();
});

$$('#topbar nav a').forEach(a => {
  navOrig.set(a.dataset.nav, a.innerHTML);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const v = a.dataset.nav;
    const cur = routeInfo();
    const curHash = location.hash || '#/shelf';
    const target = a.getAttribute('href');
    // 已在这个标签页且持有来路 → 再点一次 = 返回
    if (cur.view === v && navReturnView === v && navReturnTo) {
      const to = navReturnTo;
      navReturnTo = null; navReturnView = null;
      location.hash = to;
      return;
    }
    if (curHash === target) return; // 同页无效点击
    // 从另一个「返回态」标签横跳过来 → 保留最初来路；否则记下当前位置
    const hopping = navReturnView && cur.view === navReturnView && navReturnTo;
    if (!hopping) navReturnTo = curHash;
    navReturnView = v;
    location.hash = target;
  });
});

function routeInfo() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/');
  return { view: parts[0] || 'shelf', id: parts[1] ? Number(parts[1]) : null };
}

async function render() {
  const { view, id } = routeInfo();
  const hash = location.hash || '#/shelf';
  if (currentHash && currentHash !== hash) {
    viewMemory.set(currentHash, window.scrollY); // 离开前记住旧页面看到哪
    if (viewMemory.size > 30) viewMemory.delete(viewMemory.keys().next().value);
  }
  currentHash = hash;
  document.body.dataset.view = view;
  $$('#topbar nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === view || (view === 'book' && a.dataset.nav === 'shelf') || (view === 'lesson' && a.dataset.nav === 'shelf') || (view === 'session' && a.dataset.nav === 'reviews'));
    // 「返回」态标签的文案切换（复习标签里有角标，恢复时用开页时存的原始 innerHTML）
    if (view === a.dataset.nav && navReturnView === a.dataset.nav && navReturnTo) {
      a.dataset.returning = '1';
      a.textContent = '‹ 返回';
    } else if (a.dataset.returning) {
      delete a.dataset.returning;
      a.innerHTML = navOrig.get(a.dataset.nav);
    }
  });
  hideAskPop();
  window.TTS?.stop(); // 翻页即停止朗读（音频流与 DOM 无关，主动停避免“幽灵声音”）
  try {
    if (view === 'shelf') await renderShelf();
    else if (view === 'book') await renderBook(id);
    else if (view === 'lesson') await renderLesson(id);
    else if (view === 'reviews') await renderReviews();
    else if (view === 'session') await renderChatSession(id);
    else if (view === 'stats') await renderStats();
    else if (view === 'review') await renderReviewSession(id);
    else if (view === 'terms') await renderTerms();
    else if (view === 'highlights') await renderHighlights();
    else if (view === 'wrong') await renderWrong();
    else if (view === 'settings') await renderSettings();
    else await renderShelf();
  } catch (e) {
    app.innerHTML = `<div class="empty"><span class="emoji">${glyph('err')}</span>${esc(e.message)}</div>`;
  }
  const mem = viewMemory.get(hash);
  if (mem) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, mem)));
  refreshReviewBadge();
  if (chatState.open) paintGlobalChat();
}

async function refreshReviewBadge() {
  try {
    const { count } = await api('/api/reviews/due-count');
    const b = $('#review-badge');
    b.textContent = count > 99 ? '99+' : count;
    b.classList.toggle('hidden', !count);
  } catch { /* ignore */ }
}

// 顶栏主模型徽标：点击弹出选择菜单
async function toggleModelMenu() {
  const menu = $('#model-menu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  const providers = await api('/api/providers');
  const def = providers.find(p => p.is_default) || providers[0];
  menu.innerHTML = `<div class="mm-title">主模型 · 拆课/备课/批改/周报用它</div>` + providerMenuHtml({
    menuKey: 'main',
    providers,
    activeKey: def ? String(def.id) : null,
    currentChip: (p, m) => def && p.id === def.id && m.id === def.default_model,
  });
  menu.classList.remove('hidden');
  bindProviderMenuExpansion(menu, 'main', def ? String(def.id) : null);
  menu.onclick = async e => {
    const chip = e.target.closest('.llm-chip');
    if (!chip) return;
    await api(`/api/providers/${chip.dataset.pid}/default`, { method: 'POST', body: { model: chip.dataset.model } });
    const saved = loadModelMenuExpanded();
    saved.main = chip.dataset.pid;
    saveModelMenuExpanded(saved);
    menu.classList.add('hidden');
    toast(`主模型已切换：${chip.dataset.label}`);
    refreshBadge();
  };
}
window.addEventListener('load', () => {
  $('#provider-badge')?.addEventListener('click', e => { e.stopPropagation(); toggleModelMenu(); });
  document.addEventListener('click', e => {
    const menu = $('#model-menu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) menu.classList.add('hidden');
  });
});

async function refreshBadge() {
  try {
    const ps = await api('/api/providers');
    const def = ps.find(p => p.is_default) || ps[0];
    $('#provider-badge').textContent = def ? `${def.name} · ${def.default_model || '未选模型'}` : '未配置模型';
  } catch { /* ignore */ }
}

// ---------- 书架 ----------
async function renderShelf() {
  state.books = await api('/api/books');
  app.innerHTML = `
    <h1 class="page-title">书架</h1>
    <p class="page-sub">把教材放上来，剩下的交给我。</p>
    <div class="upload-zone" id="upzone">
      <div class="big">拖入教材，或点击选择</div>
      <div>支持 PDF / EPUB / DOCX / Markdown / TXT，单文件 200MB 以内</div>
      <input type="file" id="file-input" class="hidden" accept=".pdf,.epub,.docx,.md,.markdown,.txt">
    </div>
    <div style="text-align:center;margin:-14px 0 30px">
      <button class="ghost" id="import-dir-btn">或导入本地文件夹 / 教程仓库（Markdown 目录树）</button>
    </div>
    <div class="book-grid" id="book-grid"></div>`;

  const zone = $('#upzone'), input = $('#file-input');
  zone.onclick = () => input.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
  input.onchange = () => input.files[0] && upload(input.files[0]);
  $('#import-dir-btn').onclick = openImportDirModal;

  const grid = $('#book-grid');
  if (!state.books.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><span class="emoji">${glyph('empty')}</span>书架还空着。放第一本教材上来吧。</div>`;
    return;
  }
  grid.innerHTML = state.books.map(b => {
    const pct = b.lesson_count ? Math.round(b.done_count / b.lesson_count * 100) : 0;
    const statusTag = {
      parsing: '<span class="tag">解析中</span>', parsed: '<span class="tag">待生成课程</span>',
      outlining: '<span class="tag">拆课中</span>', outlined: '<span class="tag green">课程就绪</span>',
      failed: `<span class="tag red">失败</span>`,
    }[b.status] || '';
    return `<div class="card book-card" data-id="${b.id}">
      <h3 data-act="open">${esc(b.title)}</h3>
      <div class="book-meta"><span class="tag">${esc(b.format || '').toUpperCase()}</span>${statusTag}
        ${b.lesson_count ? `<span>${b.done_count}/${b.lesson_count} 节</span>` : ''}</div>
      ${b.status === 'failed' ? `<div class="book-meta" style="color:var(--rose-deep)">${esc(b.error || '')}</div>` : ''}
      ${b.lesson_count ? `<div class="progress-bar"><i style="width:${pct}%"></i></div>` : ''}
      <div class="book-actions">
        ${b.status === 'parsed' || b.status === 'failed' ? `<button class="small primary" data-act="outline">生成课程</button>` : ''}
        ${b.status === 'outlined' ? (b.last_lesson_id
          ? `<button class="small primary" data-act="resume" data-lid="${b.last_lesson_id}" title="回到上次学到的位置">继续学习</button>`
          : `<button class="small primary" data-act="open">进入学习</button>`) : ''}
        <button class="small ghost" data-act="del">删除</button>
      </div>
    </div>`;
  }).join('');

  grid.onclick = async e => {
    const card = e.target.closest('.book-card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.dataset.act;
    if (act === 'del') {
      if (!confirm('确定删除这本教材及其全部课程与记录？')) return;
      await api(`/api/books/${id}`, { method: 'DELETE' });
      toast('已删除');
      renderShelf();
    } else if (act === 'outline') {
      const { jobId } = await api(`/api/books/${id}/outline`, { method: 'POST', body: {} });
      showJobModal('AI 正在研读教材、规划课程…', jobId, async err => {
        if (err) return toast(err.message, true);
        toast('课程大纲生成好了');
        location.hash = `#/book/${id}`;
      });
    } else if (act === 'resume') {
      location.hash = `#/lesson/${e.target.dataset.lid}`;
    } else if (act === 'open') {
      location.hash = `#/book/${id}`;
    }
  };
}

async function upload(file) {
  const fd = new FormData();
  fd.append('file', file);
  toast(`正在解析《${file.name}》…`);
  try {
    const book = await api('/api/upload', { method: 'POST', body: fd });
    toast(`《${book.title}》解析完成`);
    await renderShelf();
  } catch (e) { toast(e.message, true); }
}

// 课程页统计卡
async function renderBookStats() {
  const el = $('#book-stats');
  if (!el) return;
  try {
    const st = await api('/api/stats');
    const today = new Date();
    const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayMap = new Map(st.timeByDay.map(d => [d.date, d.seconds]));
    const heat = [];
    for (let i = 83; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const min = (dayMap.get(fmtDate(d)) || 0) / 60;
      const lv = min <= 0 ? 0 : min < 15 ? 1 : min < 45 ? 2 : min < 90 ? 3 : 4;
      heat.push({ date: fmtDate(d), lv, min: Math.round(min), dow: d.getDay() });
    }
    const pad = heat[0] ? heat[0].dow : 0;
    const reviewPct = st.reviews.total ? Math.round(st.reviews.done / st.reviews.total * 100) : 0;
    const R = 40, CIRC = 2 * Math.PI * R;
    // 近 14 天柱状图
    const days14 = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      days14.push({ date: fmtDate(d), secs: dayMap.get(fmtDate(d)) || 0, today: i === 0 });
    }
    const maxSecs = Math.max(600, ...days14.map(d => d.secs));
    el.innerHTML = `
      <img class="bs-scarab" src="/scarab.png" alt="">
      <div class="bs-nums">
        <div><b>${fmtMinutes(st.todaySeconds)}</b><span>今日学习</span></div>
        <div><b>${st.streak} 天</b><span>连续学习</span></div>
        <div><b>${st.lessons.avg_score || '—'} 分</b><span>测验均分</span></div>
      </div>
      <div class="bs-main">
        <div>
          <div class="bs-label">学习热力 · 近 12 周</div>
          <div class="heatmap">${'<i class="hm-pad"></i>'.repeat(pad)}${heat.map(h => `<i class="hm lv${h.lv}" title="${h.date} · ${h.min} 分钟"></i>`).join('')}</div>
        </div>
        <div class="bs-ring">
          <div class="bs-label">复习完成率</div>
          <svg width="104" height="104" viewBox="0 0 104 104">
            <circle cx="52" cy="52" r="${R}" fill="none" stroke="var(--line)" stroke-width="8"/>
            <circle cx="52" cy="52" r="${R}" fill="none" stroke="var(--sage)" stroke-width="8"
              stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - reviewPct / 100)}"
              transform="rotate(-90 52 52)"/>
            <text x="52" y="50" text-anchor="middle" class="ring-num" style="font-size:17px">${reviewPct}%</text>
            <text x="52" y="66" text-anchor="middle" class="ring-sub">${st.reviews.done}/${st.reviews.total} 轮</text>
          </svg>
        </div>
        <div class="bs-bars">
          <div class="bs-label">每日学习时长 · 近 14 天</div>
          <div class="bar-chart bs-bar-chart">
            ${days14.map(d => `
              <div class="bar-col" title="${d.date} · ${fmtMinutes(d.secs)}">
                <div class="bar-track"><div class="bar ${d.today ? 'today' : ''}" style="height:${Math.max(2, Math.round(d.secs / maxSecs * 100))}%"></div></div>
                <div class="bar-label">${d.date.slice(8)}</div>
              </div>`).join('')}
          </div>
        </div>
        </div>
      </div>`;
  } catch { el.innerHTML = ''; }
}

// ---------- 文件夹/仓库导入 ----------
async function openImportDirModal() {
  openModal(`
    <h3>导入文件夹 / 教程仓库</h3>
    <p style="font-size:.86rem;color:var(--ink-soft);margin-bottom:14px">把一个 Markdown 目录树合并成一本书（保留文件结构标记），之后照常 AI 拆课、带学、出题。</p>
    <div id="aiedu-section" style="margin-bottom:16px">正在检测 ai-edu 仓库…</div>
    <div><label style="font-size:.82rem;color:var(--ink-faint);letter-spacing:1px">本地目录路径</label>
      <input id="dir-path" placeholder="/Users/.../某个教程文件夹" style="margin-top:6px"></div>
    <div class="modal-actions">
      <button class="ghost" id="dir-cancel">取消</button>
      <button class="primary" id="dir-import">导入此目录</button>
    </div>`);
  $('#dir-cancel').onclick = closeModal;
  $('#dir-import').onclick = () => importDir($('#dir-path').value.trim());

  const sec = $('#aiedu-section');
  try {
    const cat = await api('/api/ai-edu/catalog');
    if (!cat.found || !cat.items.length) {
      sec.innerHTML = `<div style="font-size:.85rem;color:var(--ink-faint)">没在默认位置发现 ai-edu 仓库，可以直接填任意目录路径。</div>`;
      return;
    }
    sec.innerHTML = `<div style="font-size:.82rem;color:var(--ink-faint);letter-spacing:1px;margin-bottom:8px">检测到 ai-edu 仓库，点一个直接导入：</div>` +
      cat.items.map(it => `
        <div class="aiedu-item" data-path="${esc(it.path)}">
          <div class="aiedu-main">
            <span class="aiedu-name">${esc(it.name)}</span>
            <span class="aiedu-meta">${it.fileCount} 篇 · ${it.totalKB}KB</span>
          </div>
          <button class="small ${it.name.includes('A2') ? 'primary' : 'ghost'}" data-act="imp">导入</button>
        </div>`).join('');
    sec.onclick = e => {
      if (e.target.dataset.act !== 'imp') return;
      importDir(e.target.closest('.aiedu-item').dataset.path);
    };
  } catch {
    sec.innerHTML = `<div style="font-size:.85rem;color:var(--ink-faint)">检测失败，可以直接填目录路径。</div>`;
  }
}

async function importDir(dirPath) {
  if (!dirPath) return toast('先填目录路径', true);
  toast('正在合并目录…');
  try {
    const book = await api('/api/import-dir', { method: 'POST', body: { path: dirPath } });
    closeModal();
    toast(`《${book.title}》导入完成：${book.fileCount} 篇，${Math.round(book.totalChars / 1000)}k 字`);
    renderShelf();
  } catch (e) { toast(e.message, true); }
}

function showJobModal(title, jobId, onDone) {
  openModal(`<h3>${esc(title)}</h3><div class="job-log">启动中…</div>`);
  pollJob(jobId, $('.job-log'), (err, result) => {
    closeModal();
    onDone(err, result);
  });
}

// ---------- 课程页 ----------
async function renderBook(id) {
  const book = await api(`/api/books/${id}`);
  state.currentBook = book;
  const pending = [];
  for (const m of book.outline) for (const l of m.lessons) if (l.status !== 'ready') pending.push(l);
  let lastLesson = null;
  if (book.last_lesson_id) {
    for (const m of book.outline) for (const l of m.lessons) if (l.id === book.last_lesson_id) lastLesson = l;
  }

  app.innerHTML = `
    <h1 class="page-title">${esc(book.title)}</h1>
    <p class="page-sub">${book.outline.length} 个模块 · ${book.outline.reduce((n, m) => n + m.lessons.length, 0)} 节课
      ${pending.length ? ` · ${pending.length} 节待备课` : ' · 全部备好了'}</p>
    <div class="course-layout">
      <aside class="card outline-panel" id="outline"></aside>
      <section>
        <div class="card" style="padding:26px 30px">
          <h2 style="font-family:var(--serif);margin-bottom:10px">课程地图 ${lastLesson ? `<span style="font-size:.78rem;color:var(--ink-faint);font-weight:400;letter-spacing:1px">上次学到《${esc(lastLesson.title)}》</span>` : ''}</h2>
          <p style="color:var(--ink-soft);font-size:.93rem;margin-bottom:18px">点左侧任意一节课开始学习。还没备课的课节点进去后，AI 会现场备：课前引导、精读讲义、术语表、课后题，一次到位。</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            ${lastLesson ? `<button class="primary" id="resume-lesson">继续学习</button>` : ''}
            ${pending.length ? `<button class="${lastLesson ? 'ghost' : 'primary'}" id="gen-all">全部备课（${pending.length} 节）</button>` : ''}
            <button class="ghost" id="re-outline">重新规划课程</button>
          </div>
          <div class="job-log hidden" id="batch-log" style="margin-top:16px"></div>
        </div>
        <div class="card stat-panel book-stats" id="book-stats"><div class="chat-empty">…</div></div>
      </section>
    </div>`;
  renderOutlinePanel(book, null);
  renderBookStats();

  $('#resume-lesson')?.addEventListener('click', () => { location.hash = `#/lesson/${book.last_lesson_id}`; });
  $('#re-outline').onclick = async () => {
    if (!confirm('重新规划会清空现有课程与学习记录，确定？')) return;
    const { jobId } = await api(`/api/books/${id}/outline`, { method: 'POST', body: {} });
    showJobModal('重新研读教材、规划课程…', jobId, async err => {
      if (err) return toast(err.message, true);
      toast('已重新生成');
      renderBook(id);
    });
  };
  $('#gen-all')?.addEventListener('click', async () => {
    const logEl = $('#batch-log');
    logEl.classList.remove('hidden');
    const btn = $('#gen-all');
    btn.disabled = true;
    for (let i = 0; i < pending.length; i++) {
      const l = pending[i];
      logEl.textContent += `\n[${i + 1}/${pending.length}] 备课《${l.title}》…`;
      try {
        const { jobId } = await api(`/api/lessons/${l.id}/generate`, { method: 'POST', body: {} });
        if (jobId) await new Promise(res => pollJob(jobId, null, err => { if (err) logEl.textContent += ` ✗ ${err.message}`; else logEl.textContent += ' ✓'; res(); }));
      } catch (e) { logEl.textContent += ` ✗ ${e.message}`; }
    }
    logEl.textContent += '\n全部完成。';
    toast('批量备课完成');
    renderBook(id);
  });
}

function renderOutlinePanel(book, activeLessonId) {
  const el = $('#outline');
  if (!el) return;
  el.innerHTML = `<h2>目录</h2>` + book.outline.map((m, mi) => `
    <div class="module-block">
      <div class="module-title"><span class="module-no">${String(mi + 1).padStart(2, '0')}</span>${esc(m.title)}</div>
      ${m.summary ? `<div class="module-summary">${esc(m.summary)}</div>` : ''}
      ${m.lessons.map(l => `
        <div class="lesson-item ${l.id === activeLessonId ? 'active' : ''}" data-lesson="${l.id}">
          <i class="dot ${l.study_status === 'done' ? 'done' : l.status === 'ready' ? 'ready' : ''}"></i>
          <span>${esc(l.title)}</span>
          ${l.quiz_score != null ? `<span class="score">${l.quiz_score}</span>` : ''}
        </div>`).join('')}
    </div>`).join('');
  el.onclick = e => {
    const item = e.target.closest('[data-lesson]');
    if (item) location.hash = `#/lesson/${item.dataset.lesson}`;
  };
}

// ---------- 课节学习 ----------
async function renderLesson(id) {
  // 重建前记下目录滚动位置（同书切换课节时保持目录不跳顶）
  const prevBookId = state.currentBook?.id ?? null;
  const prevOutlineScroll = $('#outline')?.scrollTop ?? null;
  const lesson = await api(`/api/lessons/${id}`);
  state.currentLesson = lesson;
  const book = await api(`/api/books/${lesson.book_id}`);
  state.currentBook = book;

  app.innerHTML = `
    <a class="back-link" href="#/book/${book.id}">${esc(book.title)}</a>
    <div class="course-layout has-dividers" id="course-layout">
      <aside class="card outline-panel" id="outline"></aside>
      <div class="col-divider" data-side="left" title="拖动调整栏宽"></div>
      <section id="lesson-main"></section>
    </div>`;
  renderOutlinePanel(book, id);
  const ol = $('#outline');
  if (ol) {
    if (prevBookId === book.id && prevOutlineScroll != null) ol.scrollTop = prevOutlineScroll;
    else {
      const act = ol.querySelector('.lesson-item.active');
      if (act) ol.scrollTop += act.getBoundingClientRect().top - ol.getBoundingClientRect().top - ol.clientHeight / 2 + act.clientHeight / 2;
    }
  }
  initColDividers();

  const main = $('#lesson-main');
  if (lesson.status !== 'ready') {
    main.innerHTML = `
      <div class="lesson-head"><h1>${esc(lesson.title)}</h1><p class="goal">${esc(lesson.goal || '')}</p></div>
      <div class="card" style="padding:40px;text-align:center">
        ${lesson.status === 'failed' ? `<p style="color:var(--rose-deep);margin-bottom:14px">上次备课失败：${esc(lesson.gen_error || '')}</p>` : `<p style="color:var(--ink-soft);margin-bottom:14px">这节课还没备课。AI 会读教材原文，为你准备课前引导、精读讲义、术语表和课后题。</p>`}
        <button class="primary" id="gen-lesson">开始备课</button>
        <div class="job-log hidden" id="gen-log" style="margin-top:18px;text-align:left"></div>
      </div>`;
    $('#gen-lesson').onclick = async () => {
      const logEl = $('#gen-log');
      logEl.classList.remove('hidden');
      $('#gen-lesson').disabled = true;
      try {
        const { jobId } = await api(`/api/lessons/${id}/generate`, { method: 'POST', body: {} });
        pollJob(jobId, logEl, err => {
          if (err) { toast(err.message, true); renderLesson(id); return; }
          renderLesson(id);
        });
      } catch (e) { toast(e.message, true); renderLesson(id); }
    };
    return;
  }

  // 已就绪：四页签
  if (lesson.study_status === 'new') api(`/api/lessons/${id}/study-status`, { method: 'POST', body: { status: 'studying' } }).catch(() => {});
  const terms = JSON.parse(lesson.terms || '[]');
  const quiz = JSON.parse(lesson.quiz || '[]');

  main.innerHTML = `
    <div class="lesson-sticky">
      <div class="lesson-head">
        <h1>${esc(lesson.title)}</h1>
        <p class="goal">${esc(lesson.goal || '')}${lesson.est_minutes ? ` · 约 ${lesson.est_minutes} 分钟` : ''}</p>
      </div>
      <div class="tabs">
        <button data-tab="preguide">课前引导</button>
        <button data-tab="content">精读讲义</button>
        <button data-tab="terms">术语 <span class="tab-count">${terms.length}</span></button>
        <button data-tab="quiz">课后测验 <span class="tab-count">${quiz.length}</span></button>
        <button class="chat-toggle tts-toggle" id="tts-toggle" title="把这一页读给你听（Edge TTS）">▸ 朗读</button>
        <button class="chat-toggle" id="chat-toggle" title="和老师聊聊">✎ 问老师</button>
      </div>
      <div id="tts-bar" class="hidden">
        <span class="tts-dot"></span>
        <button id="tts-pause" title="暂停">❚❚</button>
        <div class="tts-readout">
          <span id="tts-seg"></span>
          <div class="tts-progress-row">
            <input id="tts-progress" type="range" min="0" max="1000" value="0" step="1" aria-label="朗读进度，拖动可跳转">
            <output id="tts-percent" for="tts-progress">0%</output>
          </div>
        </div>
        <button id="tts-stop" title="停止">✕</button>
      </div>
    </div>
    <div class="card lesson-body" id="tab-body"></div>`;

  $$('.tabs button[data-tab]', main).forEach(b => b.onclick = () => { state.lessonTab = b.dataset.tab; paintTab(); });
  $('#chat-toggle')?.addEventListener('click', () => toggleGlobalChat(true));
  TTS.bindLesson();

  function paintTab() {
    $$('.tabs button', main).forEach(b => b.classList.toggle('active', b.dataset.tab === state.lessonTab));
    const body = $('#tab-body');
    if (state.lessonTab === 'preguide') {
      body.innerHTML = `<div class="markdown js-askable">${md(lesson.preguide)}</div>
        <div style="margin-top:22px;color:var(--ink-soft);font-size:.85rem">读完引导，去「精读讲义」。选中任何不懂的文字可以直接提问。</div>`;
      renderMath(body);
      paintLessonMarks(lesson);
    } else if (state.lessonTab === 'content') {
      body.innerHTML = `<div class="markdown js-askable">${md(lesson.content)}</div>`;
      renderMath(body);
      paintLessonMarks(lesson);
    } else if (state.lessonTab === 'terms') {
      body.innerHTML = terms.length ? `<div class="term-list">${terms.map(t => `
        <div class="card term-item"><span class="term">${esc(t.term)}</span><span class="anno js-askable">${esc(t.annotation)}</span></div>`).join('')}</div>`
        : `<div class="empty">这节课没有提取术语</div>`;
    } else {
      renderQuiz(body, lesson, quiz);
    }
  }
  paintTab();
}

// ---------- 测验 ----------
// 选项行显式点击选中（不依赖 label 默认行为）+ 草稿持久化（切 tab 不丢答案）+ 空答案交卷拦截
function wireQuizForm(body, quiz, draftKey, prefix = 'q') {
  const collect = () => quiz.map((q, i) => q.type === 'choice'
    ? ($$(`input[name="${prefix}${i}"]`, body).find(r => r.checked)?.value || '')
    : ($(`textarea[name="${prefix}${i}"]`, body)?.value || ''));
  $$('.quiz-opt', body).forEach(lab => lab.addEventListener('click', () => {
    const r = lab.querySelector('input[type=radio]');
    if (r) r.checked = true;
  }));
  if (draftKey) {
    state.quizDrafts ||= {};
    const draft = state.quizDrafts[draftKey] || [];
    quiz.forEach((q, i) => {
      const v = draft[i];
      if (!v) return;
      if (q.type === 'choice') {
        const r = $$(`input[name="${prefix}${i}"]`, body).find(x => x.value === v);
        if (r) r.checked = true;
      } else {
        const ta = $(`textarea[name="${prefix}${i}"]`, body);
        if (ta) ta.value = v;
      }
    });
    const save = () => { state.quizDrafts[draftKey] = collect(); };
    body.addEventListener('change', save);
    body.addEventListener('input', save);
  }
  return collect;
}

// 空答案拦截：第一次点交卷时标红未作答题卡并要求二次确认
function quizGuardEmpty(collect, body, btn) {
  const answers = collect();
  const emptyIdx = answers.map((a, i) => (a || '').trim() ? -1 : i).filter(i => i >= 0);
  if (emptyIdx.length && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    $$('.quiz-q', body).forEach((el, i) => el.classList.toggle('quiz-empty', emptyIdx.includes(i)));
    const nums = emptyIdx.map(i => i + 1).join('、');
    toast(`第 ${nums} 题还没作答（已标红），再点一次交卷确认提交`);
    setTimeout(() => { btn.dataset.armed = ''; }, 8000);
    return { pass: false, answers };
  }
  $$('.quiz-q', body).forEach(el => el.classList.remove('quiz-empty'));
  return { pass: true, answers };
}

function renderQuiz(body, lesson, quiz) {
  if (!quiz.length) { body.innerHTML = `<div class="empty">这节课没有题目</div>`; return; }
  body.innerHTML = `
    <div id="quiz-form">
      ${quiz.map((q, i) => `
        <div class="card quiz-q" data-i="${i}">
          <div class="q-title">${i + 1}. ${esc(q.question)}<span class="q-type">${q.type === 'choice' ? '选择' : '简答'}</span></div>
          ${q.type === 'choice'
            ? (q.options || []).map((op, oi) => `<label class="quiz-opt"><input type="radio" name="q${i}" value="${'ABCD'[oi]}"> ${esc(op)}</label>`).join('')
            : `<textarea name="q${i}" rows="3" placeholder="写下你的回答…"></textarea>`}
        </div>`).join('')}
      <button class="primary" id="submit-quiz" style="margin-top:6px">交卷</button>
    </div>
    <div id="quiz-result" class="hidden"></div>`;

  const collect = wireQuizForm(body, quiz, `lesson-${lesson.id}`);
  $('#submit-quiz').onclick = async () => {
    const btn = $('#submit-quiz');
    const { pass, answers } = quizGuardEmpty(collect, body, btn);
    if (!pass) return;
    btn.disabled = true;
    btn.textContent = '批改中…';
    try {
      const { total, results } = await api(`/api/lessons/${lesson.id}/grade`, { method: 'POST', body: { answers } });
      delete state.quizDrafts?.[`lesson-${lesson.id}`];
      paintQuizResult(body, quiz, results, total);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '交卷';
    }
  };
}

function paintQuizResult(body, quiz, results, total) {
  const res = $('#quiz-result');
  res.classList.remove('hidden');
  const wrong = results.filter(r => !r.correct && !r.ungraded).length;
  const ungraded = results.filter(r => r.ungraded).length;
  res.innerHTML = `<div class="card quiz-result-banner" style="border-color:${wrong ? 'var(--rose)' : 'var(--sage)'}">
    得分 <b style="font-size:1.5em">${total}</b> 分${wrong ? ` · ${wrong} 道题进了错题本` : ' · 全对，漂亮！'}${ungraded ? ` · ${ungraded} 题未批改（未计分）` : ''}</div>`;
  for (const r of results) {
    const qEl = $(`.quiz-q[data-i="${r.index}"]`, body);
    if (!qEl) continue;
    if (r.type === 'choice') {
      $$('.quiz-opt', qEl).forEach((lab, oi) => {
        const letter = 'ABCD'[oi];
        lab.classList.remove('picked');
        if (letter === String(r.correct_answer).trim().toUpperCase()) lab.classList.add('right');
        else if (letter === r.user_answer.toUpperCase()) lab.classList.add('wrong');
      });
    }
    qEl.insertAdjacentHTML('beforeend', `<div class="quiz-feedback">
      ${r.ungraded ? '○ 未批改（未计分、未记入错题本）' : r.correct ? '✓ 回答正确' : `✗ 你的答案：${esc(r.user_answer || '（空）')} · 正确答案：${esc(r.correct_answer)}`}<br>${esc(r.feedback || '')}</div>`);
  }
  $('#submit-quiz')?.remove();
  res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 划词提问 ----------
const askPop = $('#ask-pop');
let askSelection = '';

document.addEventListener('mouseup', e => {
  if (askPop.contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || '';
    const anchor = sel?.anchorNode?.parentElement;
    if (text.length >= 2 && anchor?.closest?.('.js-askable')) {
      askSelection = text;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      askPop.style.left = `${Math.min(r.left + r.width / 2 - 50, window.innerWidth - 140)}px`;
      askPop.style.top = `${r.bottom + window.scrollY + 8}px`;
      askPop.classList.remove('hidden');
    } else {
      hideAskPop();
    }
  }, 10);
});
document.addEventListener('mousedown', e => { if (!askPop.contains(e.target)) hideAskPop(); });
function hideAskPop() { askPop.classList.add('hidden'); }

$('#ask-pop-btn').addEventListener('click', () => {
  hideAskPop();
  chatState.pendingSelection = askSelection;
  toggleGlobalChat(true);
});

$('#hl-pop-btn').addEventListener('click', () => {
  const sel0 = window.getSelection();
  const selRect = sel0 && sel0.rangeCount ? sel0.getRangeAt(0).getBoundingClientRect() : null;
  hideAskPop();
  const lesson = state.currentLesson;
  if (!lesson) return toast('打开一节课再划线', true);
  // 抓取选中处所在段落作为「原文段落」
  let passage = '';
  try {
    const node = sel0?.anchorNode;
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const block = el?.closest?.('p, li, blockquote, h1, h2, h3, h4');
    passage = (block?.textContent || '').trim().slice(0, 600);
  } catch { /* ignore */ }
  hlPending = { text: askSelection, passage, lesson_id: lesson.id, book_id: lesson.book_id };
  showHlNoteCard(selRect);
});

// ---------- 划线感想 + 原文留痕 ----------
let hlPending = null;   // 待保存的划线 {text, passage, lesson_id, book_id}
let hlCardEl = null;    // 划线感想卡
let hlViewEl = null;    // 划线回看卡

// 把浮动卡片放到目标矩形附近：默认下方，下方放不下就翻到上方（卡片是 position:fixed，rect 用视口坐标）
function placeHlCard(el, rect) {
  el.classList.remove('hidden');
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(Math.max(12, (rect ? rect.left : 60) - 40), window.innerWidth - w - 12);
  let top;
  if (rect) {
    top = rect.bottom + 10;
    if (top + h > window.innerHeight - 12) top = Math.max(8, rect.top - h - 10);
  } else {
    top = 80;
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showHlNoteCard(rect) {
  if (!hlCardEl) {
    hlCardEl = document.createElement('div');
    hlCardEl.id = 'hl-note-card';
    hlCardEl.className = 'hl-float-card hidden';
    hlCardEl.innerHTML = `
      <div class="hl-float-title">划线留念</div>
      <div class="hl-float-quote"></div>
      <textarea rows="3" placeholder="写点此刻的感想…（可留空）"></textarea>
      <div class="hl-float-actions">
        <button class="ghost small" data-act="cancel">取消</button>
        <button class="primary small" data-act="save">保存划线</button>
      </div>`;
    document.body.appendChild(hlCardEl);
    hlCardEl.querySelector('[data-act="cancel"]').onclick = hideHlNoteCard;
    hlCardEl.querySelector('[data-act="save"]').onclick = saveHlFromCard;
  }
  hlCardEl.querySelector('.hl-float-quote').textContent = '「' + (hlPending.text.length > 60 ? hlPending.text.slice(0, 60) + '…' : hlPending.text) + '」';
  const ta = hlCardEl.querySelector('textarea');
  ta.value = '';
  placeHlCard(hlCardEl, rect);
  setTimeout(() => ta.focus(), 60);
}
function hideHlNoteCard() { hlCardEl?.classList.add('hidden'); hlPending = null; }

async function saveHlFromCard() {
  if (!hlPending) return;
  const note = hlCardEl.querySelector('textarea').value.trim();
  const pending = hlPending;
  hideHlNoteCard();
  try {
    await api('/api/highlights', { method: 'POST', body: { ...pending, note } });
    toast('已划线，收进划线页了');
    if (state.currentLesson) paintLessonMarks(state.currentLesson);
  } catch (e) { toast(e.message, true); }
}

// 在渲染好的讲义里把划线句子包上 mark（空白归一化匹配，支持跨内联元素）
function wrapQuote(root, h) {
  const target = h.text.replace(/\s+/g, '');
  if (!target) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.parentElement.closest('mark.hl-mark, .katex, pre, code')) continue;
    nodes.push(n);
  }
  let joined = '';
  const map = []; // 每个归一化字符 → {node, offset}
  for (const tn of nodes) {
    const t = tn.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      joined += t[i];
      map.push({ node: tn, offset: i });
    }
  }
  const idx = joined.indexOf(target);
  if (idx < 0) return;
  const byNode = new Map();
  for (let i = idx; i < idx + target.length; i++) {
    const m = map[i];
    if (!byNode.has(m.node)) byNode.set(m.node, []);
    byNode.get(m.node).push(m.offset);
  }
  for (const [tn, offsets] of byNode) {
    const range = document.createRange();
    range.setStart(tn, Math.min(...offsets));
    range.setEnd(tn, Math.max(...offsets) + 1);
    const mark = document.createElement('mark');
    mark.className = 'hl-mark';
    mark.dataset.hl = h.id;
    try { range.surroundContents(mark); } catch { /* 个别段落包不上就跳过 */ }
  }
}

async function paintLessonMarks(lesson) {
  try {
    const all = await api(`/api/highlights?book_id=${lesson.book_id}`);
    const marks = all.filter(h => h.lesson_id === lesson.id);
    state.lessonMarks = Object.fromEntries(marks.map(h => [String(h.id), h]));
    for (const h of marks) for (const root of $$('.js-askable')) wrapQuote(root, h);
  } catch { /* 划线留痕失败不影响阅读 */ }
}

// 点划线句子 → 回看卡（感想 / 编辑 / 删除）
function showHlViewCard(mark, h) {
  if (!hlViewEl) {
    hlViewEl = document.createElement('div');
    hlViewEl.id = 'hl-view-card';
    hlViewEl.className = 'hl-float-card hidden';
    document.body.appendChild(hlViewEl);
  }
  const paint = (editing) => {
    hlViewEl.innerHTML = `
      <div class="hl-float-title">划线 · ${(h.created_at || '').slice(0, 10)}</div>
      <div class="hl-float-quote"></div>
      ${editing
        ? `<textarea rows="3" placeholder="写点感想…"></textarea>`
        : `<div class="hlv-note ${h.note ? '' : 'empty'}">${h.note ? esc(h.note) : '当时没写感想'}</div>`}
      <div class="hl-float-actions">
        <button class="ghost small" data-act="del">删除</button>
        ${editing
          ? `<button class="ghost small" data-act="cancel">取消</button><button class="primary small" data-act="save">保存</button>`
          : `<button class="ghost small" data-act="close">合上</button><button class="primary small" data-act="edit">${h.note ? '编辑感想' : '补写感想'}</button>`}
      </div>`;
    hlViewEl.querySelector('.hl-float-quote').textContent = '「' + (h.text.length > 60 ? h.text.slice(0, 60) + '…' : h.text) + '」';
    const ta = hlViewEl.querySelector('textarea');
    if (ta) { ta.value = h.note || ''; setTimeout(() => ta.focus(), 60); }
    // 注意：paint() 重绘 innerHTML 会让被点按钮脱离 DOM，必须 stopPropagation，
    // 否则事件冒泡到 document 时 closest('#hl-view-card') 失配，卡片被误判为「点外面」而关闭
    const on = (act, fn) => hlViewEl.querySelector(`[data-act="${act}"]`)?.addEventListener('click', ev => { ev.stopPropagation(); fn(ev); });
    on('close', hideHlViewCard);
    on('cancel', () => paint(false));
    on('edit', () => paint(true));
    on('save', async () => {
      const note = ta.value.trim();
      await api(`/api/highlights/${h.id}`, { method: 'PUT', body: { note } });
      h.note = note || null;
      state.lessonMarks[String(h.id)] = h;
      paint(false);
      toast('感想已保存');
    });
    on('del', async () => {
      await api(`/api/highlights/${h.id}`, { method: 'DELETE' });
      delete state.lessonMarks[String(h.id)];
      $$(`mark.hl-mark[data-hl="${h.id}"]`).forEach(m => m.replaceWith(...m.childNodes));
      hideHlViewCard();
      toast('已删除这条划线');
    });
  };
  paint(false);
  const r = mark.getBoundingClientRect();
  placeHlCard(hlViewEl, r);
}
function hideHlViewCard() { hlViewEl?.classList.add('hidden'); }

document.addEventListener('click', e => {
  if (hlViewEl && e.composedPath().includes(hlViewEl)) return;
  const mark = e.target.closest('mark.hl-mark');
  if (mark && state.lessonMarks?.[mark.dataset.hl]) {
    showHlViewCard(mark, state.lessonMarks[mark.dataset.hl]);
  } else {
    hideHlViewCard();
  }
});
document.addEventListener('mousedown', e => {
  if (hlCardEl && !hlCardEl.contains(e.target) && !e.target.closest('#hl-pop-btn')) hideHlNoteCard();
});

// ---------- 术语卡 ----------
async function renderTerms() {
  const books = await api('/api/books');
  const outlined = books.filter(b => b.status === 'outlined');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let bookId = Number(params.get('book')) || outlined[0]?.id;
  if (!outlined.length) {
    app.innerHTML = `<h1 class="page-title">术语卡</h1><div class="empty"><span class="emoji">${glyph('scarab')}</span>还没有术语。先上传教材、生成课程吧。</div>`;
    return;
  }
  const terms = await api(`/api/books/${bookId}/terms`);
  app.innerHTML = `
    <h1 class="page-title">术语卡</h1>
    <p class="page-sub">左边点一张，右边细看。把教材里的专有名词一张张啃下来。</p>
    <div class="filter-row">
      <label>教材</label>
      <select id="term-book">${outlined.map(b => `<option value="${b.id}" ${b.id === bookId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}</select>
      <span style="color:var(--ink-soft);font-size:.88rem">${terms.length} 张</span>
      <button class="small ghost" id="tshuffle" style="margin-left:auto">打乱顺序</button>
    </div>
    <div id="term-stage"></div>`;
  $('#term-book').onchange = e => { location.hash = `#/terms?book=${e.target.value}`; renderTerms(); };

  const stage = $('#term-stage');
  if (!terms.length) {
    stage.innerHTML = `<div class="empty"><span class="emoji">${glyph('scarab')}</span>这本书还没有术语，备完课就会有了。</div>`;
    return;
  }

  const order = terms.map((_, i) => i);
  let cur = 0;
  let showSource = false;
  const sourceCache = {};

  async function toggleSource() {
    showSource = !showSource;
    paint();
  }

  async function fillSource() {
    const t = terms[order[cur]];
    const panel = $('#source-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="chat-empty">调取原文中…</div>';
    if (!sourceCache[t.lesson_id]) {
      try {
        const r = await api(`/api/lessons/${t.lesson_id}/source`);
        sourceCache[t.lesson_id] = r.excerpt;
      } catch (e) {
        panel.innerHTML = `<div class="chat-empty">✕ ${esc(e.message)}</div>`;
        return;
      }
    }
    // 走完整 markdown + KaTeX 渲染，再把首个术语出现处高亮
    let html = md(sourceCache[t.lesson_id]);
    const term = esc(t.term);
    const idx = html.indexOf(term);
    if (idx >= 0) html = html.slice(0, idx) + '<mark>' + term + '</mark>' + html.slice(idx + term.length);
    panel.innerHTML = `
      <div class="src-head"><span class="src-title">《${esc(t.lesson_title)}》原文节录</span><button class="small ghost" id="src-close">收起</button></div>
      <div class="src-body markdown">${html}</div>`;
    renderMath($('.src-body', panel));
    $('#src-close').onclick = toggleSource;
    const mark = $('mark', panel);
    if (mark) mark.scrollIntoView({ block: 'center' });
  }

  function paint() {
    stage.innerHTML = `
      <div class="terms-layout ${showSource ? 'with-source' : ''}" id="terms-layout">
        <div class="terms-list" id="terms-list">
          ${order.map((ti, pos) => `
            <div class="term-row ${pos === cur ? 'active' : ''}" data-pos="${pos}">
              <div class="t-name">${esc(terms[ti].term)}</div>
              <div class="t-src">${esc(terms[ti].lesson_title)}</div>
            </div>`).join('')}
        </div>
        <div class="col-divider" data-tside="left" title="拖动调整栏宽"></div>
        <div class="terms-detail" id="terms-detail"></div>
        ${showSource ? '<div class="col-divider" data-tside="right" title="拖动调整栏宽"></div><div class="card source-panel" id="source-panel"></div>' : ''}
      </div>`;
    paintDetail();
    initTermsDividers();
    if (showSource) fillSource();
    $('#terms-list').onclick = e => {
      const row = e.target.closest('.term-row');
      if (!row) return;
      cur = Number(row.dataset.pos);
      $$('.term-row', stage).forEach(r => r.classList.toggle('active', r === row));
      paintDetail();
      if (showSource) fillSource();
    };
    $('.term-row.active', stage)?.scrollIntoView({ block: 'nearest' });
  }

  function paintDetail() {
    const t = terms[order[cur]];
    $('#terms-detail').innerHTML = `
      <div class="card term-detail-card">
        <div class="td-term">${esc(t.term)}</div>
        <div class="td-divider">𓋹</div>
        <div class="td-anno">${esc(t.annotation)}</div>
        <button class="td-src" id="td-src" title="点我看教材原文">${showSource ? '收起原文' : `出自《${esc(t.lesson_title)}`} · ${cur + 1} / ${order.length}</button>
        <div class="td-nav">
          <button class="ghost" id="td-prev">← 上一张</button>
          <button class="ghost" id="td-next">下一张 →</button>
        </div>
      </div>`;
    $('#td-src').onclick = toggleSource;
    $('#td-prev').onclick = () => { cur = (cur - 1 + order.length) % order.length; paint(); };
    $('#td-next').onclick = () => { cur = (cur + 1) % order.length; paint(); };
  }

  $('#tshuffle').onclick = () => { order.sort(() => Math.random() - .5); cur = 0; paint(); };
  paint();
}

// 术语卡三栏拖拽
function initTermsDividers(leftSel = '#terms-list') {
  const layout = $('#terms-layout');
  if (!layout) return;
  const savedL = Number(localStorage.getItem('learnloop.termsColL'));
  const savedR = Number(localStorage.getItem('learnloop.termsColR'));
  if (savedL) layout.style.setProperty('--tl', savedL + 'px');
  if (savedR) layout.style.setProperty('--tr', savedR + 'px');
  $$('.col-divider', layout).forEach(div => {
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      const side = div.dataset.tside;
      const startX = e.clientX;
      const target = side === 'left' ? $(leftSel) : $('#source-panel');
      const startW = target.getBoundingClientRect().width;
      div.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = ev => {
        const dx = ev.clientX - startX;
        if (side === 'left') {
          const w = Math.round(Math.min(440, Math.max(200, startW + dx)));
          layout.style.setProperty('--tl', w + 'px');
          localStorage.setItem('learnloop.termsColL', w);
        } else {
          const w = Math.round(Math.min(760, Math.max(300, startW - dx)));
          layout.style.setProperty('--tr', w + 'px');
          localStorage.setItem('learnloop.termsColR', w);
        }
      };
      const up = () => {
        div.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

// ---------- 划线 ----------
async function renderHighlights() {
  const books = await api('/api/books');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const bookId = Number(params.get('book')) || null;
  const items = await api('/api/highlights' + (bookId ? `?book_id=${bookId}` : ''));
  app.innerHTML = `
    <h1 class="page-title">划线</h1>
    <p class="page-sub">读讲义时划下的句子都在这。点一条，右边看它和原文段落。</p>
    <div class="filter-row">
      <label>教材</label>
      <select id="hl-book">
        <option value="">全部</option>
        ${books.map(b => `<option value="${b.id}" ${b.id === bookId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}
      </select>
      <span style="color:var(--ink-soft);font-size:.88rem">${items.length} 条</span>
    </div>
    <div id="hl-stage"></div>`;
  $('#hl-book').onchange = e => { location.hash = e.target.value ? `#/highlights?book=${e.target.value}` : '#/highlights'; renderHighlights(); };

  const stage = $('#hl-stage');
  if (!items.length) {
    stage.innerHTML = `<div class="empty"><span class="emoji">${glyph('empty')}</span>还没有划线。读讲义时选中句子，点「划线」就收进来了。</div>`;
    return;
  }
  let cur = 0;
  let showSource = false;
  let lessonCache = {};

  async function toggleHlSource() {
    showSource = !showSource;
    paint();
  }

  async function fillHlSource() {
    const h = items[cur];
    const panel = $('#source-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="chat-empty">调取原文中…</div>';
    if (!h.lesson_id) {
      panel.innerHTML = '<div class="chat-empty">这条划线没有关联课节</div>';
      return;
    }
    if (!lessonCache[h.lesson_id]) {
      try {
        lessonCache[h.lesson_id] = await api(`/api/lessons/${h.lesson_id}`);
      } catch (e) {
        panel.innerHTML = `<div class="chat-empty">✕ ${esc(e.message)}</div>`;
        return;
      }
    }
    const content = lessonCache[h.lesson_id].content || h.passage || '（这节课还没有讲义）';
    // 展示完整讲义原文；用划线句子的开头做软锚点定位高亮
    let html = md(content);
    const anchor = esc(h.text.slice(0, 12));
    const idx = html.indexOf(anchor);
    if (idx >= 0) html = html.slice(0, idx) + '<mark>' + anchor + '</mark>' + html.slice(idx + anchor.length);
    panel.innerHTML = `
      <div class="src-head"><span class="src-title">《${esc(h.lesson_title || '')}》讲义原文</span><button class="small ghost" id="src-close">收起</button></div>
      <div class="src-body markdown">${html}</div>`;
    renderMath($('.src-body', panel));
    $('#src-close').onclick = toggleHlSource;
    const mark = $('mark', panel);
    if (mark) mark.scrollIntoView({ block: 'center' });
  }

  function paint() {
    stage.innerHTML = `
      <div class="terms-layout ${showSource ? 'with-source' : ''}" id="terms-layout">
        <div class="terms-list" id="hl-list">
          ${items.map((h, i) => `
            <div class="term-row ${i === cur ? 'active' : ''}" data-i="${i}">
              <div class="t-name">${esc(h.text.length > 40 ? h.text.slice(0, 40) + '…' : h.text)}</div>
              <div class="t-src">${esc(h.book_title || '')} · ${esc(h.lesson_title || '综合')} · ${(h.created_at || '').slice(5, 10)}</div>
            </div>`).join('')}
        </div>
        <div class="col-divider" data-tside="left" title="拖动调整栏宽"></div>
        <div class="terms-detail" id="hl-detail"></div>
        ${showSource ? '<div class="col-divider" data-tside="right" title="拖动调整栏宽"></div><div class="card source-panel" id="source-panel"></div>' : ''}
      </div>`;
    paintDetail();
    initTermsDividers('#hl-list');
    if (showSource) fillHlSource();
    $('#hl-list').onclick = e => {
      const row = e.target.closest('.term-row');
      if (!row) return;
      cur = Number(row.dataset.i);
      $$('.term-row', stage).forEach(r => r.classList.toggle('active', r === row));
      paintDetail();
      if (showSource) fillHlSource();
    };
    $('.term-row.active', stage)?.scrollIntoView({ block: 'nearest' });
  }

  function paintDetail(editNote = false) {
    const h = items[cur];
    $('#hl-detail').innerHTML = `
      <div class="card term-detail-card hl-detail-card">
        <div class="hl-glyph">❝</div>
        <div class="td-anno" style="font-size:1.15rem">${esc(h.text)}</div>
        ${h.passage ? `
          <div class="hl-passage">
            <div class="hl-passage-label">原文段落</div>
            <div class="hl-passage-text">${esc(h.passage)}</div>
          </div>` : ''}
        <div class="hl-note-block">
          <div class="hl-passage-label">我的感想</div>
          ${editNote
            ? `<textarea id="hl-note-ta" rows="3" placeholder="写点感想…">${esc(h.note || '')}</textarea>`
            : `<div class="hl-note-text ${h.note ? '' : 'empty'}">${h.note ? esc(h.note) : '当时没写感想'}</div>`}
        </div>
        <button class="td-src" id="hl-src" title="点我看讲义原文">${showSource ? '收起原文' : `出自《${esc(h.lesson_title || '')}》`} · ${esc(h.book_title || '')} · ${(h.created_at || '').slice(0, 10)}</button>
        <div class="td-nav">
          ${editNote
            ? `<button class="ghost" id="hl-note-cancel">取消</button><button class="primary" id="hl-note-save">保存感想</button>`
            : `<button class="ghost" id="hl-note-edit">${h.note ? '编辑感想' : '补写感想'}</button><button class="ghost" id="hl-del">删除</button>`}
        </div>
      </div>`;
    $('#hl-src').onclick = toggleHlSource;
    $('#hl-note-edit')?.addEventListener('click', () => paintDetail(true));
    $('#hl-note-cancel')?.addEventListener('click', () => paintDetail(false));
    $('#hl-note-save')?.addEventListener('click', async () => {
      const note = $('#hl-note-ta').value.trim();
      await api(`/api/highlights/${h.id}`, { method: 'PUT', body: { note } });
      h.note = note || null;
      paintDetail(false);
      toast('感想已保存');
    });
    $('#hl-del')?.addEventListener('click', async () => {
      await api(`/api/highlights/${h.id}`, { method: 'DELETE' });
      items.splice(cur, 1);
      if (!items.length) return renderHighlights();
      cur = Math.min(cur, items.length - 1);
      paint();
      toast('已删除');
    });
  }
  paint();
}

// ---------- 错题本 ----------

// ---------- 错题本 ----------
async function renderWrong() {
  const books = await api('/api/books');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const bookId = Number(params.get('book')) || null;
  const wrongs = await api('/api/wrong' + (bookId ? `?book_id=${bookId}` : ''));
  const unmastered = wrongs.filter(w => !w.mastered).length;
  app.innerHTML = `
    <h1 class="page-title">错题本</h1>
    <p class="page-sub">左边挑一道，右边细看。掌握了就标记掉；也可以直接开考，连对两次自动掌握。</p>
    <div class="filter-row">
      <label>教材</label>
      <select id="wrong-book">
        <option value="">全部</option>
        ${books.map(b => `<option value="${b.id}" ${b.id === bookId ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}
      </select>
      <span style="color:var(--ink-soft);font-size:.88rem">${wrongs.length} 道 · ${unmastered} 道待掌握</span>
      <span style="flex:1"></span>
      ${unmastered ? `<button class="primary small" id="retake-start">开始重考（${Math.min(unmastered, 10)} 道）</button>` : ''}
    </div>
    <div id="wrong-stage"></div>`;
  $('#wrong-book').onchange = e => { location.hash = e.target.value ? `#/wrong?book=${e.target.value}` : '#/wrong'; renderWrong(); };
  $('#retake-start')?.addEventListener('click', () => startRetake(bookId));

  const stage = $('#wrong-stage');
  if (!wrongs.length) {
    stage.innerHTML = `<div class="empty"><span class="emoji">${glyph('ok')}</span>没有错题。要么全对，要么还没开始做题。</div>`;
    return;
  }
  let cur = 0;

  function paint() {
    stage.innerHTML = `
      <div class="terms-layout no-dividers">
        <div class="terms-list" id="wrong-list">
          ${wrongs.map((w, i) => `
            <div class="term-row ${i === cur ? 'active' : ''}" data-i="${i}">
              <div class="t-name">${esc(w.question.length > 42 ? w.question.slice(0, 42) + '…' : w.question)}</div>
              <div class="t-src">${esc(w.book_title || '')} · ${esc(w.lesson_title || '综合')}${w.mastered ? ' · 已掌握' : ''}</div>
            </div>`).join('')}
        </div>
        <div class="terms-detail" id="wrong-detail"></div>
      </div>`;
    paintDetail();
    $('#wrong-list').onclick = e => {
      const row = e.target.closest('.term-row');
      if (!row) return;
      cur = Number(row.dataset.i);
      $$('.term-row', stage).forEach(r => r.classList.toggle('active', r === row));
      paintDetail();
    };
    $('.term-row.active', stage)?.scrollIntoView({ block: 'nearest' });
  }

  function paintDetail() {
    const w = wrongs[cur];
    $('#wrong-detail').innerHTML = `
      <div class="card wrong-detail-card">
        <div class="wd-head">
          <span class="tag">${w.qtype === 'choice' ? '选择题' : '简答题'}</span>
          ${w.mastered ? '<span class="tag green">已掌握</span>' : ''}
          ${w.retake_count ? `<span class="tag">重考 ${w.retake_count} 次 · 连对 ${w.streak || 0}</span>` : ''}
          <span class="wd-src">${esc(w.book_title || '')} · ${esc(w.lesson_title || '')} · ${cur + 1} / ${wrongs.length}</span>
        </div>
        <div class="wd-q">${esc(w.question)}</div>
        ${w.options ? `<div class="wd-opts">${JSON.parse(w.options).map(o => `<div>${esc(o)}</div>`).join('')}</div>` : ''}
        <div class="wd-row"><b>正确答案</b><span class="ans-r">${esc(w.correct_answer)}</span></div>
        <div class="wd-row"><b>你的回答</b><span class="ans-w">${esc(w.user_answer || '（空）')}</span></div>
        ${w.explanation ? `<div class="wd-row"><b>解析</b><span>${esc(w.explanation)}</span></div>` : ''}
        <div class="wd-actions">
          <button class="ghost" id="wd-prev">← 上一道</button>
          <button class="${w.mastered ? 'ghost' : 'primary'}" id="wd-master">${w.mastered ? '取消掌握' : '标记掌握'}</button>
          <button class="ghost" id="wd-next">下一道 →</button>
        </div>
      </div>`;
    $('#wd-prev').onclick = () => { cur = (cur - 1 + wrongs.length) % wrongs.length; paint(); };
    $('#wd-next').onclick = () => { cur = (cur + 1) % wrongs.length; paint(); };
    $('#wd-master').onclick = async () => {
      await api(`/api/wrong/${w.id}/mastered`, { method: 'POST', body: { mastered: !w.mastered } });
      wrongs[cur].mastered = w.mastered ? 0 : 1;
      paint();
    };
  }
  paint();
}

// ---------- 错题重考 ----------
async function startRetake(bookId) {
  let pool;
  try {
    pool = await api('/api/wrong/retake' + (bookId ? `?book_id=${bookId}` : ''));
  } catch (e) { return toast(e.message, true); }
  if (!pool.length) return toast('没有待重考的错题，全都掌握了');
  const items = pool;

  app.innerHTML = `
    <h1 class="page-title">错题重考</h1>
    <p class="page-sub">从错题本里挑了 ${items.length} 道还没掌握的题（薄弱优先）。连对两次的题会自动标记掌握。</p>
    <div id="retake-form">
      ${items.map((w, i) => `
        <div class="card quiz-q" data-i="${i}">
          <div class="q-title">${i + 1}. ${esc(w.question)}<span class="q-type">${w.qtype === 'choice' ? '选择' : '简答'}</span></div>
          <div class="rt-src">${esc(w.book_title || '')} · ${esc(w.lesson_title || '')}${w.retake_count ? ` · 第 ${w.retake_count + 1} 次重考` : ''}${w.streak ? ` · 已连对 ${w.streak} 次` : ''}</div>
          ${w.qtype === 'choice'
            ? (w.options || []).map((op, oi) => `<label class="quiz-opt"><input type="radio" name="rq${i}" value="${'ABCD'[oi]}"> ${esc(op)}</label>`).join('')
            : `<textarea name="rq${i}" rows="3" placeholder="写下你的回答…"></textarea>`}
        </div>`).join('')}
      <div class="rt-actions">
        <button class="ghost" id="retake-quit">返回错题本</button>
        <button class="primary" id="retake-submit">交卷</button>
      </div>
    </div>
    <div id="retake-result" class="hidden"></div>`;

  $$('.quiz-opt', app).forEach(lab => lab.addEventListener('click', () => {
    const r = lab.querySelector('input[type=radio]');
    if (r) r.checked = true;
  }));
  $('#retake-quit').onclick = () => renderWrong();
  $('#retake-submit').onclick = async () => {
    const btn = $('#retake-submit');
    const answers = items.map((w, i) => ({
      id: w.id,
      answer: w.qtype === 'choice'
        ? ($$(`input[name="rq${i}"]`, app).find(r => r.checked)?.value || '')
        : ($(`textarea[name="rq${i}"]`, app)?.value || ''),
    }));
    const emptyIdx = answers.map((a, i) => (a.answer || '').trim() ? -1 : i).filter(i => i >= 0);
    if (emptyIdx.length && !btn.dataset.armed) {
      btn.dataset.armed = '1';
      $$('.quiz-q', app).forEach((el, i) => el.classList.toggle('quiz-empty', emptyIdx.includes(i)));
      toast(`第 ${emptyIdx.map(i => i + 1).join('、')} 题还没作答（已标红），再点一次交卷确认提交`);
      setTimeout(() => { btn.dataset.armed = ''; }, 8000);
      return;
    }
    $$('.quiz-q', app).forEach(el => el.classList.remove('quiz-empty'));
    btn.disabled = true;
    btn.textContent = '批改中…';
    try {
      const { total, count, results } = await api('/api/wrong/retake/grade', { method: 'POST', body: { answers } });
      const mastered = results.filter(r => r.mastered).length;
      const ungraded = results.filter(r => r.ungraded).length;
      const banner = $('#retake-result');
      banner.classList.remove('hidden');
      banner.innerHTML = `<div class="card quiz-result-banner" style="border-color:${count > 0 && total === count ? 'var(--sage)' : 'var(--rose)'}">
        答对 <b style="font-size:1.5em">${total}</b> / ${count} 道${ungraded ? ` · ${ungraded} 题未批改（进度保持不变）` : ''}${mastered ? ` · ${mastered} 道连对两次，已自动掌握` : ''}${count > 0 && total === count && !mastered ? ' · 全对，漂亮！' : ''}</div>
        <div class="rt-actions" style="margin-top:14px"><button class="primary" id="retake-back">返回错题本</button></div>`;
      for (const r of results) {
        const i = items.findIndex(w => w.id === r.id);
        const qEl = $(`.quiz-q[data-i="${i}"]`);
        if (!qEl) continue;
        if (r.qtype === 'choice') {
          $$('.quiz-opt', qEl).forEach((lab, oi) => {
            const letter = 'ABCD'[oi];
            if (letter === String(r.correct_answer).trim().toUpperCase()) lab.classList.add('right');
            else if (letter === (r.user_answer || '').toUpperCase()) lab.classList.add('wrong');
          });
        }
        qEl.insertAdjacentHTML('beforeend', `<div class="quiz-feedback">
          ${r.ungraded ? '○ 未批改（连对进度保持不变，可以再试一次）' : r.correct ? '✓ 回答正确' : '✗ 正确答案：' + esc(r.correct_answer)}
          ${r.mastered ? ' · 连对两次，已标记掌握' : !r.ungraded && r.correct ? ` · 连对 ${r.streak} 次，再对一次即掌握` : ''}
          <br>${esc(r.feedback || '').replace(/\n/g, '<br>')}</div>`);
      }
      $('#retake-submit')?.remove();
      $('#retake-quit')?.remove();
      $('#retake-back').onclick = () => renderWrong();
      banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '交卷';
    }
  };
}
// ---------- 设置 ----------
const oauthPolls = new Map();
async function watchOAuthLogin(platformId) {
  if (oauthPolls.has(platformId)) return;
  const task = (async () => {
    for (let i = 0; i < 400; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const status = await api('/api/oauth/status').catch(() => null);
      const platform = status?.platforms?.find(item => item.id === platformId);
      if (!platform) continue;
      if (platform.signed_in) {
        toast(`${platform.name} 已连接`);
        refreshBadge();
        if (location.hash.includes('/settings')) renderSettings();
        return;
      }
      if (!platform.login?.running && platform.login?.error) {
        toast(platform.login.error, true);
        if (location.hash.includes('/settings')) renderSettings();
        return;
      }
      if (!platform.login?.running && !platform.signed_in) return;
    }
    toast('授权等待超时，请重新连接', true);
  })().finally(() => oauthPolls.delete(platformId));
  oauthPolls.set(platformId, task);
}

async function renderSettings() {
  const [st, oauth] = await Promise.all([api('/api/settings'), api('/api/oauth/status')]);
  const providers = await api('/api/providers');
  const oauthCards = oauth.platforms.map(platform => {
    const login = platform.login || {};
    const state = platform.signed_in ? '已连接' : login.running ? '等待授权' : login.error ? '连接失败' : '未连接';
    const stateClass = platform.signed_in ? 'connected' : login.error ? 'failed' : login.running ? 'waiting' : '';
    const challenge = login.challenge;
    return `<article class="oauth-card ${stateClass}" data-platform="${esc(platform.id)}">
      <div class="oauth-card-head">
        <div><b>${esc(platform.name)}</b><span>${esc(platform.description)}</span></div>
        <div class="oauth-card-status">
          ${platform.signed_in ? '<button class="small ghost" data-oauth-act="logout">断开连接</button>' : ''}
          <span class="oauth-state">${esc(state)}</span>
        </div>
      </div>
      <div class="oauth-models">${platform.models.slice(0, 5).map(model => `<span>${esc(model.name || model.id)}</span>`).join('')}${platform.models.length > 5 ? `<span>另有 ${platform.models.length - 5} 个</span>` : ''}</div>
      ${challenge ? `<div class="oauth-challenge">
        <a href="${esc(challenge.url)}" target="_blank" rel="noopener">打开授权页面 ↗</a>
        ${challenge.user_code ? `<span>授权码 <strong>${esc(challenge.user_code)}</strong></span>` : '<span>在浏览器完成登录后会自动返回</span>'}
      </div>` : ''}
      ${login.error ? `<div class="oauth-error">${esc(login.error)}</div>` : ''}
      ${!platform.signed_in ? `<div class="oauth-actions">
        ${login.running
          ? `<button class="small ghost" data-oauth-act="open">重新打开授权页</button><button class="small ghost" data-oauth-act="cancel">取消</button>`
          : `<button class="small primary" data-oauth-act="login">连接 ${esc(platform.name)}</button>${oauth.dsh_available ? '<button class="small ghost" data-oauth-act="import">同步 DSH 登录</button>' : ''}`}
      </div>` : ''}
    </article>`;
  }).join('');
  app.innerHTML = `
    <h1 class="page-title">设置</h1>
    <p class="page-sub">模型来源决定课程质量。可以连接订阅账户，也可以导入 DSH 或手动添加 provider。</p>
    <div class="settings-duo">
      <div class="card settings-panel">
        <div class="settings-title-row">
          <b>外观</b>
          <select id="theme-select" class="settings-select-compact">
            <option value="egypt">古埃及 · 纸莎草</option>
            <option value="morandi">莫兰迪书房</option>
          </select>
        </div>
        <div class="settings-help">古埃及纸莎草（有猫猫和圣甲虫）或莫兰迪书房。</div>
      </div>
      <details class="card settings-fold" id="typography-card">
        <summary>
          <span class="fold-head">
            <b>阅读排版</b>
            <span class="fold-desc">正文字号与字间距，拖动即时生效，自动记住。</span>
          </span>
          <span class="fold-badge" id="tp-badge"></span>
          <span class="fold-hint">▾</span>
        </summary>
        <div class="fold-body">
          <div class="form-grid" style="padding:0">
            <div><label>字号 <span id="tp-size-val" class="mono" style="color:var(--ink-faint)"></span></label>
              <input type="range" id="tp-size" min="85" max="120" step="5"></div>
            <div><label>字间距 <span id="tp-ls-val" class="mono" style="color:var(--ink-faint)"></span></label>
              <input type="range" id="tp-ls" min="0" max="2.5" step="0.5"></div>
          </div>
        </div>
      </details>
    </div>
    <div class="settings-duo">
      <details class="card settings-fold" id="tts-card">
        <summary>
          <span class="fold-head">
            <b>朗读 · 把课件读给你听</b>
            <span class="fold-desc">课节页「▸ 朗读」把当前页签像讲课一样读出来，免费、无需 key，需联网。</span>
          </span>
          <span class="fold-badge" id="tts-voice-badge"></span>
          <span class="fold-hint">▾</span>
        </summary>
        <div class="fold-body">
          <div class="fold-note">Edge TTS 神经音色；合成在微软服务器完成。音色与语速改动即时生效，自动记住。</div>
          <div class="form-grid" style="padding:0">
            <div><label>讲课音色</label><select id="tts-voice">${TTS.VOICES.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
            <div><label>语速</label><select id="tts-rate">${TTS.RATES.map(r => `<option value="${r.v}">${esc(r.l)}</option>`).join('')}</select></div>
          </div>
          <div class="fold-actions">
            <button class="small ghost" id="tts-preview">▸ 试听</button>
            <span id="tts-saved" style="font-size:.82rem;color:var(--sage-deep)"></span>
          </div>
        </div>
      </details>
      <div class="card settings-panel">
        <b>学习提醒</b>
        <div class="settings-help" style="margin-bottom:14px">到点后如果还有到期复习，弹一条系统通知（每天最多一条）。</div>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <label style="display:flex;gap:8px;align-items:center;cursor:pointer">
            <input type="checkbox" id="reminder-enabled" style="width:auto" ${st.reminder_enabled ? 'checked' : ''}> 启用每日提醒
          </label>
          <label style="display:flex;gap:8px;align-items:center">时间
            <input type="time" id="reminder-time" style="width:auto;padding:4px 10px;font-size:.86rem;border-radius:8px" value="${esc(st.reminder_time)}">
          </label>
          <button class="small ghost" id="reminder-test">测试通知</button>
          <span id="reminder-saved" style="font-size:.82rem;color:var(--sage-deep)"></span>
        </div>
      </div>
    </div>
    <div class="settings-duo">
      <div class="card settings-panel">
        <div class="settings-title-row">
          <b>翰林院 · Obsidian 沉淀</b>
          <button class="small primary settings-inline-action" id="hanlin-export">立即沉淀</button>
        </div>
        <div class="settings-help">把已备好的讲义、术语、划线和错题写成 Markdown——用 Obsidian 打开沉淀目录，就是你的知识库。</div>
        <div class="settings-field-row">
          <input id="hanlin-dir" class="mono" style="font-size:.78rem;flex:1" placeholder="留空 = 默认 ~/Downloads/翰林院/LearnOrNot">
          <button class="small ghost" id="hanlin-dir-save">保存目录</button>
        </div>
        <div id="hanlin-status" style="font-size:.82rem;color:var(--sage-deep);margin-top:6px"></div>
      </div>
      <div class="card settings-panel">
        <div class="settings-title-row">
          <b>数据备份</b>
          <span class="settings-inline-actions">
            <button class="small ghost" id="backup-export">导出备份</button>
            <button class="small ghost" id="backup-restore">恢复…</button>
          </span>
        </div>
        <div class="settings-help">全部学习数据（课程、进度、错题、划线、会话、番茄）打包成一个 JSON。换机器或重装后从这里恢复。</div>
        <input type="file" id="backup-file" accept=".json,application/json" class="hidden">
      </div>
    </div>
    <div class="settings-duo">
      <div class="card" style="padding:22px 26px">
        <b>自定义 CSS</b>
        <div style="font-size:.85rem;color:var(--ink-soft);margin:4px 0 12px">写在这里的样式会全站生效（重启也在）。换字体、调间距、藏元素……DIY 玩家的后门，升级不会被冲掉。</div>
        <textarea id="custom-css" rows="5" class="mono" style="width:100%;font-size:.78rem;resize:vertical" placeholder="/* 例：把讲义字号再调大一点 */&#10;.markdown { line-height: 2; }"></textarea>
        <div style="display:flex;gap:10px;margin-top:10px;align-items:center;justify-content:flex-end">
          <span id="custom-css-saved" style="font-size:.82rem;color:var(--sage-deep)"></span>
          <button class="primary small" id="custom-css-save">保存并生效</button>
        </div>
      </div>
      <details class="card settings-fold" id="companion-card">
        <summary>
          <span class="fold-head">
            <b>陪伴 agent</b>
            <span class="fold-desc">接入你本地的陪伴 agent，它会以本色出现在「老师来了」的模型菜单里。</span>
          </span>
          <span class="fold-badge" id="companion-status"></span>
          <span class="fold-hint">▾</span>
        </summary>
        <div class="fold-body">
          <div class="fold-note">对方只需满足 Companion Contract：一个状态端点 + 一个 SSE 流式聊天端点。</div>
          <div class="form-grid" style="padding:0">
            <div><label>名字（显示在模型菜单里）</label><input id="cp-name" placeholder="给你的伙伴起个名字"></div>
            <div><label>地址</label><input id="cp-url" placeholder="http://127.0.0.1:8081"></div>
            <div><label>状态路径</label><input id="cp-status" placeholder="/status"></div>
            <div><label>聊天路径（支持 {conv} 占位）</label><input id="cp-send" placeholder="/chat"></div>
            <div><label>会话 id（多会话型 agent 用，可留空后点「发现」）</label><input id="cp-conv" placeholder="单会话 agent 留空即可"></div>
          </div>
          <div class="fold-actions">
            <button class="primary" id="cp-save">保存</button>
            <button class="ghost" id="cp-preset-local">填入本地实例默认参数</button>
            <button class="ghost" id="cp-discover">发现会话</button>
            <button class="ghost" id="cp-test">测试连接</button>
          </div>
        </div>
      </details>
    </div>
    ${st.dsh_available ? `<div class="settings-duo">
      <div class="card" style="padding:22px 26px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <b>从 DSH 导入</b>
          <div style="font-size:.85rem;color:var(--ink-soft)">检测到本机的 DSH 配置，可以把里面已配好的 provider 一键搬过来。</div>
        </div>
        <button class="primary small" id="import-dsh">一键导入</button>
      </div>` : ''}
      <details class="card"${st.dsh_available ? '' : ' style="margin-top:20px"'}>
        <summary style="padding:16px 22px;cursor:pointer;font-weight:600">手动添加 provider</summary>
        <div class="form-grid">
          <div><label>名称</label><input id="np-name" placeholder="例如 My OpenAI"></div>
          <div><label>协议</label><select id="np-protocol">
            <option value="openai-completions">openai-completions（/chat/completions）</option>
            <option value="openai-responses">openai-responses（/responses）</option>
            <option value="anthropic-messages">anthropic-messages（/v1/messages）</option>
          </select></div>
          <div><label>Base URL（OpenAI 系必须自带 /v1）</label><input id="np-url" placeholder="https://api.example.com/v1"></div>
          <div><label>API Key</label><input id="np-key" type="password" placeholder="sk-..."></div>
          <div><label>模型（逗号分隔）</label><input id="np-models" placeholder="gpt-5.5, gpt-5.4-mini"></div>
          <div><button class="primary" id="np-add">添加</button></div>
        </div>
      </details>
    ${st.dsh_available ? '</div>' : ''}
    <section class="oauth-suite">
      <div class="oauth-suite-head">
        <div>
          <h2>订阅账户</h2>
          <p>用官方 OAuth 连接现有订阅。令牌存进仅当前用户可读的独立文件，不进入学习备份，也不会显示在页面里。</p>
        </div>
        <span class="tag green">OAuth</span>
      </div>
      <div class="oauth-grid">${oauthCards}</div>
      <div class="oauth-footnote">Codex 使用 ChatGPT Plus / Pro；Grok 使用 SuperGrok / X Premium。授权与模型请求由官方登录端点完成。</div>
    </section>

    <div id="provider-list" style="margin-bottom:22px"></div>`;

  $('.oauth-suite').onclick = async event => {
    const button = event.target.closest('[data-oauth-act]');
    const card = event.target.closest('.oauth-card');
    if (!button || !card) return;
    const platformId = card.dataset.platform;
    const platform = oauth.platforms.find(item => item.id === platformId);
    const action = button.dataset.oauthAct;
    button.disabled = true;
    try {
      if (action === 'login') {
        button.textContent = '准备授权…';
        const challenge = await api(`/api/oauth/${platformId}/login`, {
          method: 'POST', body: { mode: 'device_code' },
        });
        window.open(challenge.url, '_blank', 'noopener');
        toast(challenge.user_code ? `授权码：${challenge.user_code}` : '已打开授权页面');
        watchOAuthLogin(platformId);
        await renderSettings();
      } else if (action === 'open') {
        if (platform?.login?.challenge?.url) window.open(platform.login.challenge.url, '_blank', 'noopener');
        button.disabled = false;
      } else if (action === 'cancel') {
        await api(`/api/oauth/${platformId}/cancel`, { method: 'POST', body: {} });
        toast('已取消登录');
        await renderSettings();
      } else if (action === 'import') {
        button.textContent = '同步中…';
        await api(`/api/oauth/${platformId}/import-dsh`, { method: 'POST', body: {} });
        toast(`${platform.name} 已从 DSH 同步`);
        await renderSettings();
        refreshBadge();
      } else if (action === 'logout') {
        if (!confirm(`断开 ${platform.name} 的 OAuth 连接？`)) { button.disabled = false; return; }
        await api(`/api/oauth/${platformId}/logout`, { method: 'POST', body: {} });
        toast(`${platform.name} 已断开`);
        await renderSettings();
        refreshBadge();
      }
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  };

  const ts = $('#theme-select');
  ts.value = document.documentElement.dataset.theme || 'egypt';
  ts.onchange = () => {
    document.documentElement.dataset.theme = ts.value;
    localStorage.setItem('learnloop.theme', ts.value);
    toast(ts.value === 'egypt' ? '𓃠 已切换到古埃及主题' : '已切换到莫兰迪主题');
    renderSettings();
  };

  // 阅读排版
  const tpSize = $('#tp-size'), tpLs = $('#tp-ls');
  tpSize.value = localStorage.getItem('learnloop.fontScale') || 100;
  tpLs.value = localStorage.getItem('learnloop.letterSpacing') || 0;
  const paintTp = () => {
    const size = tpSize.value + '%';
    const spacing = Number(tpLs.value).toFixed(1) + 'px';
    $('#tp-size-val').textContent = size;
    $('#tp-ls-val').textContent = spacing;
    $('#tp-badge').textContent = `${size} · ${spacing}`;
  };
  paintTp();
  tpSize.oninput = () => { localStorage.setItem('learnloop.fontScale', tpSize.value); applyTypography(); paintTp(); };
  tpLs.oninput = () => { localStorage.setItem('learnloop.letterSpacing', tpLs.value); applyTypography(); paintTp(); };

  const saveReminder = async () => {
    await api('/api/settings', { method: 'POST', body: {
      reminder_enabled: $('#reminder-enabled').checked,
      reminder_time: $('#reminder-time').value || '20:00',
    } });
    const tag = $('#reminder-saved');
    tag.textContent = '已保存';
    setTimeout(() => tag.textContent = '', 2000);
    initReminders();
  };
  $('#reminder-enabled').onchange = saveReminder;
  $('#reminder-time').onchange = saveReminder;

  // 朗读设置（localStorage 持久化，改动即时生效）
  const ttsSt = TTS.getSettings();
  $('#tts-voice').value = ttsSt.voice;
  $('#tts-rate').value = ttsSt.rate;
  const paintTtsBadge = () => {
    const voice = TTS.VOICES.find(v => v.id === $('#tts-voice').value);
    const rate = TTS.RATES.find(r => r.v === $('#tts-rate').value);
    const voiceName = voice?.name.replace(/（.*）/, '').trim() || '讲课音色';
    $('#tts-voice-badge').textContent = `${voiceName} · ${rate?.l || '原速'}`;
  };
  paintTtsBadge();
  const saveTts = () => {
    TTS.saveSettings({ voice: $('#tts-voice').value, rate: $('#tts-rate').value });
    paintTtsBadge();
    const tag = $('#tts-saved');
    tag.textContent = '已保存';
    setTimeout(() => tag.textContent = '', 2000);
  };
  $('#tts-voice').onchange = saveTts;
  $('#tts-rate').onchange = saveTts;
  $('#tts-preview').onclick = () => TTS.preview();
  $('#reminder-test').onclick = async () => {
    if (!('Notification' in window)) return toast('当前环境不支持通知', true);
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return toast('通知权限未开启', true);
    new Notification('LearnOrNot · 复习提醒', { body: '这是一条测试通知。到点我会这样提醒你复习。' });
  };

  // 陪伴 agent 设置
  const cp = st.companion || {};
  $('#cp-name').value = cp.name || '';
  $('#cp-url').value = cp.url || '';
  $('#cp-status').value = cp.statusPath || '';
  $('#cp-send').value = cp.sendPath || '';
  $('#cp-conv').value = cp.conv || '';
  const paintCompanion = async () => {
    const cs = await api('/api/companion/status').catch(() => ({ configured: false }));
    const el = $('#companion-status');
    if (!el) return;
    el.textContent = !cs.configured ? '未配置' : cs.home ? `✓ ${cs.name} 在家` : `✕ ${cs.name} 不在家`;
    el.style.color = cs.configured && cs.home ? 'var(--sage-deep)' : 'var(--ink-faint)';
  };
  paintCompanion();
  const saveCompanion = async () => {
    await api('/api/settings', { method: 'POST', body: { companion: {
      name: $('#cp-name').value.trim(), url: $('#cp-url').value.trim(),
      status_path: $('#cp-status').value.trim(), send_path: $('#cp-send').value.trim(),
      conv: $('#cp-conv').value.trim(),
    } } });
  };
  $('#cp-save').onclick = async () => { await saveCompanion(); toast('已保存'); paintCompanion(); };
  $('#cp-preset-local').onclick = async () => {
    const p = await api('/api/companion/preset/local');
    $('#cp-url').value = p.url; $('#cp-status').value = p.status_path;
    $('#cp-send').value = p.send_path; $('#cp-conv').value = p.conv || '';
    toast('已填入本地实例默认参数，记得起名字 + 发现会话');
  };
  $('#cp-discover').onclick = async () => {
    try {
      const r = await api('/api/companion/discover', { method: 'POST', body: {
        url: $('#cp-url').value.trim(), status_path: $('#cp-status').value.trim() || '/status',
      } });
      $('#cp-conv').value = r.conv;
      toast(`发现会话：${r.title || r.conv}`);
    } catch (e) { toast(e.message, true); }
  };
  $('#cp-test').onclick = async () => {
    await saveCompanion();
    const cs = await api('/api/companion/status').catch(() => ({ configured: false }));
    paintCompanion();
    if (!cs.configured) toast('先填名字和地址', true);
    else toast(cs.home ? `${cs.name} 在家，连上了` : `${cs.name} 不在家`, !cs.home);
  };

  // 翰林院沉淀
  const paintHanlin = async () => {
    try {
      const s = await api('/api/export/obsidian/status');
      $('#hanlin-status').textContent = s.last_export
        ? `上次沉淀：${s.last_export} · 目录：${s.dir}`
        : `还没有沉淀过 · 目录：${s.dir}`;
    } catch { /* ignore */ }
  };
  paintHanlin();
  $('#hanlin-dir').value = st.hanlin_dir || '';
  $('#hanlin-dir-save').onclick = async () => {
    await api('/api/settings', { method: 'POST', body: { hanlin_dir: $('#hanlin-dir').value.trim() } });
    toast('沉淀目录已保存');
    paintHanlin();
  };
  fetch('/api/custom.css').then(r => r.text()).then(t => { $('#custom-css').value = t; });
  $('#custom-css-save').onclick = async () => {
    await api('/api/settings', { method: 'POST', body: { custom_css: $('#custom-css').value } });
    const tag = $('#custom-css-saved');
    tag.textContent = '已生效';
    setTimeout(() => tag.textContent = '', 2000);
    document.querySelector('link[href="/api/custom.css"]')?.setAttribute('href', '/api/custom.css?t=' + Date.now());
  };
  $('#hanlin-export').onclick = async () => {
    const btn = $('#hanlin-export');
    btn.disabled = true;
    btn.textContent = '沉淀中…';
    try {
      const r = await api('/api/export/obsidian', { method: 'POST', body: {} });
      toast(`已沉淀 ${r.lessons} 节课 · ${r.terms} 条术语 · ${r.highlights} 条划线`);
      paintHanlin();
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
    btn.textContent = '立即沉淀';
  };

  // 备份 / 恢复
  $('#backup-export').onclick = async () => {
    try {
      const res = await fetch('/api/backup');
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const a = document.createElement('a');
      const d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = `learnloop-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('备份已下载');
    } catch (e) { toast(e.message, true); }
  };
  $('#backup-restore').onclick = () => $('#backup-file').click();
  $('#backup-file').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch { return toast('这不是一个有效的备份文件', true); }
    if (payload?.app !== 'learnloop' || !payload.tables) return toast('这不是 LearnOrNot 的备份文件', true);
    if (!confirm('恢复会覆盖当前全部学习数据，确定继续吗？')) return;
    try {
      const r = await api('/api/backup/restore', { method: 'POST', body: payload });
      toast(`已恢复 ${r.restored} 张表的数据`);
      renderSettings();
      refreshBadge();
    } catch (err) { toast(err.message, true); }
  };

  if ($('#import-dsh')) $('#import-dsh').onclick = async () => {
    const btn = $('#import-dsh');
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const imported = await api('/api/providers/import-dsh', { method: 'POST', body: {} });
      toast(`导入 ${imported.length} 个 provider`);
      renderSettings();
      refreshBadge();
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '一键导入'; }
  };

  $('#np-add').onclick = async () => {
    try {
      await api('/api/providers', {
        method: 'POST',
        body: {
          name: $('#np-name').value.trim(), protocol: $('#np-protocol').value,
          base_url: $('#np-url').value.trim(), api_key: $('#np-key').value.trim(),
          models: $('#np-models').value,
        },
      });
      toast('已添加');
      renderSettings();
      refreshBadge();
    } catch (e) { toast(e.message, true); }
  };

  const list = $('#provider-list');
  if (!providers.length) {
    list.innerHTML = `<div class="empty"><span class="emoji">${glyph('plug')}</span>还没有 provider。点下面「手动添加 provider」接入任意模型服务${st.dsh_available ? '，或点上面「一键导入」搬 DSH 配置' : ''}。</div>`;
    return;
  }
  list.innerHTML = providers.map(p => {
    const models = JSON.parse(p.models || '[]');
    return `<div class="card provider-card" data-id="${p.id}" data-source="${esc(p.source || 'manual')}">
      <div class="p-head">
        <span class="p-name">${esc(p.name)}</span>
        <span class="tag">${esc(p.source === 'oauth' ? '订阅 OAuth' : p.protocol)}</span>
        ${p.source === 'dsh' ? '<span class="tag green">DSH</span>' : ''}
        ${p.source === 'oauth' ? '<span class="tag green">已授权</span>' : ''}
        ${p.is_default ? '<span class="tag" style="background:var(--rose-soft);color:var(--rose-deep)">默认</span>' : ''}
        <span style="margin-left:auto;display:flex;gap:8px">
          <button class="small ghost" data-act="test">测一下</button>
          <button class="small ghost" data-act="del">删除</button>
        </span>
      </div>
      <div class="p-url">${esc(p.base_url)} · ${p.source === 'oauth' ? 'OAuth 令牌由学不学安全管理' : 'key ' + esc(p.api_key)}</div>
      <div class="p-models">${models.map(m => `<span class="model-chip ${m.id === p.default_model ? 'current' : ''}" data-model="${esc(m.id)}" title="点击设为默认模型">${esc(m.name || m.id)}</span>`).join('')}</div>
      <div class="test-result" style="font-size:.83rem;color:var(--ink-soft)"></div>
    </div>`;
  }).join('');

  list.onclick = async e => {
    const card = e.target.closest('.provider-card');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (e.target.classList.contains('model-chip')) {
      await api(`/api/providers/${id}/default`, { method: 'POST', body: { model: e.target.dataset.model } });
      toast('已设为默认模型');
      renderSettings();
      refreshBadge();
    } else if (e.target.dataset.act === 'del') {
      const oauthProvider = card.dataset.source === 'oauth';
      if (!confirm(oauthProvider ? '断开这个 OAuth 订阅？' : '删除这个 provider？')) return;
      await api(`/api/providers/${id}`, { method: 'DELETE' });
      renderSettings();
      refreshBadge();
    } else if (e.target.dataset.act === 'test') {
      const box = $('.test-result', card);
      box.textContent = '测试中…';
      try {
        const r = await api(`/api/providers/${id}/test`, { method: 'POST', body: {} });
        box.textContent = `✓ ${r.ms}ms：${r.reply}`;
      } catch (err) { box.textContent = `✗ ${err.message}`; }
    }
  };
}

// ---------- 复习（艾宾浩斯） ----------
const STAGE_NAMES = ['', '第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮', '第 5 轮', '第 6 轮'];

async function renderReviews() {
  const tab = state.reviewsTab || 'plan';
  app.innerHTML = `
    <h1 class="page-title">复习</h1>
    <p class="page-sub">按艾宾浩斯曲线排的复习计划：学完当天起 +1 / 2 / 4 / 7 / 15 / 30 天，共六轮。</p>
    <div class="tabs rv-tabs">
      <button class="${tab === 'plan' ? 'active' : ''}" data-tab="plan">复习排期</button>
      <button class="${tab === 'sessions' ? 'active' : ''}" data-tab="sessions">会话记录</button>
    </div>
    <div id="rv-body"></div>`;
  $$('.rv-tabs button').forEach(b => b.onclick = () => { state.reviewsTab = b.dataset.tab; renderReviews(); });

  if (tab === 'sessions') return renderSessionCards($('#rv-body'));

  const { due, upcoming } = await api('/api/reviews');
  const today = new Date().toISOString().slice(0, 10);
  $('#rv-body').innerHTML = `
    <h2 class="section-title">待复习 <span class="tab-count">${due.length}</span></h2>
    <div id="due-list"></div>
    <h2 class="section-title" style="margin-top:36px">接下来的排期</h2>
    <div id="upcoming-list"></div>`;

  const dueEl = $('#due-list');
  if (!due.length) {
    dueEl.innerHTML = `<div class="empty"><span class="emoji">${glyph('ok')}</span>今天没有到期的复习。去学新内容，或者休息。</div>`;
  } else {
    dueEl.innerHTML = due.map(r => {
      const overdue = Math.max(0, Math.round((new Date(today) - new Date(r.due_date)) / 86400000));
      return `<div class="card review-item" data-id="${r.id}">
        <div class="r-main">
          <div class="r-title">${esc(r.lesson_title)}</div>
          <div class="r-meta">${esc(r.book_title)} · ${STAGE_NAMES[r.stage] || `第 ${r.stage} 轮`} · 应于 ${r.due_date}${overdue ? ` · <span class="overdue">已逾期 ${overdue} 天</span>` : ''}</div>
        </div>
        <button class="primary" data-act="go">开始复习</button>
      </div>`;
    }).join('');
    dueEl.onclick = e => {
      if (e.target.dataset.act !== 'go') return;
      location.hash = `#/review/${e.target.closest('.review-item').dataset.id}`;
    };
  }

  const upEl = $('#upcoming-list');
  if (!upcoming.length) {
    upEl.innerHTML = `<div class="empty" style="padding:30px"><span class="emoji">${glyph('dot')}</span>暂无后续排期</div>`;
  } else {
    const byDate = {};
    for (const r of upcoming) (byDate[r.due_date] = byDate[r.due_date] || []).push(r);
    upEl.innerHTML = Object.entries(byDate).map(([date, items]) => `
      <div class="upcoming-row">
        <span class="upcoming-date">${date}</span>
        <span class="upcoming-items">${items.map(r => `<span class="tag">${esc(r.lesson_title)}<i class="stage-no">${STAGE_NAMES[r.stage] || r.stage}</i></span>`).join('')}</span>
      </div>`).join('');
  }
}

// 会话记录卡片列表（复习页子标签）
async function renderSessionCards(box) {
  const sessions = await api('/api/chat/sessions');
  if (!sessions.length) {
    box.innerHTML = `<div class="empty"><span class="emoji">${glyph('dot')}</span>还没有归档的会话。点圆圈「入」可以手动归档；开启新会话时也会先收好已有讨论。</div>`;
    return;
  }
  box.innerHTML = `<div class="session-grid">${sessions.map(s => `
    <div class="card session-card" data-id="${s.id}">
      <div class="sc-title">${esc(s.title || '未命名讨论')}</div>
      <div class="sc-meta">${s.lesson_title ? `《${esc(s.lesson_title)}》` : '自由漫谈'} · ${s.msg_count} 条 · ${(s.archived_at || s.created_at || '').slice(0, 10)}</div>
    </div>`).join('')}</div>`;
  box.onclick = e => {
    const card = e.target.closest('.session-card');
    if (card) location.hash = `#/session/${card.dataset.id}`;
  };
}

// 会话回看（只读）
async function renderChatSession(id) {
  const { session, messages } = await api(`/api/chat/sessions/${id}`);
  app.innerHTML = `
    <a class="back-link" href="#/reviews" id="session-back">会话记录</a>
    <h1 class="page-title">${esc(session.title || '未命名讨论')}</h1>
    <p class="page-sub">${session.lesson_title ? `《${esc(session.lesson_title)}》 · ` : ''}${(session.archived_at || session.created_at || '').slice(0, 16)} · ${messages.length} 条</p>
    <div class="card session-transcript">
      ${messages.length ? messages.map(chatBubble).join('') : '<div class="chat-empty">这个会话是空的。</div>'}
    </div>`;
  $('#session-back').onclick = () => { state.reviewsTab = 'sessions'; };
  renderMath($('.session-transcript'));
}
async function renderReviewSession(id) {
  const r = await api(`/api/reviews/${id}`);
  const lesson = r.lesson;
  if (!lesson || lesson.status !== 'ready') {
    app.innerHTML = `<div class="empty"><span class="emoji">${glyph('err')}</span>这节课的讲义不在了，无法复习。</div>`;
    return;
  }
  const terms = JSON.parse(lesson.terms || '[]');
  const quiz = JSON.parse(lesson.quiz || '[]');

  app.innerHTML = `
    <a class="back-link" href="#/reviews">复习列表</a>
    <h1 class="page-title">${esc(lesson.title)}</h1>
    <p class="page-sub">${esc(r.book_title)} · ${STAGE_NAMES[r.stage] || `第 ${r.stage} 轮复习`} · 应于 ${r.due_date}</p>
    <div class="card" style="padding:22px 28px;margin-bottom:18px">
      <details>
        <summary style="cursor:pointer;font-weight:600;letter-spacing:1px">先过一遍讲义与术语（点开展开）</summary>
        <div class="markdown" style="margin-top:14px">${md(lesson.content)}</div>
        ${terms.length ? `<div class="term-list" style="margin-top:14px">${terms.map(t => `
          <div class="term-item"><span class="term">${esc(t.term)}</span><span class="anno">${esc(t.annotation)}</span></div>`).join('')}</div>` : ''}
      </details>
    </div>
    <div id="review-quiz"></div>`;
  renderMath($('#review-quiz')?.previousElementSibling);

  const body = $('#review-quiz');
  body.innerHTML = `
    <h2 class="section-title">复习测验 <span class="tab-count">${quiz.length} 题，重做一遍</span></h2>
    <div id="quiz-form">
      ${quiz.map((q, i) => `
        <div class="card quiz-q" data-i="${i}">
          <div class="q-title">${i + 1}. ${esc(q.question)}<span class="q-type">${q.type === 'choice' ? '选择' : '简答'}</span></div>
          ${q.type === 'choice'
            ? (q.options || []).map((op, oi) => `<label class="quiz-opt"><input type="radio" name="q${i}" value="${'ABCD'[oi]}"> ${esc(op)}</label>`).join('')
            : `<textarea name="q${i}" rows="3" placeholder="写下你的回答…"></textarea>`}
        </div>`).join('')}
      <div style="display:flex;gap:12px;align-items:center;margin-top:6px">
        <button class="primary" id="submit-quiz">交卷并完成本轮复习</button>
        <button class="ghost" id="skip-quiz">不做题，直接标记完成</button>
      </div>
    </div>
    <div id="quiz-result" class="hidden"></div>`;

  $('#skip-quiz').onclick = async () => {
    await api(`/api/reviews/${id}/complete`, { method: 'POST', body: {} });
    toast('本轮复习已标记完成');
    location.hash = '#/reviews';
  };
  const collectReview = wireQuizForm(body, quiz, null);
  $('#submit-quiz').onclick = async () => {
    const btn = $('#submit-quiz');
    const { pass, answers } = quizGuardEmpty(collectReview, body, btn);
    if (!pass) return;
    btn.disabled = true;
    btn.textContent = '批改中…';
    try {
      const { total, results } = await api(`/api/lessons/${lesson.id}/grade`, { method: 'POST', body: { answers } });
      paintQuizResult(body, quiz, results, total);
      await api(`/api/reviews/${id}/complete`, { method: 'POST', body: { score: total } });
      $('#quiz-result').insertAdjacentHTML('beforeend',
        `<div style="text-align:center;color:var(--ink-soft);font-size:.9rem">本轮复习完成 · <a href="#/reviews" style="color:var(--rose-deep)">回到复习列表</a></div>`);
      refreshReviewBadge();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '交卷并完成本轮复习';
    }
  };
}

// ---------- 老师来了 · 全局聊天栏 ----------
const chatState = {
  open: localStorage.getItem('learnloop.chatOpen') === '1',
  model: JSON.parse(localStorage.getItem('learnloop.chatModel') || 'null'),
  sending: false,
  ctxKey: null,
  sessionId: null,
  built: false,
};

// 冷启动时回到最后一个仍可续聊的会话上下文。显式深链不覆盖，避免抢走用户指定的页面。
async function restoreLastChatSession() {
  const desktopStart = new URLSearchParams(location.search).get('desktop') === '1';
  if (location.hash && !desktopStart) return;
  try {
    const { session } = await api('/api/chat/session/last');
    if (!session?.id || !session.msg_count) return;
    chatState.open = true;
    localStorage.setItem('learnloop.chatOpen', '1');
    // 聊天会话只决定恢复哪本书；主页面以该书的学习进度为准。
    // 否则旧课的聊天会话会把已经推进的课程位置抢回去。
    const target = session.resume_lesson_id
      ? `#/lesson/${session.resume_lesson_id}`
      : session.book_id ? `#/book/${session.book_id}` : '#/shelf';
    history.replaceState(null, '', target);
  } catch { /* 恢复失败不影响正常开页 */ }
}

// 浏览器标签被真正关闭/刷新时也做一次软归档；服务端按 session id 原地更新，不会重复建卡。
window.addEventListener('pagehide', () => {
  fetch('/api/chat/session/checkpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: chatState.sessionId }),
    keepalive: true,
  }).catch(() => {});
});

function chatContext() {
  const { view } = routeInfo();
  if (view === 'lesson' && state.currentLesson) return { type: 'lesson', id: state.currentLesson.id, label: state.currentLesson.title };
  if (view === 'book' && state.currentBook) return { type: 'book', id: state.currentBook.id, label: state.currentBook.title };
  return { type: 'global', id: null, label: null };
}

function toggleGlobalChat(force) {
  chatState.open = force ?? !chatState.open;
  localStorage.setItem('learnloop.chatOpen', chatState.open ? '1' : '0');
  paintGlobalChat();
}

function companionBlockHtml(comp) {
  if (!comp?.configured) {
    return {
      title: '陪伴 agent<span class="llm-p-proto">未配置</span>',
      models: '<span class="llm-chip away" id="llm-companion-setup" title="去设置页接入你的陪伴 agent">+ 接入我的伙伴</span>',
    };
  }
  const n = esc(comp.name || '伙伴');
  const home = !!comp.home;
  return {
    title: `${n} · 陪伴<span class="llm-p-proto">${home ? '在家' : '不在家'}</span>`,
    models: `<span class="llm-chip llm-chip-companion ${home ? '' : 'away'} ${chatState.model?.provider_id === 'companion' ? 'current' : ''}"
      data-pid="companion" data-label="${n} · 陪伴"
      title="${home ? `${n}在家，随时开聊` : `${n}不在家——去看看它吧`}">${n}</span>`,
  };
}

async function paintGlobalChat() {
  const panel = $('#global-chat');
  if (!panel) return;
  panel.classList.toggle('open', chatState.open);
  document.body.classList.toggle('chat-open', chatState.open);
  $('#global-chat-toggle')?.classList.toggle('active', chatState.open);
  if (!chatState.open) return;

  if (!chatState.built) {
    const providers = await api('/api/providers');
    const comp = await api('/api/companion/status').catch(() => ({ home: false }));
    chatState.companion = comp; // {configured, home, name}
    // 已选中陪伴 agent 时，徽标跟随配置的名字
    if (chatState.model?.provider_id === 'companion' && comp?.configured) {
      const label = `${comp.name} · 陪伴`;
      if (chatState.model.label !== label) {
        chatState.model.label = label;
        localStorage.setItem('learnloop.chatModel', JSON.stringify(chatState.model));
      }
    }
    if (!chatState.model && providers.length) {
      const def = providers.find(p => p.is_default) || providers[0];
      chatState.model = { provider_id: def.id, model: def.default_model, label: `${def.name} · ${def.default_model}` };
    }
    panel.innerHTML = `
      <div class="chat-head">
        <span class="chat-title" id="chat-title" title="点我收起">老师来了</span>
        <button class="chat-cat-btn" id="chat-new" title="开新会话"><img class="chat-cat" src="/bastet-cat.png" alt=""></button>
        <button class="chat-archive" id="chat-archive" title="归档会话：存进「复习 · 会话记录」">入</button>
        <button class="llm-picker-btn" id="llm-picker-btn" title="选择模型"><span class="llm-label">${esc(chatState.model?.label || '选择模型')}</span></button>
      </div>
      <div class="chat-ctx" id="chat-ctx"></div>
      <div class="llm-list hidden" id="llm-list">
        ${providerMenuHtml({
          menuKey: 'chat',
          providers,
          activeKey: chatState.model?.provider_id === 'companion' ? 'companion' : String(chatState.model?.provider_id || ''),
          companionBlock: companionBlockHtml(chatState.companion),
          currentChip: (p, m) => chatState.model?.provider_id === p.id && chatState.model?.model === m.id,
        })}
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-quote hidden" id="chat-quote">
        <span class="q-text" id="chat-quote-text"></span>
        <button class="q-x" id="chat-quote-x" title="去掉引用">×</button>
      </div>
      <div class="chat-input-row">
        <textarea id="chat-input" rows="2" placeholder="让我看看谁又有新想法了…"></textarea>
        <button class="primary" id="chat-send">插嘴</button>
      </div>
      <div class="chat-drag" id="chat-drag" title="拖动调整栏宽"></div>`;
    // 异步构建期间可能发生第二次 render；每次重建 DOM 后都强制重载当前 session，避免历史被后到的空壳覆盖。
    chatState.built = true;
    chatState.ctxKey = null;

    // 左缘拖拽调宽（260–600px，自动记忆）
    $('#chat-drag').addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = ev => {
        const w = Math.round(Math.min(600, Math.max(260, startW + (startX - ev.clientX))));
        document.documentElement.style.setProperty('--col-right', w + 'px');
        localStorage.setItem('learnloop.chatW', w);
      };
      const up = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    bindProviderMenuExpansion(
      $('#llm-list'),
      'chat',
      chatState.model?.provider_id === 'companion' ? 'companion' : String(chatState.model?.provider_id || ''),
    );
    $('#llm-picker-btn').onclick = () => {
      $('#llm-list').classList.toggle('hidden');
    };
    $('#llm-list').onclick = e => {
      if (e.target.closest('#llm-companion-setup')) {
        $('#llm-list').classList.add('hidden');
        location.hash = '#/settings';
        return;
      }
      const chip = e.target.closest('.llm-chip');
      if (!chip) return;
      if (chip.dataset.pid === 'companion') {
        const comp = chatState.companion;
        if (!comp?.home) { toast(`${comp?.name || '伙伴'}不在家——去看看它吧`, true); return; }
        chatState.model = { provider_id: 'companion', model: 'companion', label: chip.dataset.label };
      } else {
        chatState.model = { provider_id: Number(chip.dataset.pid), model: chip.dataset.model, label: chip.dataset.label };
      }
      localStorage.setItem('learnloop.chatModel', JSON.stringify(chatState.model));
      $('#llm-picker-btn').innerHTML = `<span class="llm-label">${esc(chatState.model.label)}</span>`;
      $$('.llm-chip', panel).forEach(c => c.classList.toggle('current', c === chip));
      const providerKey = chip.dataset.pid === 'companion' ? 'companion' : chip.dataset.pid;
      const saved = loadModelMenuExpanded();
      saved.chat = providerKey;
      saveModelMenuExpanded(saved);
      paintProviderExpanded($('#llm-list'), providerKey);
      $('#llm-list').classList.add('hidden');
    };
    $('#chat-title').onclick = () => toggleGlobalChat(false);
    $('#chat-new').onclick = async () => {
      const ctx = chatContext();
      const btn = $('#chat-new');
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const { archived } = await api('/api/chat/session/new', { method: 'POST', body: {
          lesson_id: ctx.type === 'lesson' ? ctx.id : null,
          session_id: chatState.sessionId,
        } });
        chatState.ctxKey = null; // 强制重载新会话
        chatState.sessionId = null;
        await paintGlobalChat();
        toast(archived ? `旧会话已归档：${archived.title} · 新会话开始了` : '新会话开始了，放马过来吧');
      } catch (e) { toast(e.message, true); }
      finally { btn.disabled = false; }
    };
    $('#chat-archive').onclick = async () => {
      const ctx = chatContext();
      try {
        const { session } = await api('/api/chat/session/archive', { method: 'POST', body: { lesson_id: ctx.type === 'lesson' ? ctx.id : null } });
        toast(`已归档：${session.title} · 到「复习 · 会话记录」回看`);
        chatState.ctxKey = null; // 归档后服务端已开新会话，侧栏重载为全新对话
        chatState.sessionId = null;
        await paintGlobalChat();
      } catch (e) { toast(e.message, true); }
    };
    $('#chat-send').onclick = sendChat;
    $('#chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
  }

  // 划词引用条
  const quote = $('#chat-quote');
  if (chatState.pendingSelection) {
    $('#chat-quote-text').textContent = '「' + (chatState.pendingSelection.length > 120 ? chatState.pendingSelection.slice(0, 120) + '…' : chatState.pendingSelection) + '」';
    quote.classList.remove('hidden');
    setTimeout(() => $('#chat-input')?.focus(), 350);
  }
  $('#chat-quote-x').onclick = () => {
    chatState.pendingSelection = null;
    quote.classList.add('hidden');
  };

  const ctx = chatContext();
  const ctxEl = $('#chat-ctx');
  ctxEl.textContent = ctx.label ? `正在聊《${ctx.label}》` : '';
  ctxEl.style.display = ctx.label ? '' : 'none';
  const key = `${ctx.type}:${ctx.id}`;
  if (chatState.ctxKey !== key) {
    chatState.ctxKey = key;
    await loadChatHistory(ctx);
  }
}

async function loadChatHistory(ctx) {
  const box = $('#chat-messages');
  box.innerHTML = '<div class="chat-loading">…</div>';
  const data = ctx.type === 'lesson'
    ? await api(`/api/lessons/${ctx.id}/chat`)
    : await api('/api/chat');
  chatState.sessionId = data.session?.id || null;
  if (chatState.sessionId) localStorage.setItem('learnloop.activeChatSession', String(chatState.sessionId));
  const history = data.messages || [];
  box.innerHTML = history.length
    ? history.map(chatBubble).join('')
    : `<div class="chat-empty">老师来了。<br>放马过来吧。<br><span class="chat-empty-sub">点右上角换老师</span></div>`;
  renderMath(box);
  box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const input = $('#chat-input');
  const box = $('#chat-messages');
  const msg = input.value.trim();
  if (!msg || chatState.sending) return;
  chatState.sending = true;
  input.value = '';
  const selection = chatState.pendingSelection;
  chatState.pendingSelection = null;
  $('#chat-quote')?.classList.add('hidden');
  $('.chat-empty', box)?.remove();
  box.insertAdjacentHTML('beforeend', chatBubble({ role: 'user', content: msg, selection }));
  box.insertAdjacentHTML('beforeend', `<div class="chat-msg assistant typing" id="chat-typing"><div class="bubble">…</div></div>`);
  box.scrollTop = box.scrollHeight;
  const ctx = chatContext();
  try {
    const payload = { message: msg, selection, provider_id: chatState.model?.provider_id, model: chatState.model?.model };
    if (chatState.model?.provider_id === 'companion') {
      // 陪伴 agent：SSE 流式渲染
      const compName = chatState.companion?.name || '伙伴';
      const url = ctx.type === 'lesson' ? `/api/lessons/${ctx.id}/chat` : '/api/chat';
      if (ctx.type === 'book') payload.book_id = ctx.id;
      const typing = $('#chat-typing');
      const bubble = typing?.querySelector('.bubble');
      bubble?.classList.add('markdown');
      if (bubble) bubble.textContent = '';
      let answer = '';
      let errMsg = '';
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok || !res.body) throw new Error(`服务器返回 ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.error) { errMsg = ev.error; }
          else if (typeof ev.content === 'string') {
            answer = ev.content;
            if (bubble) { bubble.innerHTML = md(answer); box.scrollTop = box.scrollHeight; }
          }
          if (ev.done && ev.answer) answer = ev.answer;
        }
      }
      if (errMsg) throw new Error(errMsg);
      if (!answer) throw new Error(`${compName}没有回话`);
      if (typing) {
        typing.removeAttribute('id');
        typing.classList.remove('typing');
        if (bubble) bubble.innerHTML = md(answer);
        typing.insertAdjacentHTML('beforeend', `<div class="msg-model">${esc(compName)} · 陪伴</div>`);
        renderMath(typing);
      }
    } else {
      const r = ctx.type === 'lesson'
        ? await api(`/api/lessons/${ctx.id}/chat`, { method: 'POST', body: payload })
        : await api('/api/chat', { method: 'POST', body: { ...payload, book_id: ctx.type === 'book' ? ctx.id : undefined } });
      $('#chat-typing')?.remove();
      box.insertAdjacentHTML('beforeend', chatBubble({ role: 'assistant', content: r.answer, model_label: r.model_label }));
      renderMath(box.lastElementChild);
    }
  } catch (e) {
    $('#chat-typing')?.remove();
    box.insertAdjacentHTML('beforeend', `<div class="chat-msg assistant"><div class="bubble err">✕ ${esc(e.message)}</div></div>`);
  }
  box.scrollTop = box.scrollHeight;
  chatState.sending = false;
  input.focus();
}

function chatBubble(m) {
  if (m.role === 'user') {
    const q = m.selection ? `<div class="bubble-quote">「${esc(m.selection.length > 100 ? m.selection.slice(0, 100) + '…' : m.selection)}」</div>` : '';
    return `<div class="chat-msg user">${q}<div class="bubble">${esc(m.content)}</div></div>`;
  }
  return `<div class="chat-msg assistant"><div class="bubble markdown">${md(m.content)}</div>${m.model_label ? `<div class="msg-model">${esc(m.model_label)}</div>` : ''}</div>`;
}

window.addEventListener('load', () => {
  $('#global-chat-toggle')?.addEventListener('click', () => toggleGlobalChat());
});

// ---------- 学习提醒 ----------
async function initReminders() {
  try {
    const s = await api('/api/settings');
    if (!s.reminder_enabled || !('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;
    const check = async () => {
      try {
        const [h, m] = (s.reminder_time || '20:00').split(':').map(Number);
        const now = new Date();
        if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
        const today = now.toISOString().slice(0, 10);
        if (localStorage.getItem('learnloop.lastRemind') === today) return;
        const { count } = await api('/api/reviews/due-count');
        if (!count) return;
        localStorage.setItem('learnloop.lastRemind', today);
        const n = new Notification('LearnLoop · 复习提醒', { body: `今天有 ${count} 项复习到期，艾宾浩斯在等你。` });
        n.onclick = () => { window.focus(); location.hash = '#/reviews'; };
      } catch { /* ignore */ }
    };
    setInterval(check, 60000);
    check();
  } catch { /* ignore */ }
}
window.addEventListener('load', initReminders);

// ---------- 数据面板 ----------
function fmtMinutes(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`;
}

async function renderStats() {
  const st = await api('/api/stats');
  const today = new Date();
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayMap = new Map(st.timeByDay.map(d => [d.date, d.seconds]));

  // 近 14 天柱状图
  const days14 = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days14.push({ date: fmtDate(d), secs: dayMap.get(fmtDate(d)) || 0, today: i === 0 });
  }
  const maxSecs = Math.max(600, ...days14.map(d => d.secs));

  // 近 12 周热力图（周日开头）
  const heat = [];
  const startDow = new Date(today.getTime() - 83 * 86400000);
  for (let i = 83; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const secs = dayMap.get(fmtDate(d)) || 0;
    const min = secs / 60;
    const lv = min <= 0 ? 0 : min < 15 ? 1 : min < 45 ? 2 : min < 90 ? 3 : 4;
    heat.push({ date: fmtDate(d), lv, min: Math.round(min), dow: d.getDay() });
  }
  // 对齐第一周
  const pad = heat[0] ? heat[0].dow : 0;

  const reviewPct = st.reviews.total ? Math.round(st.reviews.done / st.reviews.total * 100) : 0;
  const R = 52, CIRC = 2 * Math.PI * R;

  app.innerHTML = `
    <h1 class="page-title">统计</h1>
    <p class="page-sub">学习时长从使用本应用开始自动累计（页面可见时才计时）。</p>

    <div class="stat-cards">
      <div class="card stat-card"><div class="stat-num">${fmtMinutes(st.todaySeconds)}</div><div class="stat-label">今日学习</div></div>
      <div class="card stat-card"><div class="stat-num">${fmtMinutes(st.focus?.todaySeconds || 0)}</div><div class="stat-label">今日专注 · ${st.focus?.todayCount || 0} 个番茄</div></div>
      <div class="card stat-card"><div class="stat-num">${st.streak}<span class="stat-unit">天</span></div><div class="stat-label">连续学习</div></div>
      <div class="card stat-card"><div class="stat-num">${fmtMinutes(st.totalSeconds)}</div><div class="stat-label">累计时长</div></div>
      <div class="card stat-card"><div class="stat-num">${st.lessons.avg_score || '—'}<span class="stat-unit">分</span></div><div class="stat-label">测验均分（${st.lessons.done}/${st.lessons.total} 节）</div></div>
    </div>

    <div class="stat-grid">
      <div class="card stat-panel">
        <h3>每日学习时长 · 近 14 天</h3>
        <div class="bar-chart">
          ${days14.map(d => `
            <div class="bar-col" title="${d.date} · ${fmtMinutes(d.secs)}">
              <div class="bar-track"><div class="bar ${d.today ? 'today' : ''}" style="height:${Math.max(2, Math.round(d.secs / maxSecs * 100))}%"></div></div>
              <div class="bar-label">${d.date.slice(5)}</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="card stat-panel">
        <h3>复习完成率</h3>
        <div class="ring-row">
          <svg width="130" height="130" viewBox="0 0 130 130" class="ring">
            <circle cx="65" cy="65" r="${R}" fill="none" stroke="var(--line)" stroke-width="10"/>
            <circle cx="65" cy="65" r="${R}" fill="none" stroke="var(--sage)" stroke-width="10"
              stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - reviewPct / 100)}"
              transform="rotate(-90 65 65)"/>
            <text x="65" y="62" text-anchor="middle" class="ring-num">${reviewPct}%</text>
            <text x="65" y="82" text-anchor="middle" class="ring-sub">${st.reviews.done}/${st.reviews.total} 轮</text>
          </svg>
          <div class="stage-bars">
            ${st.reviews.byStage.map(r => `
              <div class="stage-row" title="第 ${r.stage} 轮：${r.done}/${r.total}">
                <span class="stage-name">R${r.stage}</span>
                <div class="stage-track"><i style="width:${r.total ? Math.round(r.done / r.total * 100) : 0}%"></i></div>
                <span class="stage-count">${r.done}/${r.total}</span>
              </div>`).join('') || '<div class="chat-empty">还没有复习排期</div>'}
          </div>
        </div>
      </div>
    </div>

    <div class="card stat-panel" style="margin-top:22px">
      <div class="triple-row">
        <div class="triple-cell">
          <h3>学习热力 · 近 12 周</h3>
          <div class="heatmap">
            ${'<i class="hm-pad"></i>'.repeat(pad)}${heat.map(h => `<i class="hm lv${h.lv}" title="${h.date} · ${h.min} 分钟"></i>`).join('')}
          </div>
          <div class="hm-legend"><span>少</span><i class="hm lv0"></i><i class="hm lv1"></i><i class="hm lv2"></i><i class="hm lv3"></i><i class="hm lv4"></i><span>多</span></div>
        </div>
        <div class="triple-sep"></div>
        <div class="triple-cell">
          <h3>错题掌握度</h3>
          <div class="big-ratio">${st.wrongs.mastered}<span class="stat-dim"> / ${st.wrongs.total}</span></div>
          <div class="stage-track" style="margin-top:12px;max-width:220px"><i style="width:${st.wrongs.total ? Math.round(st.wrongs.mastered / st.wrongs.total * 100) : 0}%"></i></div>
        </div>
        <div class="triple-sep"></div>
        <div class="triple-cell">
          <h3>积累</h3>
          <div class="mini-stats">
            <div><b>${st.termCount}</b><span>术语</span></div>
            <div><b>${st.qaCount}</b><span>划词提问</span></div>
            <div><b>${st.chatCount}</b><span>师生对话</span></div>
          </div>
        </div>
        <div class="triple-sep"></div>
        <div class="triple-cell">
          <h3>本周</h3>
          <div class="mini-stats">
            <div><b>${fmtMinutes(st.weekSeconds)}</b><span>学习时长</span></div>
            <div><b>${st.dueCount}</b><span>待复习</span></div>
            <div><b>${st.highlightCount}</b><span>划线</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card stat-panel" style="margin-top:22px" id="weekly-panel">
      <h3>学习周报</h3>
      <div id="weekly-body"><div class="chat-empty">读取中…</div></div>
    </div>`;
  renderWeeklyPanel();
}

// ---------- 全文搜索 ----------
const SEARCH_KINDS = {
  lesson: { label: '课节', go: r => `#/lesson/${r.lesson_id}` },
  term: { label: '术语', go: r => `#/lesson/${r.lesson_id}` },
  highlight: { label: '划线', go: () => '#/highlights' },
  wrong: { label: '错题', go: () => '#/wrong' },
  qa: { label: '问答', go: r => r.lesson_id ? `#/lesson/${r.lesson_id}` : '#/shelf' },
};
let searchTimer = null;

function openSearch() {
  const ov = $('#search-overlay');
  ov.classList.remove('hidden');
  const input = $('#search-input');
  input.value = '';
  $('#search-results').innerHTML = '<div class="search-hint">输入关键词，搜全部教材的讲义、术语、划线和错题。</div>';
  setTimeout(() => input.focus(), 30);
}
function closeSearch() { $('#search-overlay').classList.add('hidden'); }

async function doSearch(q) {
  const box = $('#search-results');
  if (!q.trim()) { box.innerHTML = '<div class="search-hint">输入关键词，搜全部教材的讲义、术语、划线和错题。</div>'; return; }
  let data;
  try { data = await api('/api/search?q=' + encodeURIComponent(q.trim())); }
  catch (e) { box.innerHTML = `<div class="search-hint">${esc(e.message)}</div>`; return; }
  if ($('#search-input').value.trim() !== q.trim()) return; // 过期响应
  if (!data.results.length) {
    box.innerHTML = `<div class="search-hint">没有找到「${esc(q)}」。换个说法试试。</div>`;
    return;
  }
  const groups = [];
  for (const r of data.results) {
    const g = groups.find(g => g.kind === r.kind) || groups[groups.push({ kind: r.kind, items: [] }) - 1];
    g.items.push(r);
  }
  box.innerHTML = groups.map(g => `
    <div class="search-group">
      <div class="search-kind">${SEARCH_KINDS[g.kind]?.label || g.kind}</div>
      ${g.items.map(r => `
        <div class="search-item" data-kind="${r.kind}" data-payload='${esc(JSON.stringify({ lesson_id: r.lesson_id }))}'>
          <div class="si-title">${esc(r.title)}</div>
          <div class="si-snippet">${esc(r.snippet)}</div>
          <div class="si-src">${esc(r.book_title || '')}</div>
        </div>`).join('')}
    </div>`).join('');
  box.onclick = e => {
    const item = e.target.closest('.search-item');
    if (!item) return;
    const kind = item.dataset.kind;
    const payload = JSON.parse(item.dataset.payload || '{}');
    const meta = SEARCH_KINDS[kind];
    if (!meta) return;
    closeSearch();
    location.hash = meta.go(payload);
  };
}

window.addEventListener('load', () => {
  $('#search-toggle')?.addEventListener('click', openSearch);
  $('#search-close')?.addEventListener('click', closeSearch);
  $('#search-overlay')?.addEventListener('click', e => { if (e.target.id === 'search-overlay') closeSearch(); });
  $('#search-input')?.addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => doSearch(q), 260);
  });
  $('#search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') $('#search-results .search-item')?.click();
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#search-overlay').classList.contains('hidden') ? openSearch() : closeSearch();
    }
  });
});

// ---------- 番茄钟 ----------
(function initPomo() {
  const boot = () => {
    const root = $('#pomo');
    if (!root) return;
    const pill = $('#pomo-pill'), panel = $('#pomo-panel');
    const timeEl = $('#pomo-time'), pillTime = $('#pomo-pill-time');
    const labelEl = $('#pomo-label'), toggleBtn = $('#pomo-toggle'), todayEl = $('#pomo-today');
    let durMin = 25, kind = 'focus', running = false, endAt = 0, remainMs = 25 * 60000, tickTimer = null;

    const fmt = ms => `${String(Math.floor(Math.max(0, ms) / 60000)).padStart(2, '0')}:${String(Math.floor(Math.max(0, ms) % 60000 / 1000)).padStart(2, '0')}`;
    const persist = () => localStorage.setItem('learnloop.pomo', JSON.stringify({ durMin, kind, running, endAt, remainMs }));

    function paint() {
      const ms = running ? endAt - Date.now() : remainMs;
      const t = fmt(ms);
      timeEl.textContent = t;
      pillTime.textContent = t;
      toggleBtn.textContent = running ? '暂停' : (ms > 0 && ms < durMin * 60000 ? '继续' : '开始');
      labelEl.textContent = running
        ? (kind === 'focus' ? '专注中，别走开' : '休息一下')
        : (kind === 'focus' ? '准备专注' : '准备休息');
      root.classList.toggle('running', running);
      root.classList.toggle('break', kind !== 'focus');
      document.title = running ? `◔ ${t} · LearnOrNot` : 'LearnOrNot · 学不学';
    }

    function chime() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [523.25, 783.99].forEach((f, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
          g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.22 + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.5);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + i * 0.22); o.stop(ctx.currentTime + i * 0.22 + 0.55);
        });
      } catch { /* 无声也能用 */ }
    }

    function notify(title, body) {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') new Notification(title, { body });
    }

    async function refreshToday() {
      try {
        const st = await api('/api/stats');
        const f = st.focus || {};
        todayEl.textContent = f.todayCount ? `今日 ${f.todayCount} 个番茄 · 专注 ${fmtMinutes(f.todaySeconds || 0)}` : '今天还没有番茄，来第一个吧。';
      } catch { todayEl.textContent = ''; }
    }

    function start(resume) {
      running = true;
      if (!resume) endAt = Date.now() + remainMs;
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, 500);
      persist(); paint();
    }
    function tick() {
      if (endAt - Date.now() <= 0) complete();
      paint();
    }
    function pause() {
      running = false;
      remainMs = Math.max(0, endAt - Date.now());
      clearInterval(tickTimer);
      persist(); paint();
    }
    function reset() {
      running = false;
      clearInterval(tickTimer);
      remainMs = durMin * 60000;
      persist(); paint();
    }

    async function complete() {
      clearInterval(tickTimer);
      running = false;
      const doneKind = kind, doneMin = durMin;
      remainMs = durMin * 60000;
      chime();
      if (doneKind === 'focus') {
        notify('番茄完成', '专注 25 分钟达成，去休息一下吧。');
        const ctx = chatContext();
        try {
          const r = await api('/api/focus', { method: 'POST', body: {
            seconds: doneMin * 60, kind: 'focus', completed: true,
            book_id: ctx.type === 'book' ? ctx.id : (state.currentLesson?.book_id || null),
            lesson_id: ctx.type === 'lesson' ? ctx.id : null,
          } });
          const f = r.stats || {};
          todayEl.textContent = `今日 ${f.todayCount} 个番茄 · 专注 ${fmtMinutes(f.todaySeconds || 0)}`;
        } catch { /* 记录失败不打断 */ }
        setMode(5, 'break');
        start(); // 自动进入短休
        toast('番茄完成，自动开始 5 分钟短休');
      } else {
        notify('休息结束', '回来继续，下一个番茄等着你。');
        setMode(25, 'focus');
        toast('休息结束，可以开始下一个番茄了');
      }
      persist(); paint();
    }

    function setMode(min, k) {
      durMin = min; kind = k;
      remainMs = min * 60000;
      $$('.pomo-mode', panel).forEach(b => b.classList.toggle('active', Number(b.dataset.min) === min));
    }

    pill.onclick = () => {
      panel.classList.toggle('hidden');
      root.classList.toggle('collapsed', panel.classList.contains('hidden'));
      if (!panel.classList.contains('hidden')) refreshToday();
    };
    document.addEventListener('click', e => {
      if (!root.contains(e.target) && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        root.classList.add('collapsed');
      }
    });
    toggleBtn.onclick = () => running ? pause() : start(false);
    $('#pomo-reset').onclick = reset;
    $$('.pomo-mode', panel).forEach(b => b.onclick = () => {
      const min = Number(b.dataset.min);
      clearInterval(tickTimer);
      running = false;
      setMode(min, min === 25 ? 'focus' : 'break');
      persist(); paint();
    });

    // 恢复上次状态（跨页面/重开不掉计时）
    try {
      const s = JSON.parse(localStorage.getItem('learnloop.pomo') || 'null');
      if (s) {
        durMin = s.durMin || 25; kind = s.kind || 'focus';
        setMode(durMin, kind);
        remainMs = s.remainMs ?? durMin * 60000;
        if (s.running) {
          if (s.endAt > Date.now()) { endAt = s.endAt; start(true); }
          else { remainMs = durMin * 60000; } // 离开期间走完的，按未记录处理，不补记
        }
      }
    } catch { /* ignore */ }
    paint();
  };
  if (document.readyState === 'loading') window.addEventListener('load', boot);
  else boot();
})();

// ---------- 学习时长心跳 ----------
(function studyHeartbeat() {
  let pending = 0;
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (document.visibilityState === 'visible') pending += now - lastTick;
    lastTick = now;
    if (pending >= 60000) {
      const secs = Math.round(pending / 1000);
      pending = 0;
      api('/api/study/heartbeat', { method: 'POST', body: { seconds: secs } }).catch(() => { pending += secs * 1000; });
    }
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending >= 10000) {
      const secs = Math.round(pending / 1000);
      pending = 0;
      fetch('/api/study/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: secs }), keepalive: true,
      }).catch(() => {});
    }
    lastTick = Date.now();
  });
})();

// ---------- 学习周报 ----------
function weekLabel(ws) {
  const d = new Date(ws + 'T00:00:00');
  const end = new Date(d.getTime() + 6 * 86400000);
  return `${d.getMonth() + 1}月${d.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
}

async function renderWeeklyPanel() {
  const body = $('#weekly-body');
  if (!body) return;
  const reports = await api('/api/weekly-reports');
  const latest = reports[0];

  body.innerHTML = `
    ${latest ? `
      <div class="weekly-head">
        <span class="tag green">${weekLabel(latest.week_start)}</span>
        <span class="weekly-model">${esc(latest.model_label || '')} · ${esc(latest.created_at || '')}</span>
        <span style="flex:1"></span>
        <button class="small ghost" id="weekly-regen">重新生成本周</button>
      </div>
      <div class="markdown weekly-content">${md(latest.content)}</div>
    ` : ''}
    <div class="weekly-actions">
      <button class="${latest ? 'ghost' : 'primary'}" id="weekly-gen">${latest ? '生成上周周报' : '生成本周周报'}</button>
      ${!latest ? '<span style="font-size:.82rem;color:var(--ink-faint)">AI 会汇总这一周的学习曲线和错题，给你一份诊断与建议。</span>' : ''}
    </div>
    ${reports.length > 1 ? `
      <details style="margin-top:18px">
        <summary style="cursor:pointer;color:var(--ink-soft);font-size:.88rem">历史周报（${reports.length - 1}）</summary>
        ${reports.slice(1).map(r => `
          <div class="weekly-history-item">
            <div class="weekly-head"><span class="tag">${weekLabel(r.week_start)}</span><span class="weekly-model">${esc(r.model_label || '')}</span></div>
            <div class="markdown weekly-content">${md(r.content)}</div>
          </div>`).join('')}
      </details>` : ''}`;

  const gen = async (offset, force, btn) => {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'AI 复盘中…';
    try {
      await api('/api/weekly-report', { method: 'POST', body: { offset, force } });
      renderWeeklyPanel();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = orig;
    }
  };
  $('#weekly-gen')?.addEventListener('click', e => gen(latest ? -1 : 0, false, e.target));
  $('#weekly-regen')?.addEventListener('click', e => gen(0, true, e.target));
}

// ---------- 可拖拽分栏 ----------
function initColDividers() {
  const layout = $('#course-layout');
  if (!layout) return;
  const savedL = Number(localStorage.getItem('learnloop.colLeft'));
  const savedR = Number(localStorage.getItem('learnloop.colRight'));
  if (savedL) layout.style.setProperty('--col-left', savedL + 'px');
  if (savedR) layout.style.setProperty('--col-right', savedR + 'px');

  $$('.col-divider', layout).forEach(div => {
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      const side = div.dataset.side;
      const startX = e.clientX;
      const target = side === 'left' ? $('#outline') : $('#chat-panel');
      const startW = target.getBoundingClientRect().width;
      div.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const move = ev => {
        const dx = ev.clientX - startX;
        if (side === 'left') {
          const w = Math.round(Math.min(460, Math.max(200, startW + dx)));
          layout.style.setProperty('--col-left', w + 'px');
          localStorage.setItem('learnloop.colLeft', w);
        } else {
          const w = Math.round(Math.min(600, Math.max(260, startW - dx)));
          layout.style.setProperty('--col-right', w + 'px');
          localStorage.setItem('learnloop.colRight', w);
        }
      };
      const up = () => {
        div.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}
