// LearnLoop HTTP 服务：API + 静态前端
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import busboy from 'busboy';
import { store, TEXTS_DIR, UPLOADS_DIR, dumpAll, dumpFiles, restoreAll, restoreFiles } from './db.js';
import { detectFormat, parseDocument } from './parser.js';
import { importFromDsh, chat } from './llm.js';
import { generateOutline, generateLesson, gradeQuiz, gradeRetake, askQuestion, chatWithTeacher, generateWeeklyReport, locateSource, summarizeChatSession } from './pipeline.js';
import { exportToObsidian, obsidianStatus } from './exporter.js';
import { companionStatus, companionChat, companionConfig, companionConfigured, LOCAL_PRESET } from './companion.js';
import { synthesizeSpeech } from './tts.js';
import { oauthStatus, autoImportDshOAuth, reconcileOAuthProviders, startOAuthLogin, cancelOAuthLogin, logoutOAuth, importOAuthFromDsh } from './oauth.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 3210;

// ---------- 后台任务 ----------
const jobs = new Map(); // id -> {status, logs[], error, result}
let jobSeq = 0;
function runJob(label, fn) {
  const id = String(++jobSeq);
  const job = { id, label, status: 'running', logs: [], error: null, result: null, started: Date.now() };
  jobs.set(id, job);
  const log = (m) => { job.logs.push(String(m)); if (job.logs.length > 200) job.logs.shift(); };
  (async () => {
    try {
      job.result = await fn(log);
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      log('错误: ' + e.message);
    }
  })();
  return job;
}

// ---------- 工具 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function trustedLocalRequest(req) {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const internal = process.env.LEARNLOOP_INTERNAL_TOKEN;
  if (internal && req.headers['x-learnloop-internal'] === internal) return true;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (!host || !origin) return false;
  try {
    const target = new URL(`http://${host}`);
    const source = new URL(origin);
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
    return source.protocol === 'http:'
      && allowed.has(target.hostname) && allowed.has(source.hostname)
      && source.host === target.host;
  } catch { return false; }
}

// /api 全局本机校验（对全部接口生效，挡 DNS rebinding：攻击者域名 rebind 到 127.0.0.1 后
// 请求的 Host 是攻击者域名而非本机；同时拒绝显式 cross-site 的浏览器请求）。
// 与 trustedLocalRequest 的区别：GET 类同源请求浏览器不带 Origin，这里不强制要求 Origin，
// 但一旦带就必须与本机 Host 同源。curl 等工具只要 Host 指向本机即可通过。
function localApiRequest(req) {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const internal = process.env.LEARNLOOP_INTERNAL_TOKEN;
  if (internal && req.headers['x-learnloop-internal'] === internal) return true;
  const host = req.headers.host;
  if (!host) return false;
  let hostname;
  try { hostname = new URL(`http://${host}`).hostname; } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const source = new URL(origin);
      if (source.protocol !== 'http:' || source.host !== host) return false;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) return false;
    } catch { return false; }
  }
  return true;
}

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
const ok = (res, data) => send(res, 200, data, { 'Content-Type': 'application/json; charset=utf-8' });
const bad = (res, msg, code = 400) => send(res, code, { error: msg }, { 'Content-Type': 'application/json; charset=utf-8' });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: 200 * 1024 * 1024, files: 1 } }); // 浏览器按 UTF-8 发文件名，默认 latin1 会乱码
    let filePromise = null;
    bb.on('file', (name, file, info) => {
      filePromise = new Promise((res2, rej2) => {
        const safe = `${Date.now()}-${(info.filename || 'upload').replace(/[^\w.一-龥-]/g, '_')}`;
        const dest = path.join(UPLOADS_DIR, safe);
        const ws = fs.createWriteStream(dest);
        file.pipe(ws);
        ws.on('finish', () => res2({ path: dest, filename: info.filename || safe }));
        ws.on('error', rej2);
        file.on('limit', () => rej2(new Error('文件超过 200MB 限制')));
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => filePromise ? filePromise.then(resolve, reject) : reject(new Error('没有收到文件')));
    req.pipe(bb);
  });
}

// ---------- 路由 ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

// 书籍
route('GET', '/api/books', async () => store.listBooks());
route('POST', '/api/upload', async (req) => {
  const file = await parseMultipart(req);
  const format = detectFormat(file.filename);
  const title = path.basename(file.filename, path.extname(file.filename));
  const bookId = Number(store.addBook({ title, filename: file.filename, format, status: 'parsing' }).lastInsertRowid);
  try {
    const text = await parseDocument(file.path, format);
    if (!text || text.trim().length < 50) throw new Error('解析出的文本太少，可能是扫描版 PDF（图片型）或文件损坏');
    fs.writeFileSync(path.join(TEXTS_DIR, `${bookId}.txt`), text);
    store.setBookStatus(bookId, 'parsed');
  } catch (e) {
    store.setBookStatus(bookId, 'failed', e.message);
    throw e;
  }
  return store.getBook(bookId);
});
route('GET', '/api/books/:id', async (req, { id }) => {
  const book = store.getBook(Number(id));
  if (!book) throw Object.assign(new Error('书籍不存在'), { code: 404 });
  return { ...book, outline: store.getOutline(book.id) };
});
route('DELETE', '/api/books/:id', async (req, { id }) => {
  store.deleteBook(Number(id));
  try { fs.unlinkSync(path.join(TEXTS_DIR, `${id}.txt`)); } catch {}
  return { ok: true };
});
route('POST', '/api/books/:id/outline', async (req, { id }) => {
  const bookId = Number(id);
  const job = runJob(`生成大纲 book#${id}`, async (log) => {
    try {
      return await generateOutline(bookId, log);
    } catch (e) {
      // 后台任务失败也要把书籍状态写回来，否则书架会永久停在「拆课中」且无法重试。
      store.setBookStatus(bookId, 'failed', e.message || '课程生成失败');
      throw e;
    }
  });
  return { jobId: job.id };
});

