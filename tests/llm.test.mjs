import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../server/llm.js';

test('extractJson preserves Markdown code fences inside valid JSON strings', () => {
  const payload = {
    preguide: '先认识上下文。',
    content: '示例：\n\n```python\nmessages = [{"role": "user"}]\n```\n\n继续讲解。',
    terms: [{ term: '上下文', annotation: '消息列表。' }],
    quiz: [],
  };

  const json = JSON.stringify(payload);
  assert.deepEqual(extractJson(json), payload);
  assert.deepEqual(extractJson('```json\n' + json + '\n```'), payload);
});

test('extractJson still accepts a whole response wrapped in a JSON fence', () => {
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
});

test('extractJson reports a concise error without echoing model output', () => {
  const raw = '这是一段很长但不是 JSON 的模型原文';
  assert.throws(
    () => extractJson(raw),
    error => error.message === '模型返回的内容格式不完整，无法读取' && !error.message.includes(raw),
  );
});
