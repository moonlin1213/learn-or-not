// 课程生成管线：大纲 → 课节（引导/讲义/术语/测验）→ 批改 → 答疑
import fs from 'node:fs';
import path from 'node:path';
import { store, TEXTS_DIR } from './db.js';
import { chat, chatStream, extractJson } from './llm.js';

const MAX_OUTLINE_CHARS = 48000;   // 大纲单次送入上限
const MAP_CHUNK_CHARS = 20000;     // 超长文本 map 阶段块大小
const LESSON_SOURCE_CHARS = 14000; // 课节原文上限

function getText(bookId) {
  return fs.readFileSync(path.join(TEXTS_DIR, `${bookId}.txt`), 'utf8');
}

function activeProvider() {
  const p = store.defaultProvider();
  if (!p) throw new Error('还没有配置模型：去「设置 → 手动添加 provider」接入任意模型服务即可开始');
  return { ...p, extra_headers: JSON.parse(p.extra_headers || '{}'), models: JSON.parse(p.models || '[]') };
}

function sys(s) { return { role: 'system', content: s }; }
function usr(s) { return { role: 'user', content: s }; }

const JSON_RULE = '\n\n【输出要求】只输出 JSON（不要 markdown 围栏、不要任何额外文字），确保 JSON 合法可被 JSON.parse。所有文本内容都不要使用 emoji 表情符号。';

// ---------- 大纲 ----------

export async function generateOutline(bookId, onLog = () => {}) {
  const book = store.getBook(bookId);
  if (!book) throw new Error('书籍不存在');
  const text = getText(bookId);
  const p = activeProvider();
  store.setBookStatus(bookId, 'outlining');

  let sourceForOutline = text;
  if (text.length > MAX_OUTLINE_CHARS) {
    onLog(`教材较长（${Math.round(text.length / 1000)}k 字），先做分段摘要…`);
    const summaries = [];
    const chunks = chunkText(text, MAP_CHUNK_CHARS);
    for (let i = 0; i < chunks.length; i++) {
      onLog(`摘要 ${i + 1}/${chunks.length}…`);
      const s = await chat(p, p.default_model, [
        sys('你是教材分析助手。把给出的教材片段浓缩成结构化摘要，保留：章节标题层级、核心概念、知识点列表。用中文，控制在 600 字内。'),
        usr(`【教材片段 ${i + 1}/${chunks.length}】\n${chunks[i]}`),
      ], { maxTokens: 4000 });
      summaries.push(`【片段 ${i + 1}】\n${s}`);
    }
    sourceForOutline = summaries.join('\n\n');
  }

  onLog('生成课程大纲…');
  const out = await chat(p, p.default_model, [
    sys(`你是一位资深课程设计师。根据教材内容，设计一套循序渐进的系统课程。要求：
1. 课程拆成 3-8 个模块（module），每个模块 2-6 节课（lesson）；
2. 顺序符合学习规律：先基础后进阶，概念先行；
3. 每节课给出：title（课名）、goal（一句话学习目标）、source_hint（该课对应教材中的原文关键词/章节名，用于定位原文，尽量抄教材原文标题）、est_minutes（预计学习分钟数，15-60）；
4. 每个模块给出 title 和 summary（模块简介，2-3 句）。` + JSON_RULE),
    usr(`教材标题：${book.title}\n\n教材内容${text.length > MAX_OUTLINE_CHARS ? '（分段摘要）' : ''}：\n${sourceForOutline}\n\n输出 JSON 格式：{"modules":[{"title":"","summary":"","lessons":[{"title":"","goal":"","source_hint":"","est_minutes":30}]}]}`),
  ], { maxTokens: 16000 });

  const outline = extractJson(out);
  if (!Array.isArray(outline.modules) || !outline.modules.length) throw new Error('大纲为空');

  // 清旧大纲
  store.clearOutline(bookId);
  let li = 0;
  for (let mi = 0; mi < outline.modules.length; mi++) {
    const m = outline.modules[mi];
    const moduleId = store.addModule({ book_id: bookId, idx: mi, title: String(m.title || `模块 ${mi + 1}`), summary: String(m.summary || '') }).lastInsertRowid;
    for (const l of (m.lessons || [])) {
      store.addLesson({
        module_id: moduleId, book_id: bookId, idx: li++,
        title: String(l.title || `第 ${li} 课`), goal: String(l.goal || ''),
        source_hint: String(l.source_hint || ''), est_minutes: Number(l.est_minutes) || 30,
      });
    }
  }
  store.setBookStatus(bookId, 'outlined');
  onLog(`大纲完成：${outline.modules.length} 个模块，${li} 节课`);
  return store.getOutline(bookId);
}