// 课节
route('GET', '/api/lessons/:id', async (req, { id }) => {
  const l = store.getLesson(Number(id));
  if (!l) throw Object.assign(new Error('课节不存在'), { code: 404 });
  store.setLastLesson(l.book_id, l.id); // 记忆学习位置（书架/课程地图「继续学习」直达）
  return l;
});
route('POST', '/api/lessons/:id/generate', async (req, { id }) => {
  const l = store.getLesson(Number(id));
  if (l?.status === 'ready') return { jobId: null, lesson: l };
  const job = runJob(`备课 lesson#${id}`, (log) => generateLesson(Number(id), log));
  return { jobId: job.id };
});
route('POST', '/api/lessons/:id/grade', async (req, { id }, body) => {
  return gradeQuiz(Number(id), body.answers || []);
});
route('POST', '/api/lessons/:id/ask', async (req, { id }, body) => {
  const lesson = store.getLesson(Number(id));
  const answer = await askQuestion({ bookId: lesson.book_id, lessonId: Number(id), selection: body.selection, question: body.question });
  return { answer };
});
route('POST', '/api/lessons/:id/study-status', async (req, { id }, body) => {
  store.setLessonStudy(Number(id), body.status);
  return { ok: true };
});

// 朗读（Edge TTS 在线合成，免费无需 key，需联网）
route('POST', '/api/tts', async (req, _p, body, _q, res) => {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('没有要朗读的文本');
  if (text.length > 4000) throw Object.assign(new Error('单段文本过长'), { code: 413 });
  const voice = /^[\w-]+$/.test(body.voice || '') ? body.voice : undefined;
  const rate = /^(default|[+-]?\d+%)$/.test(body.rate || '') ? body.rate : undefined;
  const buf = await synthesizeSpeech(text, { voice, rate });
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
  return HANDLED;
});

// 任务
route('GET', '/api/jobs/:id', async (req, { id }) => {
  const job = jobs.get(id); // jobs 只在内存里，服务重启即丢——查不到要明确 404，前端才能停止轮询报错
  if (!job) throw Object.assign(new Error('任务不存在（可能已随服务重启丢失，请重试）'), { code: 404 });
  return job;
});

// 术语 / 错题 / 问答
route('GET', '/api/books/:id/terms', async (req, { id }) => {
  const rows = store.bookTerms(Number(id));
  const terms = [];
  for (const r of rows) {
    for (const t of JSON.parse(r.terms || '[]')) terms.push({ ...t, lesson_id: r.lesson_id, lesson_title: r.lesson_title });
  }
  return terms;
});
route('GET', '/api/wrong', async (req, _p, _b, query) => store.listWrong(query.book_id ? Number(query.book_id) : null));
route('POST', '/api/wrong/:id/mastered', async (req, { id }, body) => { store.setWrongMastered(Number(id), body.mastered); return { ok: true }; });
route('GET', '/api/books/:id/qa', async (req, { id }) => store.listQa(Number(id)));

// 错题重考
route('GET', '/api/wrong/retake', async (req, _p, _b, query) => {
  const pool = store.retakePool(query.book_id ? Number(query.book_id) : null, 10);
  return pool.map(w => ({
    id: w.id, qtype: w.qtype, question: w.question,
    options: w.options ? JSON.parse(w.options) : null,
    lesson_title: w.lesson_title, book_title: w.book_title,
    retake_count: w.retake_count || 0, streak: w.streak || 0,
  }));
});
route('POST', '/api/wrong/retake/grade', async (req, _p, body) => {
  if (!Array.isArray(body.answers) || !body.answers.length) throw new Error('没有收到答案');
  return gradeRetake(body.answers);
});

