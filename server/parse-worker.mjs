// 文档解析 worker：PDF/EPUB/DOCX 解析是 CPU 密集的同步 JS，
// 在主线程跑会卡住整个 HTTP 服务（上传大书期间其他页面全部无响应），挪到 worker 线程。
import { parentPort } from 'node:worker_threads';
import { parseDocument } from './parser.js';

parentPort.on('message', async ({ path: filePath, format }) => {
  try {
    const text = await parseDocument(filePath, format);
    parentPort.postMessage({ ok: true, text });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
});