// ---------- 课节 ----------

export async function generateLesson(lessonId, onLog = () => {}) {
  const lesson = store.getLesson(lessonId);
  if (!lesson) throw new Error('课节不存在');
  const book = store.getBook(lesson.book_id);
  const text = getText(lesson.book_id);
  const p = activeProvider();

  store.setLessonGen(lessonId, 'generating');
  try {
    const excerpt = locateSource(text, lesson);
    onLog('AI 备课中（引导 + 讲义 + 术语 + 测验题）…');
    // 推理模型会先吃掉大量思考 token：给足输出预算，并允许解析失败时重试一次
    let data = null, lastErr = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      try {
        const out = await chat(p, p.default_model, [
          sys(`你是一位耐心细致的私教老师，正在为学生备一节课。根据教材原文，输出这节课的完整教学材料：

1. preguide（课前引导，markdown）：用 2-4 段话讲清楚——这节课要学什么、为什么重要、和前面知识的衔接、带着哪几个问题去读正文。语气亲切，像老师课前聊天。学生只有一个人，称呼用「宝宝」（如「宝宝好」「宝宝还记得吗」），绝对不要出现「同学们」「大家」「各位」这类课堂称呼。
2. content（精读讲义，markdown）：基于教材原文重写的系统讲义。要求：结构清晰（用小标题）、完整覆盖原文知识点、晦涩处展开讲解、适当举例。公式一律用 $...$ 或 $$...$$ 的 LaTeX 写法。专有名词第一次出现时加粗。长度 800-2500 字。
3. terms（专有名词表）：挑出这节课 5-12 个关键术语/专有名词，每个给出 annotation（通俗注释，1-3 句，必要时类比）。
4. quiz（课后复习题）：出 5 题，检验这节课的核心掌握。3 道选择题（choice，options 4 个，answer 填正确选项字母如 "B"）+ 2 道简答题（short，answer 填参考答案要点）。每题附 explanation（解析，说明为什么）。
【篇幅纪律】讲义不超过 2500 字，注释与解析从简，必须完整输出全部四个字段。` + JSON_RULE),
          usr(`教材：《${book.title}》
本课：${lesson.title}
学习目标：${lesson.goal || '（无）'}

【教材原文（本课相关部分）】
${excerpt}

输出 JSON 格式：
{"preguide":"markdown...","content":"markdown...","terms":[{"term":"","annotation":""}],"quiz":[{"type":"choice","question":"","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"B","explanation":""},{"type":"short","question":"","answer":"","explanation":""}]}`),
        ], { maxTokens: 65536 });
        data = extractJson(out);
      } catch (e) {
        lastErr = e;
        if (attempt === 0) onLog('输出解析失败，让 AI 重写一遍…');
      }
    }
    if (!data) throw lastErr || new Error('生成失败');
    if (!data.content) throw new Error('生成的讲义为空');
    store.setLessonGen(lessonId, 'ready', {
      preguide: String(data.preguide || ''),
      content: String(data.content),
      terms: Array.isArray(data.terms) ? data.terms : [],
      quiz: Array.isArray(data.quiz) ? data.quiz : [],
    });
    if (lesson.study_status === 'new') store.setLessonStudy(lessonId, 'studying');
    return store.getLesson(lessonId);
  } catch (e) {
    store.setLessonGen(lessonId, 'failed', { gen_error: e.message });
    throw e;
  }
}

