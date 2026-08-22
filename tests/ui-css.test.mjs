import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const ttsJs = fs.readFileSync(new URL('../public/tts.js', import.meta.url), 'utf8');
const gitignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('JingHwa OldSong remains the preferred Chinese serif with a local-only bundled asset', () => {
  assert.match(css, /font-family:\s*"JingHwa OldSong"/);
  assert.match(css, /src:\s*local\("JingHwa OldSong"\),\s*url\("\/fonts\/jinghua\.woff2"\)/);
  assert.match(css, /--serif:[^;]*"Cormorant Garamond"[^;]*"JingHwa OldSong"/);
  assert.match(gitignore, /^public\/fonts\/jinghua\.woff2$/m);
});

test('toast entrance animation preserves horizontal centering', () => {
  const keyframes = css.match(/@keyframes\s+toast-rise\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(keyframes, /from\s*\{[^}]*transform:\s*translate\(-50%,\s*14px\)/);
  assert.match(keyframes, /to\s*\{[^}]*transform:\s*translate\(-50%,\s*0\)/);

  const toastRule = css.match(/#toast\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(toastRule, /left:\s*50%/);
  assert.match(toastRule, /animation:\s*toast-rise\b/);

  const errorRule = css.match(/#toast\.err\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(errorRule, /max-width:\s*min\(/);
  assert.match(errorRule, /overflow-wrap:\s*anywhere/);
});

test('subscription settings offer local credential import without direct official OAuth', () => {
  assert.match(appJs, /platform\.direct_login \? `<button[^`]*data-oauth-act="login"/);
  assert.match(appJs, /data-oauth-act="import">导入本机登录态<\/button>/);
  assert.match(appJs, /订阅账户仅导入本机登录态，不会打开官网授权/);
  assert.match(appJs, /Codex 与 Grok 都只读取本机已有的 DSH 登录态/);
});

test('lesson TTS exposes a styled progress control with real audio seeking', () => {
  assert.match(appJs, /id="tts-progress"[^>]*type="range"/);
  assert.match(appJs, /id="tts-percent"/);
  assert.match(css, /#tts-progress::\-webkit-slider-runnable-track/);
  assert.match(css, /#tts-progress::\-webkit-slider-thumb/);
  assert.match(ttsJs, /async function seekTo\(fraction\)/);
  assert.match(ttsJs, /src\.start\(t, offset\)/);
  assert.match(ttsJs, /progress\.addEventListener\('change',[\s\S]*?seekTo\(Number\(progress\.value\) \/ 1000\)/);
  assert.match(ttsJs, /revealChunkPosition\(j, index, within\)/);
  assert.match(ttsJs, /CSS\.highlights\.set\('tts-seek'/);
  assert.match(ttsJs, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
  assert.match(css, /::highlight\(tts-seek\)/);
  assert.match(css, /--tts-accent:\s*#A07C45/);
  assert.match(ttsJs, /function warmBuffers\(j\)/);
  assert.match(ttsJs, /Promise\.allSettled\(\[worker\(\), worker\(\), worker\(\)\]\)/);
  assert.match(ttsJs, /首次定位第 \$\{job\.audible\}\/\$\{job\.total\} 段 · 正在生成这段语音/);
  assert.match(css, /#tts-bar\.loading \.tts-dot/);
});
