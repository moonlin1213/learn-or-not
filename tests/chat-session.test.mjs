import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnornot-chat-session-'));
process.env.LEARNLOOP_DATA_DIR = dataDir;
const { store } = await import('../server/db.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('exit checkpoint archives in place and explicit archive rotates once', () => {
  const bookId = Number(store.addBook({
    title: '测试教材', filename: 'test.md', format: 'md', status: 'outlined',
  }).lastInsertRowid);
  const moduleId = Number(store.addModule({
    book_id: bookId, idx: 0, title: '模块', summary: '',
  }).lastInsertRowid);
  const lessonId = Number(store.addLesson({
    module_id: moduleId, book_id: bookId, idx: 0, title: '第一课', goal: '',
    source_hint: '', est_minutes: 20,
  }).lastInsertRowid);
  const nextLessonId = Number(store.addLesson({
    module_id: moduleId, book_id: bookId, idx: 1, title: '第二课', goal: '',
    source_hint: '', est_minutes: 20,
  }).lastInsertRowid);
  // 学习进度已经推进到第二课，但最后聊天仍发生在第一课。
  store.setLastLesson(bookId, nextLessonId);
  assert.equal(store.nextLesson(bookId, lessonId).id, nextLessonId);
  assert.equal(store.nextLesson(bookId, nextLessonId), undefined);

  const first = store.currentChatSession(lessonId);
  store.addChat({ book_id: bookId, lesson_id: lessonId, role: 'user', content: '为什么天空是蓝色的？', session_id: first.id });
  store.addChat({ book_id: bookId, lesson_id: lessonId, role: 'assistant', content: '因为瑞利散射。', session_id: first.id });

  const restored = store.lastResumableChatSession();
  assert.equal(restored.id, first.id);
  assert.equal(restored.lesson_id, lessonId);
  assert.equal(restored.book_id, bookId);
  assert.equal(restored.resume_lesson_id, nextLessonId);
  assert.equal(restored.msg_count, 2);
  assert.equal(restored.archived, 0);

  const firstCheckpoint = store.checkpointChatSession(first.id, '为什么天空是蓝色的？');
  assert.equal(firstCheckpoint.id, first.id);
  assert.equal(firstCheckpoint.archived, 1);
  assert.equal(firstCheckpoint.is_current, 1);
  assert.equal(store.lastResumableChatSession().id, first.id);
  assert.equal(store.listArchivedSessions().length, 1);
  assert.equal(store.listArchivedSessions()[0].msg_count, 2);

  // 下次冷启动继续聊，消息仍写进原 session；再次退出只更新同一张卡。
  store.addChat({ book_id: bookId, lesson_id: lessonId, role: 'user', content: '那日落为什么发红？', session_id: first.id });
  store.addChat({ book_id: bookId, lesson_id: lessonId, role: 'assistant', content: '光程更长，短波散射更多。', session_id: first.id });
  const secondCheckpoint = store.checkpointChatSession(first.id, '不应覆盖已有标题');
  const checkpointCards = store.listArchivedSessions();
  assert.equal(secondCheckpoint.id, first.id);
  assert.equal(secondCheckpoint.title, '为什么天空是蓝色的？');
  assert.equal(checkpointCards.length, 1);
  assert.equal(checkpointCards[0].id, first.id);
  assert.equal(checkpointCards[0].msg_count, 4);

  // 「入」或黑猫才硬归档并切到新 session；已软归档的原卡不会复制。
  const archived = store.archiveChatSession(lessonId, '天空颜色与光散射');
  const next = store.currentChatSession(lessonId);
  const cards = store.listArchivedSessions();
  assert.equal(archived.id, first.id);
  assert.equal(archived.is_current, 0);
  assert.notEqual(next.id, first.id);
  assert.equal(store.sessionMsgCount(next.id), 0);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, first.id);
  assert.equal(cards[0].msg_count, 4);

  const global = store.currentChatSession(null);
  store.addChat({ book_id: bookId, lesson_id: null, role: 'user', content: '整本书的核心是什么？', session_id: global.id });
  store.addChat({ book_id: bookId, lesson_id: null, role: 'assistant', content: '这是全局会话。', session_id: global.id });
  const restoredGlobal = store.lastResumableChatSession();
  assert.equal(restoredGlobal.id, global.id);
  assert.equal(restoredGlobal.lesson_id, null);
  assert.equal(restoredGlobal.book_id, bookId);
  assert.equal(restoredGlobal.resume_lesson_id, nextLessonId);
  assert.equal(restoredGlobal.archived, 0);
});