// 根据 source_hint 在原文中定位相关片段
export function locateSource(text, lesson) {
  const hints = [lesson.source_hint, lesson.title]
    .filter(Boolean)
    .flatMap(h => h.split(/[,，、;；\s]+/))
    .map(s => s.trim())
    .filter(s => s.length >= 2);
  let bestPos = -1;
  for (const h of hints) {
    const pos = text.indexOf(h);
    if (pos >= 0 && (bestPos < 0 || pos < bestPos)) bestPos = pos;
  }
  if (bestPos < 0) {
    // 找不到就按课节序号大致均分
    const mods = store.getOutline(lesson.book_id);
    const all = mods.flatMap(m => m.lessons);
    const ratio = all.length > 1 ? lesson.idx / (all.length - 1) : 0;
    bestPos = Math.floor(ratio * Math.max(0, text.length - LESSON_SOURCE_CHARS));
  }
  const start = Math.max(0, bestPos - 1500);
  return text.slice(start, start + LESSON_SOURCE_CHARS);
}

// ---------- 批改 ----------

export async function gradeQuiz(lessonId, answers) {
  const lesson = store.getLesson(lessonId);
  if (!lesson || !lesson.quiz) throw new Error('课节或题目不存在');
  const quiz = JSON.parse(lesson.quiz);
  const p = activeProvider();
  const results = [];
  let scoreSum = 0;

  for (let i = 0; i < quiz.length; i++) {
    const q = quiz[i];
    const ua = (answers[i] ?? '').toString().trim();
    let correct = false, score = 0, feedback = q.explanation || '', ungraded = false;
    if (q.type === 'choice') {
      correct = ua.toUpperCase() === String(q.answer).trim().toUpperCase();
      score = correct ? 1 : 0;
    } else {
      const out = await chat(p, p.default_model, [
        sys('你是严格的阅卷老师。判断学生简答题回答是否掌握了要点。' + JSON_RULE),
        usr(`题目：${q.question}\n参考答案要点：${q.answer}\n学生回答：${ua || '（未作答）'}\n\n输出 JSON：{"correct":true或false,"score":0到1的小数,"feedback":"一句话评语"}`),
      ], { maxTokens: 2000 });
      try {
        const j = extractJson(out);
        correct = !!j.correct;
        score = Math.max(0, Math.min(1, Number(j.score) || (j.correct ? 1 : 0)));
        feedback = j.feedback ? `${j.feedback}\n\n解析：${q.explanation || ''}` : feedback;
      } catch {
        // AI 返回无法解析：标记未批改，不记错题、不计分，不能静默当成答错
        ungraded = true;
        feedback = '这道题这次没有批改成功（AI 返回无法解析），未计分、未记入错题本。\n\n解析：' + (q.explanation || '');
      }
    }
    if (!ungraded) scoreSum += score;
    results.push({ index: i, type: q.type, question: q.question, options: q.options, correct_answer: q.answer, user_answer: ua, correct, score, feedback, ungraded: ungraded || undefined });
    if (!correct && !ungraded) {
      store.addWrong({
        book_id: lesson.book_id, lesson_id: lessonId, question: q.question, qtype: q.type,
        options: q.options ? JSON.stringify(q.options) : null,
        correct_answer: String(q.answer), user_answer: ua, explanation: q.explanation || feedback,
      });
    }
  }
  const gradedCount = quiz.length - results.filter(r => r.ungraded).length;
  if (!gradedCount) throw new Error('简答题批改暂时失败（AI 返回无法解析），请稍后重试交卷');
  const total = Math.round((scoreSum / gradedCount) * 100);
  store.setLessonStudy(lessonId, 'done', total);
  // 交卷即推进到下一课；冷启动恢复课程进度时不会停在已经完成的本课。
  const nextLesson = store.nextLesson(lesson.book_id, lessonId);
  store.setLastLesson(lesson.book_id, nextLesson?.id || lessonId);

  // 首次完成：创建艾宾浩斯复习排期（+1/2/4/7/15/30 天）
  if (!store.hasReviewSchedule(lessonId)) {
    const dates = EBINGHAUS_DAYS.map(d => {
      const dt = new Date(Date.now() + d * 86400000);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    });
    store.createReviewSchedule(lesson.book_id, lessonId, dates);
  }
  return { total, results };
}

const EBINGHAUS_DAYS = [1, 2, 4, 7, 15, 30];

