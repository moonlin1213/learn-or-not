// Edge TTS 零依赖语音合成：原生 WebSocket 直连微软免费朗读端点。
// 免费、无需 API key、神经音质；但需要联网（音频在微软服务器合成）。
// 协议镜像 node-edge-tts：Sec-MS-GEC 查询参数（时间片 SHA-256）+ SSML + 二进制 Path:audio 帧。
import crypto from 'node:crypto';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const CRLF = '\r\n';

function secMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n); // 向下取整到 5 分钟边界
  return crypto.createHash('sha256').update(String(rounded) + TRUSTED_CLIENT_TOKEN, 'ascii').digest('hex').toUpperCase();
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function synthesizeOnce(text, { voice, rate, pitch, volume }) {
  return new Promise((resolve, reject) => {
    const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGecToken()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('语音合成超时'));
    }, 60000);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      try { ws.close(); } catch {}
      if (buf.length < 100) return reject(new Error('合成结果为空'));
      resolve(buf);
    };

    ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('语音服务连接失败')); } };
    ws.onclose = (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`连接提前关闭 code=${e.code}`)); } };
    ws.onmessage = (event) => {
      if (settled) return;
      if (typeof event.data === 'string') {
        if (event.data.includes('Path:turn.end')) finish();
        return;
      }
      const raw = Buffer.from(event.data);
      const marker = Buffer.from('Path:audio' + CRLF);
      const idx = raw.indexOf(marker);
      if (idx >= 0) {
        const body = raw.subarray(idx + marker.length);
        if (body.length) chunks.push(body);
      } else if (raw.length) {
        chunks.push(raw);
      }
    };
    ws.onopen = () => {
      const requestId = crypto.randomBytes(16).toString('hex');
      const speechConfig = { context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
      const vparts = String(voice).split('-');
      const lang = vparts.length >= 2 ? vparts[0] + '-' + vparts[1] : 'zh-CN';
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${xmlEscape(voice)}"><prosody rate="${xmlEscape(rate)}" pitch="${xmlEscape(pitch)}" volume="${xmlEscape(volume)}">${xmlEscape(text)}</prosody></voice></speak>`;
      ws.send('Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF + JSON.stringify(speechConfig));
      ws.send('X-RequestId:' + requestId + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
    };
  });
}

// 进程内缓存：同一段文本+音色+语速重复朗读直接命中（FIFO，40 段封顶）
const cache = new Map();
const CACHE_MAX = 40;

export async function synthesizeSpeech(text, { voice = 'zh-CN-YunxiNeural', rate = 'default', pitch = 'default', volume = 'default' } = {}) {
  const key = crypto.createHash('sha256').update(`${voice}|${rate}|${pitch}|${volume}|${text}`).digest('hex');
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const buf = await synthesizeOnce(text, { voice, rate, pitch, volume });
      cache.set(key, buf);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return buf;
    } catch (e) {
      lastErr = e; // 连接级抖动常见，无脑重试一次（合成是幂等的）
    }
  }
  throw lastErr;
}