// 全文搜索（讲义/课名/术语/划线/错题/问答）
route('GET', '/api/search', async (req, _p, _b, query) => {
  const q = String(query.q || '').trim();
  if (q.length < 1) return { q, results: [] };
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const snippet = (text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return t.slice(0, 90);
    return (i > 30 ? '…' : '') + t.slice(Math.max(0, i - 30), i + q.length + 60) + (i + q.length + 60 < t.length ? '…' : '');
  };
  const results = [];

  for (const r of store.raw(`SELECT l.id, l.book_id, l.title, l.goal, l.preguide, l.content, b.title AS book_title
      FROM lessons l JOIN books b ON b.id=l.book_id
      WHERE l.status='ready' AND (l.title LIKE ? OR l.goal LIKE ? OR l.content LIKE ? OR l.preguide LIKE ?)
      ORDER BY l.book_id, l.idx LIMIT 20`, like, like, like, like)) {
    const field = r.title.includes(q) ? r.title : r.goal?.includes(q) ? r.goal
      : r.content?.toLowerCase().includes(q.toLowerCase()) ? r.content : r.preguide;
    results.push({ kind: 'lesson', lesson_id: r.id, book_id: r.book_id, title: r.title, book_title: r.book_title, snippet: snippet(field) });
  }
  for (const r of store.raw(`SELECT l.id, l.book_id, l.title, l.terms, b.title AS book_title
      FROM lessons l JOIN books b ON b.id=l.book_id WHERE l.terms LIKE ? LIMIT 40`, like)) {
    for (const t of JSON.parse(r.terms || '[]')) {
      if (String(t.term).includes(q) || String(t.annotation).includes(q)) {
        results.push({ kind: 'term', lesson_id: r.id, book_id: r.book_id, title: t.term, book_title: r.book_title, snippet: snippet(t.annotation) });
      }
    }
    if (results.length > 60) break;
  }
  for (const r of store.raw(`SELECT h.id, h.lesson_id, h.book_id, h.text, h.passage, l.title AS lesson_title, b.title AS book_title
      FROM highlights h LEFT JOIN lessons l ON l.id=h.lesson_id LEFT JOIN books b ON b.id=h.book_id
      WHERE h.text LIKE ? OR h.passage LIKE ? ORDER BY h.id DESC LIMIT 10`, like, like)) {
    results.push({ kind: 'highlight', id: r.id, lesson_id: r.lesson_id, book_id: r.book_id, title: r.lesson_title || '划线', book_title: r.book_title, snippet: snippet(r.text) });
  }
  for (const r of store.raw(`SELECT w.id, w.lesson_id, w.book_id, w.question, w.explanation, l.title AS lesson_title, b.title AS book_title
      FROM wrong_questions w LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
      WHERE w.question LIKE ? OR w.explanation LIKE ? ORDER BY w.id DESC LIMIT 10`, like, like)) {
    results.push({ kind: 'wrong', id: r.id, lesson_id: r.lesson_id, book_id: r.book_id, title: r.lesson_title || '错题', book_title: r.book_title, snippet: snippet(r.question) });
  }
  for (const r of store.raw(`SELECT q.id, q.lesson_id, q.book_id, q.question, q.answer, b.title AS book_title
      FROM qa q LEFT JOIN books b ON b.id=q.book_id
      WHERE q.question LIKE ? OR q.answer LIKE ? ORDER BY q.id DESC LIMIT 10`, like, like)) {
    results.push({ kind: 'qa', lesson_id: r.lesson_id, book_id: r.book_id, title: snippet(r.question), book_title: r.book_title, snippet: snippet(r.answer) });
  }
  return { q, results: results.slice(0, 50) };
});

// 番茄钟
route('POST', '/api/focus', async (req, _p, body) => {
  const secs = Number(body.seconds);
  if (!Number.isFinite(secs) || secs < 30 || secs > 7200) throw new Error('时长不合法');
  store.addFocusSession({ kind: body.kind === 'break' ? 'break' : 'focus', seconds: secs, book_id: body.book_id, lesson_id: body.lesson_id, completed: body.completed !== false });
  return { ok: true, stats: store.focusStats() };
});

// 备份 / 恢复
route('GET', '/api/backup', async (req, _p, _b, query) => {
  const payload = { ...dumpAll(), files: dumpFiles() };
  // 默认不导出 provider 的 api_key（备份文件一旦外泄即泄露密钥）；显式 ?secrets=1 才包含
  if (query.secrets !== '1') {
    payload.tables = { ...payload.tables, providers: (payload.tables.providers || []).map(({ api_key, ...rest }) => rest) };
  }
  return payload;
});
route('POST', '/api/backup/restore', async (req, _p, body) => {
  const result = restoreAll(body);
  const files = restoreFiles(body?.files);
  await reconcileOAuthProviders(); // OAuth 令牌不进备份；若本机仍有登录，恢复对应 provider 外壳。
  return { ...result, files };
});

// 翰林院 · Obsidian 沉淀
route('GET', '/api/export/obsidian/status', async () => obsidianStatus());
route('POST', '/api/export/obsidian', async () => exportToObsidian());

