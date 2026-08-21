// 翰林院 · Obsidian 沉淀：把学过的课程、讲义、术语、划线、错题写成 markdown vault
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { store } from './db.js';

// 沉淀目录优先级：设置页 hanlin_dir > 环境变量 > 默认 ~/Downloads/翰林院/LearnOrNot
export function hanlinDir() {
  return store.getSetting('hanlin_dir')
    || process.env.LEARNLOOP_HANLIN_DIR
    || path.join(os.homedir(), 'Downloads', '翰林院', 'LearnOrNot');
}

const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
const safe = (s, max = 60) => String(s || '').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || '未命名';
const pad2 = (n) => String(n).padStart(2, '0');

function lessonFileName(l) { return `第${pad2(l.idx + 1)}课-${safe(l.title, 40)}`; }

function fm(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${JSON.stringify(String(v))}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function write(rel, content) {
  const fp = path.join(hanlinDir(), rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

export function exportToObsidian() {
  const books = store.listBooks();
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let nLessons = 0, nTerms = 0, nHighlights = 0, nWrongs = 0;
  const bookLines = [];

  for (const book of books) {
    const bookDir = safe(book.title, 50);
    const outline = store.getOutline(book.id);
    const highlights = store.listHighlights(book.id);
    const wrongs = store.listWrong(book.id);
    const termRows = store.bookTerms(book.id);

    // 课节笔记（只沉淀已备课的）
    const lessonNotes = []; // {lesson, file}
    for (const m of outline) {
      for (const lite of m.lessons) {
        const l = store.getLesson(lite.id);
        if (!l || l.status !== 'ready') continue;
        const file = `${lessonFileName(l)}.md`;
        lessonNotes.push({ lesson: l, module: m, file });
        nLessons++;

        const terms = JSON.parse(l.terms || '[]');
        const hl = highlights.filter(h => h.lesson_id === l.id);
        const wq = wrongs.filter(w => w.lesson_id === l.id);
        nTerms += terms.length; nHighlights += hl.length; nWrongs += wq.length;

        let body = fm({
          book: book.title, lesson: l.idx + 1, status: l.study_status,
          score: l.quiz_score, tags: ['learnloop'], exported: stamp,
        });
        body += `# 第${l.idx + 1}课 ${l.title}\n\n`;
        if (l.goal) body += `> 学习目标：${l.goal}\n\n`;
        if (l.preguide) body += `## 课前引导\n\n${l.preguide.trim()}\n\n`;
        body += `## 精读讲义\n\n${(l.content || '').trim()}\n\n`;
        if (terms.length) {
          body += `## 术语速览\n\n| 术语 | 注释 |\n|---|---|\n`;
          for (const t of terms) body += `| ${String(t.term).replace(/\|/g, '｜')} | ${String(t.annotation).replace(/\|/g, '｜').replace(/\n/g, '<br>')} |\n`;
          body += '\n';
        }
        if (hl.length) {
          body += `## 我的划线\n\n`;
          for (const h of hl) body += `> ${h.text.replace(/\n/g, ' ')}\n\n`;
        }
        if (wq.length) {
          body += `## 错题回顾\n\n`;
          for (const w of wq) {
            body += `- **${w.question.replace(/\n/g, ' ')}**\n  - 正解：${w.correct_answer}${w.mastered ? '（已掌握）' : ''}\n`;
            if (w.explanation) body += `  - 解析：${w.explanation.replace(/\n/g, ' ')}\n`;
          }
          body += '\n';
        }
        body += `---\n学习状态：${l.study_status === 'done' ? '已学完' : l.study_status === 'studying' ? '在学' : '未开始'}`;
        body += `${l.quiz_score != null ? ` · 测验 ${l.quiz_score} 分` : ''} · 导出自 LearnOrNot\n`;
        write(`${bookDir}/${file}`, body);
      }
    }

    // 课程地图（MOC）
    let map = fm({ book: book.title, progress: `${book.done_count}/${book.lesson_count}`, tags: ['learnloop', 'MOC'], exported: stamp });
    map += `# 《${book.title}》课程地图\n\n进度 ${book.done_count} / ${book.lesson_count} 节\n\n`;
    for (const m of outline) {
      map += `## ${m.title}\n\n`;
      if (m.summary) map += `${m.summary}\n\n`;
      for (const l of m.lessons) {
        const note = lessonNotes.find(n => n.lesson.id === l.id);
        const mark = l.study_status === 'done' ? '✓' : l.status === 'ready' ? '◐' : '○';
        const score = l.quiz_score != null ? `（${l.quiz_score} 分）` : '';
        map += note
          ? `- ${mark} [[${note.file.replace(/\.md$/, '')}|${l.title}]]${score}\n`
          : `- ${mark} ${l.title}（未备课）\n`;
      }
      map += '\n';
    }
    write(`${bookDir}/${safe(book.title, 40)}-课程地图.md`, map);

    // 术语表
    const allTerms = [];
    for (const r of termRows) {
      const l = lessonNotes.find(n => n.lesson.id === r.lesson_id);
      for (const t of JSON.parse(r.terms || '[]')) {
        allTerms.push({ ...t, from: l ? l.file.replace(/\.md$/, '') : null, lesson_title: r.lesson_title });
      }
    }
    if (allTerms.length) {
      let tp = fm({ book: book.title, count: allTerms.length, tags: ['learnloop', '术语'], exported: stamp });
      tp += `# 《${book.title}》术语表\n\n| 术语 | 注释 | 出自 |\n|---|---|---|\n`;
      for (const t of allTerms) {
        const from = t.from ? `[[${t.from}|${t.lesson_title}]]` : t.lesson_title;
        tp += `| ${String(t.term).replace(/\|/g, '｜')} | ${String(t.annotation).replace(/\|/g, '｜').replace(/\n/g, '<br>')} | ${from} |\n`;
      }
      write(`${bookDir}/术语表.md`, tp);
    }

    bookLines.push(`- [[${bookDir}/${safe(book.title, 40)}-课程地图|《${book.title}》]] · ${book.done_count}/${book.lesson_count} 节`);
  }

  // 总览
  let idx = fm({ tags: ['learnloop', 'MOC'], exported: stamp });
  idx += `# LearnOrNot · 学不学 总览\n\n这里沉淀着「学不学」里学过的全部课程。最后沉淀：${stamp}\n\n${bookLines.join('\n') || '（还没有课程）'}\n`;
  write(`LearnOrNot-总览.md`, idx);

  store.setSetting('hanlin_last_export', stamp);
  return { dir: hanlinDir(), books: books.length, lessons: nLessons, terms: nTerms, highlights: nHighlights, wrongs: nWrongs, exported_at: stamp };
}

export function obsidianStatus() {
  return {
    dir: hanlinDir(),
    exported_before: fs.existsSync(path.join(hanlinDir(), 'LearnOrNot-总览.md')),
    last_export: store.getSetting('hanlin_last_export') || null,
  };
}
