import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('toast entrance animation preserves horizontal centering', () => {
  const keyframes = css.match(/@keyframes\s+toast-rise\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(keyframes, /from\s*\{[^}]*transform:\s*translate\(-50%,\s*14px\)/);
  assert.match(keyframes, /to\s*\{[^}]*transform:\s*translate\(-50%,\s*0\)/);

  const toastRule = css.match(/#toast\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(toastRule, /left:\s*50%/);
  assert.match(toastRule, /animation:\s*toast-rise\b/);
});