// Anki CSV 导出：术语卡 / 错题卡（Anki「导入文件」选 CSV，逗号分隔，字段内允许 HTML）
route('GET', '/api/export/anki', async (req, _p, _b, query, res) => {
  const type = query.type === 'wrong' ? 'wrong' : 'terms';
  const bookId = query.book_id ? Number(query.book_id) : null;
  const csvEsc = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, '<br>')}"`;
  const rows = [];
  if (type === 'terms') {
    for (const l of store.raw(bookId
      ? `SELECT l.title, l.terms, b.title AS book_title FROM lessons l JOIN books b ON b.id=l.book_id WHERE l.book_id=? AND l.terms IS NOT NULL ORDER BY l.idx`
      : `SELECT l.title, l.terms, b.title AS book_title FROM lessons l JOIN books b ON b.id=l.book_id WHERE l.terms IS NOT NULL ORDER BY l.book_id, l.idx`,
      ...(bookId ? [bookId] : []))) {
      let terms = [];
      try { terms = JSON.parse(l.terms); } catch { continue; }
      for (const t of terms) {
        if (!t?.term) continue;
        rows.push([t.term, `${t.annotation || ''}<br><small>${l.book_title || ''} · ${l.title}</small>`]);
      }
    }
  } else {
    for (const w of store.listWrong(bookId)) {
      let opts = null;
      try { opts = w.options ? JSON.parse(w.options) : null; } catch { /* options 损坏按简答处理 */ }
      const front = Array.isArray(opts) && opts.length
        ? `${w.question}<br>${opts.map((o, i) => `${'ABCD'[i] || '.'}. ${o}`).join('<br>')}`
        : w.question;
      rows.push([front, `${w.correct_answer || ''}${w.explanation ? `<br><br>解析：${w.explanation}` : ''}<br><small>${w.book_title || ''} · ${w.lesson_title || ''}</small>`]);
    }
  }
  if (!rows.length) throw new Error('没有可导出的内容');
  const csv = '\uFEFF' + rows.map(r => r.map(csvEsc).join(',')).join('\r\n'); // BOM 方便 Excel 正确识别 UTF-8
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="learnloop-${type}${bookId ? `-book${bookId}` : ''}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(csv);
  return HANDLED;
});

// 文件夹/仓库导入（把 Markdown 目录树合成一本书）
const DIR_IMPORT_EXCLUDE = new Set(['.git', '.venv', 'node_modules', 'en-us', 'img', 'images', 'PPT', '__pycache__']);

function collectMarkdown(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || DIR_IMPORT_EXCLUDE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectMarkdown(full, base, out);
    else if (/\.(md|markdown|txt)$/i.test(ent.name)) {
      const size = fs.statSync(full).size;
      if (size > 300 * 1024) continue; // 单文件过大跳过
      out.push({ path: full, rel: path.relative(base, full), size });
    }
  }
  return out;
}

route('POST', '/api/import-dir', async (req, _p, body) => {
  const dir = body.path?.trim();
  if (!dir) throw new Error('缺少 path');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`目录不存在: ${dir}`);
  const files = collectMarkdown(dir);
  if (!files.length) throw new Error('目录里没有找到 Markdown/TXT 文件');
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN', { numeric: true }));
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > 5 * 1024 * 1024) throw new Error(`内容总量 ${(total / 1048576).toFixed(1)}MB 超过 5MB 上限，建议按子教程分别导入`);

  const title = body.title?.trim() || path.basename(dir.replace(/\/+$/, ''));
  const parts = files.map(f => `\n\n# 【文件：${f.rel}】\n\n${fs.readFileSync(f.path, 'utf8')}`);
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 100) throw new Error('合并后的文本太少');

  const bookId = Number(store.addBook({ title, filename: dir, format: 'dir-md', status: 'parsed' }).lastInsertRowid);
  fs.writeFileSync(path.join(TEXTS_DIR, `${bookId}.txt`), text);
  return { ...store.getBook(bookId), fileCount: files.length, totalChars: text.length };
});

