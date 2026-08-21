// SQLite 数据层（node:sqlite，零原生依赖）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 允许宿主（如 Electron）指定数据目录；默认用项目内 data/
const DATA_DIR = process.env.LEARNLOOP_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'learnloop.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  extra_headers TEXT DEFAULT '{}',
  models TEXT DEFAULT '[]',
  source TEXT DEFAULT 'manual',
  source_id TEXT,
  is_default INTEGER DEFAULT 0,
  default_model TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  filename TEXT,
  format TEXT,
  status TEXT DEFAULT 'parsed',      -- parsed | outlining | outlined | failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  goal TEXT,
  source_hint TEXT,
  est_minutes INTEGER,
  status TEXT DEFAULT 'pending',     -- pending | generating | ready | failed
  gen_error TEXT,
  preguide TEXT,
  content TEXT,
  terms TEXT,                        -- JSON [{term, annotation}]
  quiz TEXT,                         -- JSON [{type, question, options, answer, explanation}]
  quiz_score REAL,
  study_status TEXT DEFAULT 'new',   -- new | studying | done
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS qa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  selection TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS wrong_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  qtype TEXT,
  options TEXT,
  correct_answer TEXT,
  user_answer TEXT,
  explanation TEXT,
  mastered INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL,              -- 1..6 艾宾浩斯轮次
  due_date TEXT NOT NULL,              -- YYYY-MM-DD
  done INTEGER DEFAULT 0,
  done_at TEXT,
  score REAL,
  UNIQUE(lesson_id, stage)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                  -- user | assistant
  content TEXT NOT NULL,
  model_label TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,  -- NULL=全局聊天流
  title TEXT,
  archived INTEGER DEFAULT 0,      -- 1=已收入复习卡片；软归档时仍可同时是 current
  is_current INTEGER DEFAULT 1,    -- 每条聊天流只有一个当前会话
  created_at TEXT DEFAULT (datetime('now','localtime')),
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS study_time (
  date TEXT PRIMARY KEY,           -- YYYY-MM-DD
  seconds INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  passage TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS weekly_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT UNIQUE,          -- 周一 YYYY-MM-DD
  content TEXT,
  model_label TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS focus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT DEFAULT 'focus',       -- focus | break
  seconds INTEGER NOT NULL,
  book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  completed INTEGER DEFAULT 1,     -- 1=完整番茄 0=手动提前结束
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// 迁移：chat_messages.book_id 改为可空（支持无教材的全局聊天）
try {
  const bi = db.prepare(`PRAGMA table_info(chat_messages)`).all().find(c => c.name === 'book_id');
  if (bi && bi.notnull) {
    db.exec(`
      BEGIN;
      CREATE TABLE chat_messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
        lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model_label TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO chat_messages_new SELECT * FROM chat_messages;
      DROP TABLE chat_messages;
      ALTER TABLE chat_messages_new RENAME TO chat_messages;
      COMMIT;
    `);
    console.log('[db] chat_messages 已迁移：book_id 可空');
  }
} catch (e) { console.error('[db] 迁移跳过:', e.message); }

// 迁移：chat_messages 增加 session_id；存量消息按流回填为已归档的「之前的讨论」
try {
  const cols = db.prepare(`PRAGMA table_info(chat_messages)`).all().map(c => c.name);
  if (!cols.includes('session_id')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN session_id INTEGER REFERENCES chat_sessions(id)`);
    console.log('[db] chat_messages 已迁移：+session_id');
  }
  const streams = db.prepare(`
    SELECT COALESCE(lesson_id, -1) AS stream FROM chat_messages
    WHERE session_id IS NULL GROUP BY stream`).all();
  for (const s of streams) {
    const lid = s.stream === -1 ? null : s.stream;
    const r = db.prepare(`INSERT INTO chat_sessions (lesson_id, title, archived, is_current, archived_at)
      VALUES (?, '之前的讨论', 1, 0, datetime('now','localtime'))`).run(lid);
    db.prepare(`UPDATE chat_messages SET session_id=? WHERE session_id IS NULL AND lesson_id IS ?`).run(r.lastInsertRowid, lid);
  }
  if (streams.length) console.log(`[db] 存量聊天已回填到 ${streams.length} 个归档会话`);
} catch (e) { console.error('[db] session 迁移跳过:', e.message); }

// 迁移：wrong_questions 增加重考追踪（次数 / 连对 / 最近重考时间）
try {
  const wcols = db.prepare(`PRAGMA table_info(wrong_questions)`).all().map(c => c.name);
  if (!wcols.includes('retake_count')) {
    db.exec(`ALTER TABLE wrong_questions ADD COLUMN retake_count INTEGER DEFAULT 0;
             ALTER TABLE wrong_questions ADD COLUMN streak INTEGER DEFAULT 0;
             ALTER TABLE wrong_questions ADD COLUMN last_retake_at TEXT;`);
    console.log('[db] wrong_questions 已迁移：+retake_count/streak/last_retake_at');
  }
} catch (e) { console.error('[db] wrong 迁移跳过:', e.message); }

// 迁移：chat_sessions 增加滚动小结（长会话滑动窗口：窗口外旧消息增量并入 summary，summary_upto=已小结到的最大消息 id）
try {
  const scols = db.prepare(`PRAGMA table_info(chat_sessions)`).all().map(c => c.name);
  if (!scols.includes('summary')) {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN summary TEXT;
             ALTER TABLE chat_sessions ADD COLUMN summary_upto INTEGER DEFAULT 0;`);
    console.log('[db] chat_sessions 已迁移：+summary/summary_upto');
  }
} catch (e) { console.error('[db] session summary 迁移跳过:', e.message); }