// ---------- 错题重考 ----------

export async function gradeRetake(items) {
  // items: [{id, answer}]
  const rows = [];
  for (const it of items) {
    const w = store.getWrong(Number(it.id));
    if (w) rows.push({ w, ua: String(it.answer ?? '').trim() });
  }
  if (!rows.length) throw new Error('没有可批改的重考题');

  // 选择题本地判，简答题攒起来一次 LLM 调用
  const shortIdx = [];
  const graded = rows.map((r, i) => {
    if (r.w.qtype === 'choice') {
      const correct = r.ua.toUpperCase() === String(r.w.correct_answer).trim().toUpperCase();
      return { i, correct, score: correct ? 1 : 0, feedback: r.w.explanation || '' };
    }
    shortIdx.push(i);
    return null;
  });

  if (shortIdx.length) {
    const p = activeProvider();
    const payload = shortIdx.map((gi, k) => {
      const r = rows[gi];
      return `【第 ${k + 1} 题】\n题目：${r.w.question}\n参考答案要点：${r.w.correct_answer}\n学生回答：${r.ua || '（未作答）'}`;
    }).join('\n\n');
    try {
      const out = await chat(p, p.default_model, [
        sys('你是严格的阅卷老师。逐题判断学生简答题回答是否掌握了要点。' + JSON_RULE),
        usr(`${payload}\n\n输出 JSON：{"grades":[{"q":1,"correct":true或false,"score":0到1的小数,"feedback":"一句话评语"}]}，共 ${shortIdx.length} 条，q 为题号。`),
      ], { maxTokens: 4000 });
      const j = extractJson(out);
      const grades = Array.isArray(j.grades) ? j.grades : [];
      for (const g of grades) {
        const gi = shortIdx[Number(g.q) - 1];
        if (gi === undefined) continue;
        const r = rows[gi];
        graded[gi] = {
          i: gi, correct: !!g.correct,
          score: Math.max(0, Math.min(1, Number(g.score) || (g.correct ? 1 : 0))),
          feedback: (g.feedback ? `${g.feedback}\n\n解析：` : '解析：') + (r.w.explanation || ''),
        };
      }
    } catch { /* 批改失败走兜底 */ }
    for (const gi of shortIdx) {
      if (!graded[gi]) graded[gi] = { i: gi, ungraded: true, feedback: '这次没批改成功，本题未计分、连对进度保持不变，可以再试一次。\n\n解析：' + (rows[gi].w.explanation || '') };
    }
  }

  // 落库：连对 streak，连对 2 次自动掌握；答错清零并回到未掌握。未批改的题不动库、保持原进度
  const results = rows.map((r, i) => {
    const g = graded[i];
    const upd = g.ungraded ? null : store.recordRetake(r.w.id, g.correct);
    return {
      id: r.w.id, question: r.w.question, qtype: r.w.qtype,
      options: r.w.options ? JSON.parse(r.w.options) : null,
      correct_answer: r.w.correct_answer, user_answer: r.ua,
      correct: !g.ungraded && g.correct, ungraded: g.ungraded || undefined, feedback: g.feedback,
      streak: upd?.streak ?? r.w.streak ?? 0, mastered: upd?.mastered ?? r.w.mastered ?? 0,
    };
  });
  const gradedResults = results.filter(r => !r.ungraded);
  return { total: gradedResults.filter(r => r.correct).length, count: gradedResults.length, results };
}

// ---------- 答疑 ----------

