import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const waitingSource = appJs.match(/const CHAT_WAITING_STATES = Object\.freeze\([\s\S]*?\n}\n\n(?=const chatState)/)?.[0];

function loadWaitingStatus(randomValues) {
  assert.ok(waitingSource, 'waiting-status helper source must remain available');
  const callbacks = [];
  const cleared = [];
  const values = [...randomValues];
  const context = {
    Math: { ...Math, floor: Math.floor, random: () => values.shift() ?? 0 },
    setInterval: callback => { callbacks.push(callback); return callbacks.length; },
    clearInterval: id => cleared.push(id),
  };
  vm.runInNewContext(`${waitingSource}\nthis.createChatWaitingStatus = createChatWaitingStatus;`, context);
  return { create: context.createChatWaitingStatus, callbacks, cleared };
}

test('chat waiting status starts immediately, rotates without repeating, and cleans up once', () => {
  const { create, callbacks, cleared } = loadWaitingStatus([0, 0, 0.9]);
  const bubble = { isConnected: true, textContent: '' };

  const stop = create(bubble);
  assert.equal(bubble.textContent, '老师正在赶来……');
  assert.equal(callbacks.length, 1);

  callbacks[0]();
  assert.equal(bubble.textContent, '老师正在想……');
  callbacks[0]();
  assert.notEqual(bubble.textContent, '老师正在想……');

  stop();
  stop();
  assert.deepEqual(cleared, [1]);
});

test('chat waiting status stops touching a bubble removed from the document', () => {
  const { create, callbacks } = loadWaitingStatus([0, 0]);
  const bubble = { isConnected: true, textContent: '' };
  create(bubble);
  const first = bubble.textContent;

  bubble.isConnected = false;
  callbacks[0]();
  assert.equal(bubble.textContent, first);
});