// ai-edu 仓库快捷目录
route('GET', '/api/ai-edu/catalog', async () => {
  const repo = path.resolve(ROOT, '..', 'ai-edu');
  if (!fs.existsSync(repo)) return { found: false, items: [] };
  const items = [];
  for (const group of ['基础教程', '实践案例']) {
    const gdir = path.join(repo, group);
    if (!fs.existsSync(gdir)) continue;
    for (const ent of fs.readdirSync(gdir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const full = path.join(gdir, ent.name);
      const files = collectMarkdown(full);
      if (!files.length) continue;
      items.push({
        group, name: ent.name, path: full,
        fileCount: files.length,
        totalKB: Math.round(files.reduce((n, f) => n + f.size, 0) / 1024),
      });
    }
  }
  return { found: true, repo, items };
});

// 复习（艾宾浩斯）
route('GET', '/api/reviews', async () => ({
  due: store.dueReviews(),
  upcoming: store.upcomingReviews(),
  dueCount: store.dueReviewCount(),
}));
route('GET', '/api/reviews/due-count', async () => ({ count: store.dueReviewCount() }));
route('GET', '/api/reviews/:id', async (req, { id }) => {
  const r = store.getReview(Number(id));
  if (!r) throw Object.assign(new Error('复习项不存在'), { code: 404 });
  const lesson = store.getLesson(r.lesson_id);
  return { ...r, lesson };
});
route('POST', '/api/reviews/:id/complete', async (req, { id }, body) => {
  store.completeReview(Number(id), body.score ?? null);
  return { ok: true };
});

// 聊天（AI 老师）
route('GET', '/api/lessons/:id/chat', async (req, { id }) => {
  const session = store.currentChatSession(Number(id));
  return { session, messages: store.listSessionMessages(session.id, 200) };
});
route('POST', '/api/lessons/:id/chat', async (req, { id }, body, _q, res) => {
  const lesson = store.getLesson(Number(id));
  if (!lesson) throw Object.assign(new Error('课节不存在'), { code: 404 });
  if (!body.message?.trim()) throw new Error('消息不能为空');
  if (body.provider_id === 'companion') {
    return chatWithCompanion({ bookId: lesson.book_id, lessonId: Number(id), message: body.message.trim(), selection: body.selection }, res);
  }
  const args = {
    bookId: lesson.book_id, lessonId: Number(id),
    message: body.message.trim(), selection: body.selection, providerId: body.provider_id, model: body.model, mode: body.mode,
  };
  if (body.stream) return chatWithTeacherSse(args, res);
  return chatWithTeacher(args);
});

// 聊天会话：恢复 / 新开 / 手动归档 / 列表 / 回看
function localChatArchiveTitle(sessionId) {
  const firstUser = store.listSessionMessages(sessionId, 200).find(m => m.role === 'user');
  return String(firstUser?.content || '未命名讨论').replace(/\s+/g, ' ').trim().slice(0, 16) || '未命名讨论';
}
async function chatArchiveTitle(sessionId) {
  try {
    const title = await summarizeChatSession(sessionId);
    if (title) return title;
  } catch { /* 模型不可用时仍须允许归档 */ }
  return localChatArchiveTitle(sessionId);
}
route('GET', '/api/chat/session/last', async () => ({ session: store.lastResumableChatSession() || null }));
route('POST', '/api/chat/session/checkpoint', async (req, _p, body) => {
  if (!trustedLocalRequest(req)) { const error = new Error('forbidden'); error.code = 403; throw error; }
  const requested = Number(body.session_id) || null;
  const current = requested ? store.getChatSession(requested) : store.lastResumableChatSession();
  if (!current?.id || !current.is_current || !store.sessionMsgCount(current.id)) return { session: null };
  const session = store.checkpointChatSession(current.id, localChatArchiveTitle(current.id));
  return { session };
});
route('POST', '/api/chat/session/new', async (req, _p, body) => {
  const lessonId = body.lesson_id ?? null;
  const cur = store.currentChatSession(lessonId);
  const expectedSessionId = Number(body.session_id) || null;
  // 双击或旧页面重复提交：第一次已切到新会话时，后续请求不再多建空会话。
  if (expectedSessionId && cur.id !== expectedSessionId) return { session: cur, archived: null, already_new: true };
  let archived = null;
  if (store.sessionMsgCount(cur.id)) {
    // 黑猫开新会话必须即时完成；用首条问题作标题，AI 润色留给手动归档/维护接口。
    archived = store.archiveChatSession(lessonId, localChatArchiveTitle(cur.id));
    return { session: store.currentChatSession(lessonId), archived };
  }
  const session = store.newChatSession(lessonId);
  return { session, archived };
});
route('POST', '/api/chat/session/archive', async (req, _p, body) => {
  const lessonId = body.lesson_id ?? null;
  const cur = store.currentChatSession(lessonId);
  if (!store.sessionMsgCount(cur.id)) throw new Error('这个会话还没有内容，聊几句再归档');
  const session = store.archiveChatSession(lessonId, await chatArchiveTitle(cur.id));
  return { session };
});
route('GET', '/api/chat/sessions', async () => store.listArchivedSessions());
// 维护：给占位标题的归档会话补 AI 主题总结
route('POST', '/api/chat/sessions/retitle', async () => {
  const rows = store.raw(`SELECT id FROM chat_sessions WHERE archived=1 AND (title IS NULL OR title IN ('之前的讨论','未命名讨论'))`);
  const done = [];
  for (const r of rows) {
    const t = await summarizeChatSession(r.id);
    if (t) { store.raw(`UPDATE chat_sessions SET title=? WHERE id=?`, t, r.id); done.push({ id: r.id, title: t }); }
  }
  return { retitled: done };
});
route('GET', '/api/chat/sessions/:id', async (req, { id }) => {
  const session = store.getChatSession(Number(id));
  if (!session) throw Object.assign(new Error('会话不存在'), { code: 404 });
  return { session, messages: store.listSessionMessages(session.id, 500) };
});

// 薄弱主题：未掌握错题聚集的课节 + 低分已完成的课节（供统计页与「去重考」直达）
route('GET', '/api/stats/weak', async () => {
  const byWrong = store.raw(`SELECT w.lesson_id, l.title, l.book_id, b.title AS book_title,
      COUNT(*) AS wrong_total, SUM(CASE WHEN w.mastered=0 THEN 1 ELSE 0 END) AS unmastered
    FROM wrong_questions w LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
    WHERE w.lesson_id IS NOT NULL
    GROUP BY w.lesson_id HAVING unmastered > 0 ORDER BY unmastered DESC, wrong_total DESC LIMIT 8`);
  const lowScore = store.raw(`SELECT l.id, l.title, l.book_id, b.title AS book_title, l.quiz_score
    FROM lessons l JOIN books b ON b.id=l.book_id
    WHERE l.status='ready' AND l.study_status='done' AND l.quiz_score IS NOT NULL AND l.quiz_score < 70
    ORDER BY l.quiz_score ASC LIMIT 8`);
  return { byWrong, lowScore };
});

// 学习时长心跳 + 统计
route('POST', '/api/study/heartbeat', async (req, _p, body) => {
  const secs = Number(body.seconds);
  if (Number.isFinite(secs) && secs > 0 && secs < 3600) store.addStudyTime(secs);
  return { ok: true };
});
route('GET', '/api/stats', async () => {
  const timeByDay = store.timeByDay(84);
  // 连续学习天数（今天没学则从今天前一天往回算）
  const daySet = new Map(timeByDay.map(d => [d.date, d.seconds]));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  let streak = 0;
  let cursor = (daySet.get(fmt(now)) || 0) > 0 ? now : new Date(now.getTime() - 86400000);
  while ((daySet.get(fmt(cursor)) || 0) > 0) { streak++; cursor = new Date(cursor.getTime() - 86400000); }

  const lessons = store.rawGet(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN study_status='done' THEN 1 ELSE 0 END) AS done,
    ROUND(AVG(quiz_score)) AS avg_score FROM lessons WHERE status='ready'`);
  const reviewsByStage = store.raw(`SELECT stage, COUNT(*) AS total, SUM(done) AS done FROM reviews GROUP BY stage ORDER BY stage`);
  const wrongs = store.rawGet('SELECT COUNT(*) AS total, SUM(mastered) AS mastered FROM wrong_questions');
  const qaCount = store.rawGet('SELECT COUNT(*) AS n FROM qa').n;
  const chatCount = store.rawGet(`SELECT COUNT(*) AS n FROM chat_messages WHERE role='user'`).n;
  let termCount = 0;
  for (const r of store.raw(`SELECT terms FROM lessons WHERE terms IS NOT NULL`)) {
    try { termCount += JSON.parse(r.terms).length; } catch { /* ignore */ }
  }
  const totalSeconds = timeByDay.reduce((n, d) => n + d.seconds, 0);
  const todaySeconds = daySet.get(fmt(now)) || 0;
  const weekStart = fmt(new Date(now.getTime() - 6 * 86400000));
  const weekSeconds = timeByDay.filter(d => d.date >= weekStart).reduce((n, d) => n + d.seconds, 0);
  const highlightCount = store.rawGet('SELECT COUNT(*) AS n FROM highlights').n;
  const dueCount = store.dueReviewCount();

  return {
    timeByDay, streak, totalSeconds, todaySeconds,
    lessons: { total: lessons.total || 0, done: lessons.done || 0, avg_score: lessons.avg_score || 0 },
    reviews: {
      byStage: reviewsByStage.map(r => ({ stage: r.stage, total: r.total, done: r.done || 0 })),
      total: reviewsByStage.reduce((n, r) => n + r.total, 0),
      done: reviewsByStage.reduce((n, r) => n + (r.done || 0), 0),
    },
    wrongs: { total: wrongs.total || 0, mastered: wrongs.mastered || 0 },
    termCount, qaCount, chatCount, weekSeconds, highlightCount, dueCount,
    focus: store.focusStats(),
  };
});

// 周报
route('GET', '/api/weekly-reports', async () => store.listWeeklyReports());
route('POST', '/api/weekly-report', async (req, _p, body) => {
  return generateWeeklyReport({ offset: Number(body.offset) || 0, force: !!body.force });
});

// 划线
route('GET', '/api/highlights', async (req, _p, _b, query) => store.listHighlights(query.book_id ? Number(query.book_id) : null));
route('POST', '/api/highlights', async (req, _p, body) => {
  if (!body.text?.trim()) throw new Error('划线内容为空');
  if (!body.book_id) throw new Error('缺少 book_id');
  const id = store.addHighlight({ book_id: Number(body.book_id), lesson_id: body.lesson_id ? Number(body.lesson_id) : null, text: body.text.trim(), passage: body.passage, note: body.note?.trim() || null });
  return { id: Number(id.lastInsertRowid ?? id) };
});
route('PUT', '/api/highlights/:id', async (req, { id }, body) => {
  store.updateHighlightNote(Number(id), body.note?.trim() || null);
  return { ok: true };
});
route('DELETE', '/api/highlights/:id', async (req, { id }) => { store.deleteHighlight(Number(id)); return { ok: true }; });

// 课节原文（供术语卡等处查看出处）
route('GET', '/api/lessons/:id/source', async (req, { id }) => {
  const lesson = store.getLesson(Number(id));
  if (!lesson) throw Object.assign(new Error('课节不存在'), { code: 404 });
  const text = fs.readFileSync(path.join(TEXTS_DIR, `${lesson.book_id}.txt`), 'utf8');
  return { excerpt: locateSource(text, lesson) };
});

// 全局聊天（不限课节）
route('GET', '/api/chat', async () => {
  const session = store.currentChatSession(null);
  return { session, messages: store.listSessionMessages(session.id, 200) };
});
route('POST', '/api/chat', async (req, _p, body, _q, res) => {
  if (!body.message?.trim()) throw new Error('消息不能为空');
  if (body.provider_id === 'companion') {
    return chatWithCompanion({ bookId: body.book_id || null, lessonId: null, message: body.message.trim(), selection: body.selection }, res);
  }
  const args = {
    bookId: body.book_id || null, lessonId: null,
    message: body.message.trim(), selection: body.selection, providerId: body.provider_id, model: body.model, mode: body.mode,
  };
  if (body.stream) return chatWithTeacherSse(args, res);
  return chatWithTeacher(args);
});

// 自定义 CSS（设置页 snippets）：以样式表形式直接 link 进页面
route('GET', '/api/custom.css', async (req, _p, _b, _q, res) => {
  res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(store.getSetting('custom_css') || '');
  return HANDLED;
});

// 陪伴 agent 在线状态（前端用来置灰「不在家」）
route('GET', '/api/companion/status', async () => companionStatus());
// 本地实例预设（常见本地伙伴实例的默认连接参数，名字留空由用户自己起）
route('GET', '/api/companion/preset/local', async () => LOCAL_PRESET);
// 会话自动发现：多会话型 agent（sendPath 含 {conv}）时，取最近活跃的会话 id
route('POST', '/api/companion/discover', async (req, _p, body) => {
  const url = String(body.url || '').replace(/\/+$/, '');
  const statusPath = String(body.status_path || '/status');
  if (!url) throw new Error('先填地址');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('地址格式不对'); }
  // 只允许 http/https；本接口目标就是发现本机/局域网的 agent 实例，私网地址是设计用途，
  // 入口已有 localApiRequest 全局校验挡住外部页面。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https 地址');
  // statusPath 必须是站内绝对路径：拼 URL 时防「@host」「//host」之类的字符串注入跳到别的服务器
  if (!statusPath.startsWith('/') || statusPath.startsWith('//')) throw new Error('状态路径必须是以 / 开头的站内路径');
  const res = await fetch(`${url}${statusPath}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`对方返回 ${res.status}`);
  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  if (!first?.id) throw new Error('没有发现可用会话');
  return { conv: first.id, title: first.title || '' };
});