export async function askQuestion({ bookId, lessonId, selection, question }) {
  const book = store.getBook(bookId);
  if (!book) throw new Error('书籍不存在');
  const p = activeProvider();
  let context = '';
  if (lessonId) {
    const lesson = store.getLesson(lessonId);
    if (lesson) {
      const text = getText(bookId);
      context = `当前课程：${lesson.title}\n\n相关教材原文：\n${locateSource(text, lesson).slice(0, 8000)}`;
    }
  }
  if (!context) {
    const text = getText(bookId);
    const pos = selection ? text.indexOf(selection.slice(0, 40)) : -1;
    context = pos >= 0
      ? `教材原文（选段附近）：\n${text.slice(Math.max(0, pos - 2000), pos + 4000)}`
      : `教材内容摘要：\n${text.slice(0, 6000)}`;
  }

  const answer = await chat(p, p.default_model, [
    sys(`你是一位耐心的私教老师，学生正在读教材，遇到不懂的地方向你提问。
要求：用通俗的话解释，先一句话直接回答，再展开；必要时结合教材上下文举例；如果问题超出教材范围，简要回答后说明「这部分教材没展开」。`),
    usr(`教材：《${book.title}》
${context}

${selection ? `学生选中的原文：「${selection}」\n\n` : ''}学生的问题：${question}`),
  ], { maxTokens: 8000 });

  store.addQa({ book_id: bookId, lesson_id: lessonId || null, selection: selection || '', question, answer });
  return answer;
}

// ---------- 侧边栏聊天（AI 老师） ----------

// 导师模式：附加在私教 system prompt 之后的风格指令（单轮无状态设计下只是换提示词）
const TUTOR_MODES = {
  socratic: '当前是「苏格拉底模式」：不要直接给出答案，用由浅入深的引导式反问帮宝宝自己想明白；每次最多问一两个问题，宝宝答对方向后及时肯定并继续推进；连续两次卡住可以给关键提示，但最后一步仍留给宝宝自己走。',
  feynman: '当前是「费曼模式」：宝宝来当小老师给你讲解，你负责挑错与补漏。认真听宝宝的表述，先肯定讲对的部分，再指出不准确或含糊之处，用更简单的方式补讲一遍，最后出一道小检验题确认宝宝真的懂了。',
  examiner: '当前是「考官模式」：你是严格的考官，围绕当前教材内容连环出题拷问宝宝。一次只出一题（选择或简答均可），宝宝作答后再判定并讲评，然后出下一题；难度循序渐进，发现薄弱点就多追问几轮。',
};

