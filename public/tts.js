// 朗读器：Edge TTS 分段渐进合成 + Web Audio 采样级无缝拼接。
// 课件正文 → 剔除公式/代码/表格 → 按句分段 → 首段小（快速开口）、后续段边播边合成。
// 设置持久化在 localStorage「learnloop.tts」。
window.TTS = (() => {
  const LS_KEY = 'learnloop.tts';
  const VOICES = [
    { id: 'zh-CN-YunxiNeural', name: '云希 · 男声清亮（讲课感）' },
    { id: 'zh-CN-XiaoxuanNeural', name: '晓萱 · 女声温柔' },
    { id: 'zh-CN-YunyangNeural', name: '云扬 · 男声播音' },
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 女声亲和' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 女声轻快' },
    { id: 'zh-CN-YunjianNeural', name: '云健 · 男声浑厚' },
    { id: 'en-US-AriaNeural', name: 'Aria · English' },
    { id: 'en-US-JennyNeural', name: 'Jenny · English' },
  ];
  const RATES = [
    { v: '-20%', l: '0.8x · 慢' },
    { v: '-10%', l: '0.9x' },
    { v: 'default', l: '1.0x · 原速' },
    { v: '+10%', l: '1.1x' },
    { v: '+25%', l: '1.25x' },
    { v: '+50%', l: '1.5x · 快' },
  ];
  const DEFAULTS = { voice: 'zh-CN-YunxiNeural', rate: 'default' };

  let settings = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; }
    catch { return { ...DEFAULTS }; }
  })();
  if (!VOICES.some(v => v.id === settings.voice)) settings.voice = DEFAULTS.voice;
  if (!RATES.some(r => r.v === settings.rate)) settings.rate = DEFAULTS.rate;

  let ac = null;   // AudioContext（懒创建，首次点击即解锁自动播放策略）
  let job = null;  // { chunks, buffers[], sources:Set, cancelled, state, audible, total }

  // ---------- 文本提取与分段 ----------
  function extractText(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.katex').forEach(el => el.replaceWith(document.createTextNode('（公式）')));
    clone.querySelectorAll('pre').forEach(el => el.replaceWith(document.createTextNode('（代码示例从略）')));
    clone.querySelectorAll('table').forEach(el => el.replaceWith(document.createTextNode('（此处有表格，请回到原文查看）')));
    clone.querySelectorAll('img,svg,canvas,button,script,style').forEach(el => el.remove());
    return (clone.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function splitSentences(para) {
    const parts = para.match(/[^。！？；…!?\n]+[。！？；…!?"”’」』）)]*/g);
    return parts ? parts.map(s => s.trim()).filter(Boolean) : [para];
  }

  // 首段小（快速开口），后续段 700 字左右（减少请求数）
  function chunkText(text) {
    const FIRST = 240, MAX = 700;
    const units = [];
    for (const para of text.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      for (const s of splitSentences(para)) {
        if (s.length > MAX) for (let i = 0; i < s.length; i += MAX) units.push(s.slice(i, i + MAX));
        else units.push(s);
      }
    }
    const out = [];
    let cur = '';
    for (const u of units) {
      const lim = out.length === 0 ? FIRST : MAX;
      if (cur && cur.length + u.length + 1 > lim) { out.push(cur); cur = u; }
      else cur = cur ? cur + '\n' + u : u;
    }
    if (cur) out.push(cur);
    return out;
  }

  // ---------- 合成与播放 ----------
  async function fetchSynth(text) {
    const r = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: settings.voice, rate: settings.rate }),
    });
    if (!r.ok) {
      let msg = '语音合成失败';
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return r.arrayBuffer();
  }

  function ensureBuffer(j, i) {
    if (!j.buffers[i]) {
      j.buffers[i] = fetchSynth(j.chunks[i]).then(ab => ac.decodeAudioData(ab));
      j.buffers[i].catch(() => {}); // 预取失败先吞掉，轮到它时会重试
    }
    return j.buffers[i];
  }

  async function run(j) {
    let nextStart = 0;
    for (let i = 0; i < j.chunks.length; i++) {
      if (j.cancelled) return;
      let buf;
      try { buf = await ensureBuffer(j, i); }
      catch {
        try { delete j.buffers[i]; buf = await ensureBuffer(j, i); } // 轮到这段才失败：重试一次
        catch (e) { if (!j.cancelled) fail(e); return; }
      }
      if (j.cancelled) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      const t = Math.max(ac.currentTime + 0.03, nextStart);
      src.start(t);
      nextStart = t + buf.duration;
      j.sources.add(src);
      if (i === 0) { j.state = 'playing'; j.audible = 1; }
      src.onended = () => {
        j.sources.delete(src);
        if (j.cancelled || j !== job) return;
        if (i + 1 >= j.total) { stop(); } // 最后一段播完，自然收工
        else { j.audible = i + 2; updateUI(); }
      };
      updateUI();
      if (i + 1 < j.chunks.length) ensureBuffer(j, i + 1); // 边播边合成下一段
    }
  }

  function speak(chunks) {
    stop();
    if (!chunks.length) { toast('这一页没有可朗读的文字'); return; }
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    ac.resume();
    job = { chunks, buffers: [], sources: new Set(), cancelled: false, state: 'loading', audible: 0, total: chunks.length };
    updateUI();
    run(job);
  }

  function start(rootEl) {
    const text = extractText(rootEl);
    if (text.length < 4) { toast('这一页没有可朗读的文字'); return; }
    speak(chunkText(text));
  }

  function stop() {
    if (!job) return;
    job.cancelled = true;
    try { ac && ac.resume(); } catch {}
    for (const s of job.sources) { try { s.stop(); } catch {} }
    job = null;
    updateUI();
  }

  function fail(e) {
    stop();
    toast(/联网|连接|超时|网络/.test(e.message) ? '朗读需要联网（Edge TTS 在线合成）——检查一下网络' : e.message, true);
  }

  async function togglePause() {
    if (!job || job.state === 'loading') return;
    if (job.state === 'playing') { job.state = 'paused'; await ac.suspend(); }
    else if (job.state === 'paused') { job.state = 'playing'; await ac.resume(); }
    updateUI();
  }

  // ---------- UI ----------
  function updateUI() {
    const toggle = document.getElementById('tts-toggle');
    if (toggle) {
      toggle.classList.toggle('active', !!job);
      toggle.textContent = job ? '◉ 朗读中' : '▸ 朗读';
    }
    const bar = document.getElementById('tts-bar');
    if (!bar) return;
    if (!job) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.classList.toggle('playing', job.state === 'playing');
    const pauseBtn = document.getElementById('tts-pause');
    const seg = document.getElementById('tts-seg');
    if (pauseBtn) {
      pauseBtn.textContent = job.state === 'paused' ? '▸' : '❚❚';
      pauseBtn.title = job.state === 'paused' ? '继续' : '暂停';
      pauseBtn.disabled = job.state === 'loading';
    }
    if (seg) seg.textContent = job.state === 'loading'
      ? '合成中…'
      : `第 ${Math.max(job.audible, 1)}/${job.total} 段${job.state === 'paused' ? ' · 已暂停' : ''}`;
  }

  // 课节页渲染后由 app.js 调用：接线按钮（DOM 不存在时静默跳过）
  function bindLesson() {
    const toggle = document.getElementById('tts-toggle');
    if (!toggle) return;
    toggle.onclick = () => {
      if (typeof state !== 'undefined' && state.lessonTab === 'quiz') { toast('测验页就不读啦，专心做题'); return; }
      if (job) { stop(); return; }
      const root = document.getElementById('tab-body');
      if (root) start(root);
    };
    document.getElementById('tts-pause')?.addEventListener('click', togglePause);
    document.getElementById('tts-stop')?.addEventListener('click', stop);
    updateUI();
  }

  function preview() {
    speak(['学而时习之，不亦说乎。这里是「学不学」的朗读试听——愿你在纸莎草的香气里，听见知识的声音。']);
  }

  function getSettings() { return { ...settings }; }
  function saveSettings(patch) {
    Object.assign(settings, patch);
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  }

  return { bindLesson, stop, start, togglePause, preview, getSettings, saveSettings, VOICES, RATES, isActive: () => !!job };
})();