// 设置
route('GET', '/api/settings', async () => ({
  reminder_enabled: store.getSetting('reminder_enabled') === '1',
  reminder_time: store.getSetting('reminder_time') || '20:00',
  companion: companionConfig(),
  companion_configured: companionConfigured(),
  hanlin_dir: store.getSetting('hanlin_dir') || '',
  dsh_available: fs.existsSync(path.join(os.homedir(), '.dsh', 'settings.yaml')),
}));
route('POST', '/api/settings', async (req, _p, body) => {
  if (body.reminder_enabled != null) store.setSetting('reminder_enabled', body.reminder_enabled ? '1' : '0');
  if (body.reminder_time) store.setSetting('reminder_time', body.reminder_time);
  if (body.companion) {
    for (const k of ['name', 'url', 'status_path', 'send_path', 'conv']) {
      if (body.companion[k] != null) store.setSetting('companion_' + k, String(body.companion[k]).trim());
    }
  }
  if (body.hanlin_dir != null) store.setSetting('hanlin_dir', String(body.hanlin_dir).trim());
  if (body.custom_css != null) store.setSetting('custom_css', String(body.custom_css));
  return { ok: true };
});

// Providers + 订阅 OAuth
route('GET', '/api/oauth/status', async () => oauthStatus());
route('POST', '/api/oauth/:platform/login', async (req, { platform }, body) => {
  if (!trustedLocalRequest(req)) { const error = new Error('forbidden'); error.code = 403; throw error; }
  return startOAuthLogin(platform, body.mode);
});
route('POST', '/api/oauth/:platform/cancel', async (req, { platform }) => {
  if (!trustedLocalRequest(req)) { const error = new Error('forbidden'); error.code = 403; throw error; }
  return cancelOAuthLogin(platform);
});
route('POST', '/api/oauth/:platform/logout', async (req, { platform }) => {
  if (!trustedLocalRequest(req)) { const error = new Error('forbidden'); error.code = 403; throw error; }
  return logoutOAuth(platform);
});
route('POST', '/api/oauth/:platform/import-dsh', async (req, { platform }) => {
  if (!trustedLocalRequest(req)) { const error = new Error('forbidden'); error.code = 403; throw error; }
  return importOAuthFromDsh(platform);
});