export async function chatWithTeacher({ bookId, lessonId, message, selection, providerId, model, mode, onText }) {
  const book = bookId ? store.getBook(bookId) : null;
  let p = activeProvider();
  if (providerId) {
    const row = store.getProvider(Number(providerId));
    if (row) p = { ...row, extra_headers: JSON.parse(row.extra_headers || '{}'), models: JSON.parse(row.models || '[]') };
  }
  const useModel = model || p.default_model;

  let context = '';
  if (lessonId) {
    const lesson = store.getLesson(lessonId);
    if (lesson) {
      context = `当前课程：《${lesson.title}》${lesson.goal ? `（学习目标：${lesson.goal}）` : ''}`;
      if (lesson.content) context += `\n\n本课讲义：\n${lesson.content.slice(0, 7000)}`;
    }
  } else if (book) {
    context = `学生正在学《${book.title}》，但没有打开具体课节。`;
  }

  // 近期对话拼进单条 user 消息（保持所有调用单轮，规避多轮协议兼容问题）
  const session = store.currentChatSession(lessonId || null);
  const historyRows = store.listSessionMessages(session.id, 12);
  const history = historyRows
    .map(m => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`)
    .join('\n\n');

  // 滑动窗口 + 滚动小结（攒批压缩）：窗口=最近 12 条原文；掉出窗口的旧消息先原样携带（pending），
  // 攒够 8 条才调一次主模型并入滚动小结——小结调用频率降到每 4 轮一次，token 开销摊薄
  let synopsis = session.summary || '';
  let pendingText = '';
  if (historyRows.length) {
    const windowStart = historyRows[0].id;
    let pendingRows = store.sessionMessagesBetween(session.id, session.summary_upto || 0, windowStart);
    if (pendingRows.length >= 8) {
      try {
        const p0 = activeProvider();
        const digest = pendingRows.map(m => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`).join('\n\n').slice(0, 6000);
        const updated = await chat(p0, p0.default_model, [
          usr(`你在维护一段师生对话的滚动小结，供老师后续回应时回顾。${synopsis ? `已有小结：\n${synopsis}\n\n` : ''}新结束的对话片段：\n${digest}\n\n请输出更新后的完整小结（融合新旧，500 字以内，平实中文分点）：保留讨论过的知识点与结论、学生的疑问点与易错处、未解决的尾巴。不要客套话。`),
        ], { maxTokens: 4000 });
        const text = String(updated || '').trim();
        if (text) { synopsis = text; store.setSessionSummary(session.id, synopsis, windowStart - 1); pendingRows = []; }
      } catch { /* 小结失败沿用旧小结，pending 继续原样携带 */ }
    }
    pendingText = pendingRows.map(m => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`).join('\n\n');
  }

  const modeRule = TUTOR_MODES[mode] ? `\n\n${TUTOR_MODES[mode]}` : '';
  const teacherMessages = [
    sys(`你是一位耐心、博学的私教老师${book ? `，正在陪学生读《${book.title}》` : '，学生随时会过来插嘴问问题'}。
风格要求：称呼学生「宝宝」，不用「同学们/大家」；先直接回应问题，再展开；讲解通俗，善用类比和例子；${book ? '回答紧扣教材内容，学生跑题时温和拉回来；' : '没有教材上下文时就凭学识回答，知之为知之；'}语气亲切自然，像面对面辅导。回答用 markdown，适度分段，不要过长（一般 300 字以内，除非学生要求详细展开）。不要使用 emoji 表情符号。${modeRule}`),
    usr(`${context}

${synopsis ? `【早前讨论小结】\n${synopsis}\n\n` : ''}${pendingText ? `【稍早的对话】\n${pendingText}\n\n` : ''}${history ? `【最近的对话】\n${history}\n\n` : ''}${selection ? `宝宝选中的原文：「${selection}」\n\n` : ''}宝宝：${message}`),
  ];
  // 带 onText（SSE 场景）时走流式适配器，边生成边推送；否则保持原单次调用
  const answer = onText
    ? await chatStream(p, useModel, teacherMessages, { maxTokens: 8000 }, onText)
    : await chat(p, useModel, teacherMessages, { maxTokens: 8000 });

  store.addChat({ book_id: bookId || null, lesson_id: lessonId || null, role: 'user', content: message, session_id: session.id });
  store.addChat({ book_id: bookId || null, lesson_id: lessonId || null, role: 'assistant', content: answer, model_label: `${p.name} · ${useModel}`, session_id: session.id });
  return { answer, model_label: `${p.name} · ${useModel}`, session_id: session.id };
}

// 归档会话：用默认主模型把讨论总结成一句主题标题
export async function summarizeChatSession(sessionId) {
  const msgs = store.listSessionMessages(sessionId, 30);
  if (!msgs.length) return null;
  const transcript = msgs.map(m => `${m.role === 'user' ? '学生' : '老师'}：${m.content}`).join('\n').slice(0, 6000);
  const p = activeProvider();
  try {
    const t = await chat(p, p.default_model, [
      usr(`下面是一段学生与 AI 老师的讨论记录。请用 16 个字以内概括这段讨论的主题，作为会话卡片标题。只输出标题本身，不要引号、不要标点结尾、不要解释。\n\n${transcript}`),
    ], { maxTokens: 2000 });
    const title = String(t || '').trim().replace(/^[「"']|[」"']$/g, '').split('\n')[0].slice(0, 24);
    if (title) return title;
  } catch { /* 总结失败走兜底 */ }
  const firstUser = msgs.find(m => m.role === 'user');
  return firstUser ? firstUser.content.slice(0, 16) : '未命名讨论';
}

// ---------- 周报 ----------

function weekRange(offset = 0) {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 周一为 0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + offset * 7);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: fmt(monday), end: fmt(sunday) };
}

export async function generateWeeklyReport({ offset = 0, force = false } = {}) {
  const { start, end } = weekRange(offset);
  if (!force) {
    const cached = store.getWeeklyReport(start);
    if (cached) return { ...cached, cached: true };
  }
  const p = activeProvider();
  const prev = weekRange(offset - 1);

  // 汇总本周数据
  const days = store.raw(`SELECT date, seconds FROM study_time WHERE date BETWEEN ? AND ? ORDER BY date`, start, end);
  const prevSecs = store.rawGet(`SELECT COALESCE(SUM(seconds),0) AS s FROM study_time WHERE date BETWEEN ? AND ?`, prev.start, prev.end).s;
  const weekSecs = days.reduce((n, d) => n + d.seconds, 0);
  const reviewsDone = store.raw(`SELECT r.done_at, l.title AS lesson, r.score, b.title AS book
    FROM reviews r JOIN lessons l ON l.id=r.lesson_id JOIN books b ON b.id=r.book_id
    WHERE r.done=1 AND date(r.done_at) BETWEEN ? AND ?`, start, end);
  const newWrongs = store.raw(`SELECT w.question, w.correct_answer, l.title AS lesson, b.title AS book
    FROM wrong_questions w LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
    WHERE date(w.created_at) BETWEEN ? AND ?`, start, end);
  const unmastered = store.raw(`SELECT w.question, l.title AS lesson, b.title AS book
    FROM wrong_questions w LEFT JOIN lessons l ON l.id=w.lesson_id LEFT JOIN books b ON b.id=w.book_id
    WHERE w.mastered=0 ORDER BY w.id DESC LIMIT 15`);
  const qaCount = store.rawGet(`SELECT COUNT(*) AS n FROM qa WHERE date(created_at) BETWEEN ? AND ?`, start, end).n;
  const chatCount = store.rawGet(`SELECT COUNT(*) AS n FROM chat_messages WHERE role='user' AND date(created_at) BETWEEN ? AND ?`, start, end).n;
  const lessonStats = store.rawGet(`SELECT COUNT(*) AS done, ROUND(AVG(quiz_score)) AS avg FROM lessons WHERE study_status='done'`);

  if (!weekSecs && !reviewsDone.length && !newWrongs.length && !qaCount && !chatCount) {
    throw new Error('这一周还没有学习数据，先学一会儿再来生成周报');
  }

  const dayLines = days.length
    ? days.map(d => `${d.date}：${Math.round(d.seconds / 60)} 分钟`).join('；')
    : '（无计时记录）';

  const out = await chat(p, p.default_model, [
    sys(`你是一位温暖而敏锐的私教老师，为学生写学习周报。要求：
- 用 markdown，分四个小节：## 本周概览、## 学习节奏、## 薄弱点诊断、## 下周建议
- 本周概览：用数据说话（总时长、学习天数、与上周对比、完成复习轮数、测验表现）
- 学习节奏：分析每日时长分布的模式（哪天多哪天少、是否临考前突击式、给出节奏优化建议）
- 薄弱点诊断：结合错题内容归纳知识薄弱主题（不要只罗列题目，要提炼「哪类概念没掌握」），并给出针对性的补救建议
- 下周建议：具体可执行的 3-5 条（结合艾宾浩斯复习、薄弱点补救、新课进度）
- 语气：真诚、具体、有鼓励但不空洞。总长 500-800 字
- 全程不要使用任何 emoji 表情符号`),
    usr(`周报周期：${start} ~ ${end}

【每日时长】${dayLines}
【本周总时长】${Math.round(weekSecs / 60)} 分钟（上周：${Math.round(prevSecs / 60)} 分钟）
【本周完成的复习】${reviewsDone.length ? reviewsDone.map(r => `《${r.book}》${r.lesson}${r.score != null ? `（${r.score}分）` : ''}`).join('；') : '无'}
【测验总体】已完成 ${lessonStats.done || 0} 节，平均 ${lessonStats.avg || '—'} 分
【本周新错题】${newWrongs.length ? newWrongs.map(w => `[${w.book || ''}·${w.lesson || ''}] ${w.question}（正解：${w.correct_answer}）`).join('；') : '无'}
【尚未掌握的错题】${unmastered.length ? unmastered.map(w => `[${w.lesson || ''}] ${w.question}`).join('；') : '无'}
【本周互动】划词提问 ${qaCount} 次，师生对话 ${chatCount} 次`),
  ], { maxTokens: 16000 });

  const content = out.trim();
  store.saveWeeklyReport({ week_start: start, content, model_label: `${p.name} · ${p.default_model}` });
  return { week_start: start, content, model_label: `${p.name} · ${p.default_model}`, cached: false };
}

// ---------- 工具 ----------

function chunkText(text, size) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i + size * 0.5) end = nl;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}
