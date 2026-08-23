import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  acceptsSpeechEnvelope,
  packSpeechResponse,
  parseSpeechMetadata,
  TTS_ENVELOPE_TYPE,
} from '../server/tts.js';

const ttsSource = fs.readFileSync(new URL('../public/tts.js', import.meta.url), 'utf8');

function loadTtsForTest() {
  const context = {
    window: { __LEARNORNOT_TEST__: true },
    localStorage: { getItem: () => null, setItem: () => {} },
    ArrayBuffer,
    DataView,
    TextDecoder,
    console,
  };
  vm.runInNewContext(ttsSource, context);
  return context.window.TTS;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test('Edge sentence metadata is retained as compact audio tick ranges', () => {
  const message = [
    'X-RequestId:test',
    'Content-Type:application/json; charset=utf-8',
    'Path:audio.metadata',
    '',
    JSON.stringify({ Metadata: [
      { Type: 'WordBoundary', Data: { Offset: 1_000_000, Duration: 2_000_000 } },
      { Type: 'SentenceBoundary', Data: { Offset: 1_000_000, Duration: 14_375_000, text: { Text: '第一句。' } } },
      { Type: 'SentenceBoundary', Data: { Offset: 15_375_000, Duration: 75_875_000, text: { Text: '第二句。' } } },
    ] }),
  ].join('\r\n');

  assert.deepEqual(parseSpeechMetadata(message), [
    [1_000_000, 14_375_000, '第一句。'],
    [15_375_000, 75_875_000, '第二句。'],
  ]);
});

test('TTS response envelope keeps timing metadata and MP3 bytes separate', () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
  const packet = packSpeechResponse(audio, [[1_000_000, 14_375_000]]);
  const metadataLength = packet.readUInt32BE(0);
  const metadata = JSON.parse(packet.subarray(4, 4 + metadataLength).toString('utf8'));

  assert.deepEqual(metadata, { sentences: [[1_000_000, 14_375_000]] });
  assert.deepEqual(packet.subarray(4 + metadataLength), audio);
});

test('TTS envelope is opt-in so old clients continue receiving raw MP3', () => {
  const tts = loadTtsForTest();
  assert.equal(tts._envelopeType, TTS_ENVELOPE_TYPE);
  assert.equal(acceptsSpeechEnvelope(TTS_ENVELOPE_TYPE), true);
  assert.equal(acceptsSpeechEnvelope(`${TTS_ENVELOPE_TYPE}; q=1, audio/mpeg; q=.5`), true);
  assert.equal(acceptsSpeechEnvelope('Application/Vnd.LearnOrNot.Tts; Q=.8'), true);
  assert.equal(acceptsSpeechEnvelope(`${TTS_ENVELOPE_TYPE}; q=0, audio/mpeg`), false);
  assert.equal(acceptsSpeechEnvelope('*/*'), false);
  assert.equal(acceptsSpeechEnvelope('audio/mpeg'), false);
});

test('browser decoder reads valid envelopes and keeps legacy audio responses working', () => {
  const tts = loadTtsForTest();
  const audio = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
  const packet = packSpeechResponse(audio, [
    [1_000_000, 14_375_000, '第一句。'],
    [-1, 2_000_000, 'invalid'],
    ['bad', 2_000_000, 'invalid'],
  ]);
  const decoded = tts._decodeSpeechResponse(toArrayBuffer(packet), 'Application/Vnd.LearnOrNot.Tts; charset=binary');

  assert.deepEqual(Array.from(new Uint8Array(decoded.audio)), Array.from(audio));
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.sentenceTimings)), [{ offset: 0.1, duration: 1.4375, text: '第一句。' }]);

  const legacy = toArrayBuffer(audio);
  const legacyDecoded = tts._decodeSpeechResponse(legacy, 'audio/mpeg');
  assert.equal(legacyDecoded.audio, legacy);
  assert.deepEqual(JSON.parse(JSON.stringify(legacyDecoded.sentenceTimings)), []);
});

test('browser decoder rejects truncated or malformed envelopes', () => {
  const decode = loadTtsForTest()._decodeSpeechResponse;
  assert.throws(() => decode(new ArrayBuffer(3), TTS_ENVELOPE_TYPE), /语音响应格式损坏/);

  const oversized = new ArrayBuffer(8);
  new DataView(oversized).setUint32(0, 99, false);
  assert.throws(() => decode(oversized, TTS_ENVELOPE_TYPE), /语音响应格式损坏/);

  const malformed = Buffer.alloc(4 + 3);
  malformed.writeUInt32BE(3, 0);
  malformed.write('no!', 4);
  assert.throws(() => decode(toArrayBuffer(malformed), TTS_ENVELOPE_TYPE), /语音时间信息解析失败/);

  for (const metadata of [null, { sentences: {} }]) {
    const json = Buffer.from(JSON.stringify(metadata));
    const packet = Buffer.alloc(4 + json.length);
    packet.writeUInt32BE(json.length, 0);
    json.copy(packet, 4);
    assert.throws(() => decode(toArrayBuffer(packet), TTS_ENVELOPE_TYPE), /语音时间信息格式损坏/);
  }
});

test('karaoke sentence selection follows real audio boundaries instead of character ratio', () => {
  const pick = loadTtsForTest()._pickKaraokeUnit;

  assert.equal(typeof pick, 'function');
  const units = ['第一句很短。', '第二句包含 English、数字 12345。', '第三句收尾。'];
  const timings = [
    { offset: 0.1, duration: 1.4375, text: units[0] },
    { offset: 1.5375, duration: 7.5875, text: units[1] },
    { offset: 9.125, duration: 1.8625, text: units[2] },
  ];
  const lens = units.map(x => x.replace(/\s/g, '').length);

  // Character-ratio estimation has already crossed into sentence 2 here,
  // while the verified audio boundary says sentence 1 is still being spoken.
  assert.equal(pick(timings, lens, 1.2, 10.9875, units), 0);
  assert.equal(pick(timings, lens, 1.6, 10.9875, units), 1);
  assert.equal(pick(timings, lens, 9.2, 10.9875, units), 2);

  assert.equal(pick([], lens, -1, 0, units), 0);
  assert.equal(pick(undefined, lens, 999, 0, units), 2);
  assert.equal(pick(timings.slice(0, 2), lens, 5, 10, units), 1);
  assert.equal(pick(timings.map((t, i) => ({ ...t, text: `错句${i}` })), lens, 5, 10.9875, units), 1);
  assert.equal(pick([timings[0], { ...timings[1], offset: 0.1 }, timings[2]], lens, 5, 10.9875, units), 1);
  assert.equal(pick([timings[0], timings[1], { ...timings[2], offset: 99 }], lens, 5, 10.9875, units), 1);
});

test('karaoke scroll target leaves about three text lines below the sticky player', () => {
  const delta = loadTtsForTest()._readingScrollDelta;

  assert.equal(typeof delta, 'function');
  // Sticky controls end at y=160. With a 32px line height, the highlighted
  // sentence should land at y=272, around the fourth visible text line.
  assert.equal(delta({ rangeTop: 200, stickyBottom: 160, viewportHeight: 800, lineHeight: 32 }), -72);
  assert.equal(delta({ rangeTop: 520, stickyBottom: 160, viewportHeight: 800, lineHeight: 32 }), 248);
});
