import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMaterials, htmlToText, parseGitHubUrl, selectRepositoryFiles } from '../server/analysis.js';

test('GitHub repository links are normalized without turning into courses', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/moonlin1213/learn-or-not.git'), {
    owner: 'moonlin1213',
    repo: 'learn-or-not',
    canonical: 'https://github.com/moonlin1213/learn-or-not',
  });
  assert.throws(() => parseGitHubUrl('https://example.com/not-a-repo'), /不是一个公开 GitHub/);
});

test('repository intake favors README, docs and manifests while excluding generated trees', () => {
  const picked = selectRepositoryFiles([
    { type: 'blob', path: 'src/index.js', size: 4000 },
    { type: 'blob', path: 'node_modules/nope.js', size: 100 },
    { type: 'blob', path: 'dist/bundle.js', size: 100 },
    { type: 'blob', path: 'docs/architecture.md', size: 2000 },
    { type: 'blob', path: 'package.json', size: 1200 },
    { type: 'blob', path: 'package-lock.json', size: 5000 },
    { type: 'blob', path: 'README.md', size: 3000 },
    { type: 'blob', path: 'logo.png', size: 3000 },
  ]).map(item => item.path);
  assert.deepEqual(picked.slice(0, 4), ['README.md', 'docs/architecture.md', 'package.json', 'src/index.js']);
  assert.ok(!picked.some(path => path.startsWith('node_modules/') || path.startsWith('dist/')));
  assert.ok(!picked.includes('logo.png'));
  assert.ok(!picked.includes('package-lock.json'));
});

test('webpage intake keeps readable text and removes scripts and markup', () => {
  const result = htmlToText('<html><head><title>一篇 &amp; 文章</title><style>.x{}</style></head><body><h1>标题</h1><script>steal()</script><p>第一段</p><p>第二段</p></body></html>');
  assert.equal(result.title, '一篇 & 文章');
  assert.match(result.text, /标题/);
  assert.match(result.text, /第一段/);
  assert.doesNotMatch(result.text, /steal|<p>/);
});

test('horizontal analysis requires two to six completed materials', async () => {
  const material = { id: 1, title: '甲', status: 'done', result: '已经看完', content: '原材料' };
  await assert.rejects(() => compareMaterials({ materials: [material] }), /2 到 6/);
  await assert.rejects(() => compareMaterials({ materials: [material, { ...material, id: 2, status: 'running' }] }), /已经看完/);
});