route('GET', '/api/providers', async () => store.listProviders().map(p => ({ ...p, api_key: p.source === 'oauth' ? 'OAuth' : mask(p.api_key) })));
route('POST', '/api/providers/import-dsh', async () => {
  const list = importFromDsh();
  const imported = [];
  for (const p of list) {
    const pid = store.upsertDshProvider(p);
    imported.push({ id: Number(pid), name: p.name, protocol: p.protocol, models: p.models.length });
  }
  // 若当前没有默认 provider，设第一个
  if (!store.listProviders().some(provider => provider.is_default) && imported.length) {
    const first = store.getProvider(imported[0].id);
    store.setDefaultProvider(imported[0].id, first.default_model || first.models && JSON.parse(first.models)[0]?.id);
  }
  return imported;
});
route('POST', '/api/providers', async (req, _p, body) => {
  for (const f of ['name', 'protocol', 'base_url', 'api_key']) if (!body[f]) throw new Error(`缺少字段 ${f}`);
  const models = Array.isArray(body.models) ? body.models : String(body.models || '').split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, name: id }));
  const id = store.addProvider({ ...body, models });
  return { id: Number(id.lastInsertRowid ?? id) };
});
route('DELETE', '/api/providers/:id', async (req, { id }) => {
  const provider = store.getProvider(Number(id));
  if (provider?.source === 'oauth') return logoutOAuth(provider.source_id);
  store.deleteProvider(Number(id));
  return { ok: true };
});
route('POST', '/api/providers/:id/default', async (req, { id }, body) => {
  store.setDefaultProvider(Number(id), body.model);
  return { ok: true };
});
route('POST', '/api/providers/:id/test', async (req, { id }, body) => {
  const p = store.getProvider(Number(id));
  if (!p) throw new Error('provider 不存在');
  const model = body.model || p.default_model;
  const t0 = Date.now();
  const text = await chat({ ...p, extra_headers: JSON.parse(p.extra_headers || '{}') }, model, [{ role: 'user', content: '用一句中文回答：1+1等于几？' }], { maxTokens: 2000 });
  return { ok: true, ms: Date.now() - t0, reply: text.slice(0, 200) };
});