// 迁移：highlights 增加感想（note）；books 增加上次学习位置（last_lesson_id）
try {
  const hcols = db.prepare(`PRAGMA table_info(highlights)`).all().map(c => c.name);
  if (!hcols.includes('note')) {
    db.exec(`ALTER TABLE highlights ADD COLUMN note TEXT;`);
    console.log('[db] highlights 已迁移：+note');
  }
  const bcols = db.prepare(`PRAGMA table_info(books)`).all().map(c => c.name);
  if (!bcols.includes('last_lesson_id')) {
    db.exec(`ALTER TABLE books ADD COLUMN last_lesson_id INTEGER;`);
    console.log('[db] books 已迁移：+last_lesson_id');
  }
} catch (e) { console.error('[db] highlight/book 迁移跳过:', e.message); }

const stmts = {};
function prep(key, sql) { return stmts[key] || (stmts[key] = db.prepare(sql)); }

export const store = {
  // providers
  listProviders: () => prep('lp', 'SELECT * FROM providers ORDER BY id').all(),
  getProvider: (id) => prep('gp', 'SELECT * FROM providers WHERE id=?').get(id),
  defaultProvider: () => prep('dp', 'SELECT * FROM providers WHERE is_default=1').get() || prep('lp2', 'SELECT * FROM providers ORDER BY id LIMIT 1').get(),
  addProvider: (p) => prep('ap', `INSERT INTO providers (name,protocol,base_url,api_key,extra_headers,models,source,source_id,default_model)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    p.name, p.protocol, p.base_url, p.api_key,
    JSON.stringify(p.extra_headers || {}), JSON.stringify(p.models || []),
    p.source || 'manual', p.source_id || null, p.default_model || p.models?.[0]?.id || null),
  upsertDshProvider: (p) => {
    const exist = prep('gdp', 'SELECT id FROM providers WHERE source=? AND source_id=?').get('dsh', p.source_id);
    if (exist) {
      prep('udp', `UPDATE providers SET name=?,protocol=?,base_url=?,api_key=?,extra_headers=?,models=? WHERE id=?`).run(
        p.name, p.protocol, p.base_url, p.api_key, JSON.stringify(p.extra_headers || {}), JSON.stringify(p.models || []), exist.id);
      return exist.id;
    }
    return store.addProvider(p).lastInsertRowid;
  },
  getProviderBySource: (source, sourceId) => prep('gpbs', 'SELECT * FROM providers WHERE source=? AND source_id=?').get(source, sourceId),
  upsertOAuthProvider: (p) => {
    const exist = prep('gop', 'SELECT * FROM providers WHERE source=? AND source_id=?').get('oauth', p.source_id);
    const models = p.models || [];
    if (exist) {
      const selected = models.some(model => model.id === exist.default_model) ? exist.default_model : p.default_model || models[0]?.id || null;
      prep('uop', `UPDATE providers SET name=?,protocol=?,base_url=?,api_key=?,extra_headers=?,models=?,default_model=? WHERE id=?`).run(
        p.name, p.protocol, p.base_url, p.api_key, JSON.stringify(p.extra_headers || {}), JSON.stringify(models), selected, exist.id);
      return exist.id;
    }
    return store.addProvider({ ...p, source: 'oauth' }).lastInsertRowid;
  },
  deleteProviderBySource: (source, sourceId) => {
    const existing = prep('gpbs2', 'SELECT * FROM providers WHERE source=? AND source_id=?').get(source, sourceId);
    if (!existing) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      prep('delpbs', 'DELETE FROM providers WHERE source=? AND source_id=?').run(source, sourceId);
      if (existing.is_default) {
        const next = prep('nextp', 'SELECT id,default_model,models FROM providers ORDER BY id LIMIT 1').get();
        if (next) {
          let model = next.default_model;
          if (!model) {
            try { model = JSON.parse(next.models || '[]')[0]?.id || null; } catch { model = null; }
          }
          prep('nextdef', 'UPDATE providers SET is_default=1, default_model=? WHERE id=?').run(model, next.id);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
  deleteProvider: (id) => prep('delp', 'DELETE FROM providers WHERE id=?').run(id),
  setDefaultProvider: (id, model) => {
    prep('cdef', 'UPDATE providers SET is_default=0').run();
    prep('sdef', 'UPDATE providers SET is_default=1, default_model=? WHERE id=?').run(model, id);
  },
  setProviderModel: (id, model) => prep('spm', 'UPDATE providers SET default_model=? WHERE id=?').run(model, id),

  // books
  listBooks: () => prep('lb', `
    SELECT b.*,
      (SELECT COUNT(*) FROM lessons l WHERE l.book_id=b.id) AS lesson_count,
      (SELECT COUNT(*) FROM lessons l WHERE l.book_id=b.id AND l.study_status='done') AS done_count
    FROM books b ORDER BY b.id DESC`).all(),
  getBook: (id) => prep('gb', 'SELECT * FROM books WHERE id=?').get(id),
  addBook: (b) => prep('ab', 'INSERT INTO books (title,filename,format,status) VALUES (?,?,?,?)').run(b.title, b.filename, b.format, b.status || 'parsed'),
  setBookStatus: (id, status, error = null) => prep('sbs', 'UPDATE books SET status=?, error=? WHERE id=?').run(status, error, id),
  deleteBook: (id) => {
    prep('dqab', 'DELETE FROM qa WHERE book_id=?').run(id);
    prep('dwqb', 'DELETE FROM wrong_questions WHERE book_id=?').run(id);
    prep('dllb', 'DELETE FROM lessons WHERE book_id=?').run(id);
    prep('dmmb', 'DELETE FROM modules WHERE book_id=?').run(id);
    prep('dbb', 'DELETE FROM books WHERE id=?').run(id);
  },

  // outline
  addModule: (m) => prep('am', 'INSERT INTO modules (book_id,idx,title,summary) VALUES (?,?,?,?)').run(m.book_id, m.idx, m.title, m.summary),
  addLesson: (l) => prep('al', 'INSERT INTO lessons (module_id,book_id,idx,title,goal,source_hint,est_minutes) VALUES (?,?,?,?,?,?,?)')
    .run(l.module_id, l.book_id, l.idx, l.title, l.goal, l.source_hint, l.est_minutes),
  clearOutline: (bookId) => {
    prep('co1', 'DELETE FROM wrong_questions WHERE book_id=?').run(bookId);
    prep('co2', 'DELETE FROM lessons WHERE book_id=?').run(bookId);
    prep('co3', 'DELETE FROM modules WHERE book_id=?').run(bookId);
  },
  getOutline: (bookId) => {
    const mods = prep('gm', 'SELECT * FROM modules WHERE book_id=? ORDER BY idx').all(bookId);
    for (const m of mods) m.lessons = prep('gl', 'SELECT id,idx,title,goal,est_minutes,status,study_status,quiz_score FROM lessons WHERE module_id=? ORDER BY idx').all(m.id);
    return mods;
  },

  // lessons
  getLesson: (id) => prep('gle', 'SELECT * FROM lessons WHERE id=?').get(id),
  setLessonGen: (id, status, fields = {}) => {
    prep('slg', `UPDATE lessons SET status=?, gen_error=?, preguide=?, content=?, terms=?, quiz=?, updated_at=datetime('now','localtime') WHERE id=?`)
      .run(status, fields.gen_error || null, fields.preguide || null, fields.content || null,
        fields.terms ? JSON.stringify(fields.terms) : null, fields.quiz ? JSON.stringify(fields.quiz) : null, id);
  },
  setLessonStudy: (id, st, score = null) => prep('sls', 'UPDATE lessons SET study_status=?, quiz_score=COALESCE(?,quiz_score) WHERE id=?').run(st, score, id),
  nextLesson: (bookId, lessonId) => prep('nl', 'SELECT * FROM lessons WHERE book_id=? AND id>? ORDER BY id LIMIT 1').get(bookId, lessonId),
  bookTerms: (bookId) => prep('bt', `SELECT l.id AS lesson_id, l.title AS lesson_title, l.terms FROM lessons l
    WHERE l.book_id=? AND l.terms IS NOT NULL ORDER BY l.id`).all(bookId),

  // qa
  addQa: (q) => prep('aq', 'INSERT INTO qa (book_id,lesson_id,selection,question,answer) VALUES (?,?,?,?,?)').run(q.book_id, q.lesson_id, q.selection, q.question, q.answer),
  listQa: (bookId) => prep('lq', 'SELECT * FROM qa WHERE book_id=? ORDER BY id DESC').all(bookId),

  // wrong questions
  addWrong: (w) => prep('aw', `INSERT INTO wrong_questions (book_id,lesson_id,question,qtype,options,correct_answer,user_answer,explanation)
    VALUES (?,?,?,?,?,?,?,?)`).run(w.book_id, w.lesson_id, w.question, w.qtype, w.options, w.correct_answer, w.user_answer, w.explanation),
  listWrong: (bookId) => bookId
    ? prep('lwb', `SELECT w.*, l.title AS lesson_title, b.title AS book_title FROM wrong_questions w
        LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
        WHERE w.book_id=? ORDER BY w.id DESC`).all(bookId)
    : prep('lwa', `SELECT w.*, l.title AS lesson_title, b.title AS book_title FROM wrong_questions w
        LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
        ORDER BY w.id DESC`).all(),
  setWrongMastered: (id, mastered) => prep('swm', 'UPDATE wrong_questions SET mastered=? WHERE id=?').run(mastered ? 1 : 0, id),

  // 错题重考
  retakePool: (bookId, limit = 10) => bookId
    ? prep('rpb', `SELECT w.*, l.title AS lesson_title, b.title AS book_title FROM wrong_questions w
        LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
        WHERE w.mastered=0 AND w.book_id=? ORDER BY w.streak ASC, w.id DESC LIMIT ?`).all(bookId, limit)
    : prep('rpa', `SELECT w.*, l.title AS lesson_title, b.title AS book_title FROM wrong_questions w
        LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
        WHERE w.mastered=0 ORDER BY w.streak ASC, w.id DESC LIMIT ?`).all(limit),
  getWrong: (id) => prep('gw', 'SELECT * FROM wrong_questions WHERE id=?').get(id),
  recordRetake: (id, correct) => {
    const w = store.getWrong(id);
    if (!w) return null;
    const streak = correct ? (w.streak || 0) + 1 : 0;
    const mastered = streak >= 2 ? 1 : (correct ? w.mastered : 0);
    prep('rr', `UPDATE wrong_questions SET retake_count=retake_count+1, streak=?, mastered=?,
      last_retake_at=datetime('now','localtime') WHERE id=?`).run(streak, mastered, id);
    return { streak, mastered };
  },

  // 番茄钟
  addFocusSession: (f) => prep('afs', 'INSERT INTO focus_sessions (kind,seconds,book_id,lesson_id,completed) VALUES (?,?,?,?,?)')
    .run(f.kind || 'focus', Math.round(f.seconds), f.book_id || null, f.lesson_id || null, f.completed ? 1 : 0),
  focusStats: () => ({
    todaySeconds: prep('fts', `SELECT COALESCE(SUM(seconds),0) AS s FROM focus_sessions WHERE kind='focus' AND date(created_at)=date('now','localtime')`).get().s,
    todayCount: prep('ftc', `SELECT COUNT(*) AS n FROM focus_sessions WHERE kind='focus' AND completed=1 AND date(created_at)=date('now','localtime')`).get().n,
    totalCount: prep('ftt', `SELECT COUNT(*) AS n FROM focus_sessions WHERE kind='focus' AND completed=1`).get().n,
    totalSeconds: prep('ftts', `SELECT COALESCE(SUM(seconds),0) AS s FROM focus_sessions WHERE kind='focus'`).get().s,
  }),

  // reviews（艾宾浩斯）
  createReviewSchedule: (bookId, lessonId, dates) => {
    for (let i = 0; i < dates.length; i++) {
      prep('crs', 'INSERT OR IGNORE INTO reviews (book_id,lesson_id,stage,due_date) VALUES (?,?,?,?)').run(bookId, lessonId, i + 1, dates[i]);
    }
  },
  hasReviewSchedule: (lessonId) => !!prep('hrs', 'SELECT 1 FROM reviews WHERE lesson_id=? LIMIT 1').get(lessonId),
  dueReviews: () => prep('dr', `SELECT r.*, l.title AS lesson_title, l.idx AS lesson_idx, b.title AS book_title
    FROM reviews r JOIN lessons l ON l.id=r.lesson_id JOIN books b ON b.id=r.book_id
    WHERE r.done=0 AND r.due_date <= date('now','localtime') ORDER BY r.due_date, r.id`).all(),
  upcomingReviews: () => prep('ur', `SELECT r.*, l.title AS lesson_title, b.title AS book_title
    FROM reviews r JOIN lessons l ON l.id=r.lesson_id JOIN books b ON b.id=r.book_id
    WHERE r.done=0 AND r.due_date > date('now','localtime') ORDER BY r.due_date LIMIT 30`).all(),
  dueReviewCount: () => prep('drc', `SELECT COUNT(*) AS n FROM reviews WHERE done=0 AND due_date <= date('now','localtime')`).get().n,
  getReview: (id) => prep('gr', `SELECT r.*, l.title AS lesson_title, b.title AS book_title
    FROM reviews r JOIN lessons l ON l.id=r.lesson_id JOIN books b ON b.id=r.book_id WHERE r.id=?`).get(id),
  completeReview: (id, score) => prep('cr', `UPDATE reviews SET done=1, done_at=datetime('now','localtime'), score=? WHERE id=?`).run(score, id),

  // chat
  addChat: (m) => prep('ac', 'INSERT INTO chat_messages (book_id,lesson_id,role,content,model_label,session_id) VALUES (?,?,?,?,?,?)').run(m.book_id, m.lesson_id, m.role, m.content, m.model_label || null, m.session_id || null),
  listChat: (lessonId, limit = 100) => prep('lc', 'SELECT * FROM chat_messages WHERE lesson_id=? ORDER BY id DESC LIMIT ?').all(lessonId, limit).reverse(),
  listGlobalChat: (limit = 100) => prep('lgc', 'SELECT * FROM chat_messages WHERE lesson_id IS NULL ORDER BY id DESC LIMIT ?').all(limit).reverse(),

  // chat sessions（每条流=lesson_id 或 NULL 全局，有且只有一个 is_current=1）
  currentChatSession: (lessonId) => {
    const exist = prep('ccs', 'SELECT * FROM chat_sessions WHERE lesson_id IS ? AND is_current=1').get(lessonId ?? null);
    if (exist) return exist;
    const r = prep('ics', 'INSERT INTO chat_sessions (lesson_id) VALUES (?)').run(lessonId ?? null);
    return prep('gcs', 'SELECT * FROM chat_sessions WHERE id=?').get(r.lastInsertRowid);
  },
  newChatSession: (lessonId) => {
    prep('ncs1', 'UPDATE chat_sessions SET is_current=0 WHERE lesson_id IS ?').run(lessonId ?? null);
    const r = prep('ics2', 'INSERT INTO chat_sessions (lesson_id) VALUES (?)').run(lessonId ?? null);
    return prep('gcs2', 'SELECT * FROM chat_sessions WHERE id=?').get(r.lastInsertRowid);
  },
  checkpointChatSession: (sessionId, title) => {
    // 退出/隐藏时的软归档：让同一张卡片可见，但仍保持 current，冷启动继续往同一 session 追加。
    prep('cps', `UPDATE chat_sessions SET
      archived=1,
      title=CASE WHEN title IS NULL OR title IN ('之前的讨论','未命名讨论') THEN ? ELSE title END,
      archived_at=datetime('now','localtime')
      WHERE id=? AND is_current=1`).run(title, sessionId);
    return prep('gcps', 'SELECT * FROM chat_sessions WHERE id=?').get(sessionId);
  },
  archiveChatSession: (lessonId, title) => {
    const cur = store.currentChatSession(lessonId);
    // 硬归档 = 封存并退役当前会话，同时自动开一个新会话接班。
    // 若它此前已被退出软归档，这里只更新原卡片，不会另建归档记录。
    prep('acs', `UPDATE chat_sessions SET archived=1, title=?, archived_at=datetime('now','localtime'), is_current=0 WHERE id=?`).run(title, cur.id);
    prep('acs2', 'INSERT INTO chat_sessions (lesson_id) VALUES (?)').run(lessonId ?? null);
    return prep('gcs3', 'SELECT * FROM chat_sessions WHERE id=?').get(cur.id);
  },
  lastResumableChatSession: () => prep('lrcs', `
    SELECT s.*, l.title AS lesson_title, b.id AS book_id,
      COALESCE(b.last_lesson_id, s.lesson_id) AS resume_lesson_id,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id) AS msg_count,
      (SELECT MAX(m.id) FROM chat_messages m WHERE m.session_id=s.id) AS last_msg_id
    FROM chat_sessions s
    LEFT JOIN lessons l ON l.id=s.lesson_id
    LEFT JOIN books b ON b.id=COALESCE(l.book_id,
      (SELECT m.book_id FROM chat_messages m WHERE m.session_id=s.id AND m.book_id IS NOT NULL ORDER BY m.id DESC LIMIT 1))
    WHERE s.is_current=1 AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id=s.id)
    ORDER BY last_msg_id DESC LIMIT 1`).get(),
  listSessionMessages: (sessionId, limit = 200) => prep('lsm', 'SELECT * FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?').all(sessionId, limit).reverse(),
  // 滚动小结：取 (afterId, beforeId) 开区间内、尚未入小结的旧消息；写回小结
  sessionMessagesBetween: (sessionId, afterId, beforeId) => prep('smb', 'SELECT * FROM chat_messages WHERE session_id=? AND id>? AND id<? ORDER BY id ASC').all(sessionId, afterId, beforeId),
  setSessionSummary: (sessionId, summary, upto) => prep('sss2', 'UPDATE chat_sessions SET summary=?, summary_upto=? WHERE id=?').run(summary, upto, sessionId),
  listArchivedSessions: () => prep('las', `
    SELECT s.*, l.title AS lesson_title, b.title AS book_title,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id) AS msg_count,
      (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.session_id=s.id) AS last_at
    FROM chat_sessions s
    LEFT JOIN lessons l ON l.id=s.lesson_id
    LEFT JOIN books b ON b.id=l.book_id
    WHERE s.archived=1 ORDER BY COALESCE(s.archived_at, s.created_at) DESC`).all(),
  getChatSession: (id) => prep('gcs4', `
    SELECT s.*, l.title AS lesson_title, b.title AS book_title
    FROM chat_sessions s
    LEFT JOIN lessons l ON l.id=s.lesson_id
    LEFT JOIN books b ON b.id=l.book_id WHERE s.id=?`).get(id),
  sessionMsgCount: (sessionId) => prep('smc', 'SELECT COUNT(*) AS n FROM chat_messages WHERE session_id=?').get(sessionId).n,

  // 学习时长
  addStudyTime: (secs) => prep('ast', `INSERT INTO study_time (date, seconds) VALUES (date('now','localtime'), ?)
    ON CONFLICT(date) DO UPDATE SET seconds = seconds + excluded.seconds`).run(Math.round(secs)),
  timeByDay: (days = 42) => prep('tbd', `SELECT date, seconds FROM study_time WHERE date >= date('now','localtime', ?) ORDER BY date`).all(`-${days} days`),
  raw: (sql, ...args) => db.prepare(sql).all(...args),
  rawGet: (sql, ...args) => db.prepare(sql).get(...args),

  // 划线
  addHighlight: (h) => prep('ah', 'INSERT INTO highlights (book_id,lesson_id,text,passage,note) VALUES (?,?,?,?,?)').run(h.book_id, h.lesson_id, h.text, h.passage || null, h.note || null),
  updateHighlightNote: (id, note) => prep('uhn', 'UPDATE highlights SET note=? WHERE id=?').run(note || null, id),
  // 学习位置只前进不回退：回看旧课不应把「继续学习」指针往回拨（同书课节 id 按大纲顺序递增）
  setLastLesson: (bookId, lessonId) => prep('sll', 'UPDATE books SET last_lesson_id=? WHERE id=? AND (last_lesson_id IS NULL OR last_lesson_id<?)').run(lessonId, bookId, lessonId),
  listHighlights: (bookId) => bookId
    ? prep('lhb', `SELECT h.*, l.title AS lesson_title, b.title AS book_title FROM highlights h
        LEFT JOIN lessons l ON l.id=h.lesson_id LEFT JOIN books b ON b.id=h.book_id
        WHERE h.book_id=? ORDER BY h.id DESC`).all(bookId)
    : prep('lha', `SELECT h.*, l.title AS lesson_title, b.title AS book_title FROM highlights h
        LEFT JOIN lessons l ON l.id=h.lesson_id LEFT JOIN books b ON b.id=h.book_id
        ORDER BY h.id DESC`).all(),
  deleteHighlight: (id) => prep('dh', 'DELETE FROM highlights WHERE id=?').run(id),

  // 周报
  saveWeeklyReport: (r) => prep('swr', `INSERT INTO weekly_reports (week_start, content, model_label)
    VALUES (?,?,?) ON CONFLICT(week_start) DO UPDATE SET content=excluded.content, model_label=excluded.model_label, created_at=datetime('now','localtime')`)
    .run(r.week_start, r.content, r.model_label || null),
  getWeeklyReport: (weekStart) => prep('gwr', 'SELECT * FROM weekly_reports WHERE week_start=?').get(weekStart),
  listWeeklyReports: () => prep('lwr', 'SELECT * FROM weekly_reports ORDER BY week_start DESC').all(),

  // settings
  getSetting: (key) => prep('gs', 'SELECT value FROM settings WHERE key=?').get(key)?.value,
  setSetting: (key, value) => prep('ss', 'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)),
};

// ---------- 备份 / 恢复 ----------
const BACKUP_TABLES = ['providers', 'books', 'modules', 'lessons', 'qa', 'wrong_questions',
  'reviews', 'chat_sessions', 'chat_messages', 'settings', 'study_time', 'highlights',
  'weekly_reports', 'focus_sessions'];

export function dumpAll() {
  const tables = {};
  for (const t of BACKUP_TABLES) {
    // OAuth provider 只是本机令牌的外壳；不带令牌备份它会造成“已授权”假象。
    tables[t] = t === 'providers'
      ? db.prepare(`SELECT * FROM providers WHERE source!='oauth'`).all()
      : db.prepare(`SELECT * FROM ${t}`).all();
  }
  return { app: 'learnloop', version: 2, exported_at: new Date().toISOString(), tables };
}

export function restoreAll(payload) {
  const tables = payload?.tables;
  if (!tables || typeof tables !== 'object') throw new Error('备份文件格式不对');
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN');
    for (const t of BACKUP_TABLES) {
      const rows = tables[t];
      if (!Array.isArray(rows)) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      db.prepare(`DELETE FROM ${t}`).run();
      for (const row of rows) {
        const keys = Object.keys(row).filter(k => cols.includes(k));
        if (!keys.length) continue;
        db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
          .run(...keys.map(k => row[k]));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
  return { restored: BACKUP_TABLES.filter(t => Array.isArray(tables[t])).length };
}

export const TEXTS_DIR = path.join(DATA_DIR, 'texts');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(TEXTS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