function mask(k) { return k && k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : '***'; }

// ---------- 陪伴 agent（Companion Contract） ----------
const HANDLED = Symbol('handled'); // handler 自己接管了 res（SSE 流式）
const sseHead = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
const sseSend = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

// 云端私教的 SSE 流式变体：与 chatWithCompanion 同一事件协议
// （data:{content:截至目前全文} → data:{done,answer,model_label} / data:{error}）
async function chatWithTeacherSse(args, res) {
  sseHead(res);
  try {
    const r = await chatWithTeacher({ ...args, onText: t => sseSend(res, { content: t }) });
    sseSend(res, { done: true, answer: r.answer, model_label: r.model_label });
  } catch (e) {
    sseSend(res, { error: e.message });
  }
  res.end();
  return HANDLED;
}

// 把聊天转给陪伴 agent。不打私教 prompt——它以本色回答；
// 学习上下文走 model_content（它能看到，它那边界面里学生的原话保持干净）。
async function chatWithCompanion({ bookId, lessonId, message, selection }, res) {
  sseHead(res);
  const cname = companionConfig().name || '陪伴 agent';
  try {
    let ctx = '';
    let book = bookId ? store.getBook(bookId) : null;
    if (lessonId) {
      const lesson = store.getLesson(lessonId);
      if (lesson) {
        book = book || store.getBook(lesson.book_id);
        ctx = `学生正在「学不学」App 里读《${book?.title || '教材'}》的课节「${lesson.title}」${lesson.goal ? `（学习目标：${lesson.goal}）` : ''}。`;
        if (lesson.content) ctx += `\n本课讲义节选：\n${lesson.content.slice(0, 5000)}`;
      }
    } else if (book) {
      ctx = `学生正在「学不学」App 里读《${book.title}》，没有打开具体课节。`;
    }
    const modelContent =
      (ctx ? `【学习上下文 · 来自学不学，不用刻意提起来源】\n${ctx}\n\n` : '') +
      (selection ? `学生选中了原文：「${selection}」\n\n` : '') +
      `学生说：${message}`;
    const answer = await companionChat({ content: message, modelContent, onText: (t) => sseSend(res, { content: t }) });
    // 学不学本地同步留痕（陪伴 agent 那边通常也会自行落库）
    const label = `${cname} · 陪伴`;
    const session = store.currentChatSession(lessonId || null);
    store.addChat({ book_id: bookId || null, lesson_id: lessonId || null, role: 'user', content: message, session_id: session.id });
    store.addChat({ book_id: bookId || null, lesson_id: lessonId || null, role: 'assistant', content: answer, model_label: label, session_id: session.id });
    sseSend(res, { done: true, answer });
  } catch (e) {
    sseSend(res, { error: /fetch|ECONN|abort/i.test(e.message) ? `${cname}不在家——去看看它吧` : e.message });
  }
  res.end();
  return HANDLED;
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const query = Object.fromEntries(u.searchParams);
    if (u.pathname.startsWith('/api/')) {
      if (!localApiRequest(req)) return bad(res, 'forbidden', 403);
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers['content-type']?.includes('application/json') ? await readBody(req) : {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = u.pathname.match(r.rx);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
        const result = await r.handler(req, params, body, query, res);
        if (result !== HANDLED) return ok(res, result);
        return;
      }
      return bad(res, '接口不存在', 404);
    }
    // 静态
    let fp = path.normalize(path.join(PUBLIC_DIR, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!fp.startsWith(PUBLIC_DIR)) return bad(res, 'forbidden', 403);
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(fp);
    send(res, 200, fs.readFileSync(fp), {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',   // 每次协商重取，避免启发式缓存拿到旧前端
    });
  } catch (e) {
    const code = typeof e.code === 'number' && e.code >= 100 && e.code < 600 ? e.code : 500;
    bad(res, e.message || '服务器错误', code);
  }
});

await autoImportDshOAuth().then(() => reconcileOAuthProviders()).catch(error => console.error('[oauth] provider 对账跳过:', error.message));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`📚 LearnLoop 已启动: http://127.0.0.1:${PORT}`);
});
