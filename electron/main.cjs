// LearnLoop Electron 主进程：内嵌后端 + 单窗口
const { app, BrowserWindow, shell, nativeImage, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = 3210;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// 本机覆盖配置（不入库、不含在开源仓库里）：
// 在项目根或 userData 放 local.config.json，如 { "proxy": "http://127.0.0.1:7897", "dataDir": "/abs/path/data" }
function loadLocalConfig() {
  const candidates = [
    path.join(PROJECT_ROOT, 'local.config.json'),
    path.join(app.getPath('userData'), 'local.config.json'),
  ];
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { /* 下一个 */ }
  }
  return {};
}
const localConfig = loadLocalConfig();

// 代理：默认不设（多数服务国内直连/用户自建网关各异）；本机需要走代理时写进 local.config.json
const proxy = process.env.HTTPS_PROXY || localConfig.proxy;
if (proxy) {
  process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || proxy;
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;
  process.env.NODE_USE_ENV_PROXY = '1';
}
process.env.PORT = String(PORT);
// 仅主进程与内嵌后端共享；用于没有浏览器 Origin 的生命周期请求。
const INTERNAL_TOKEN = process.env.LEARNLOOP_INTERNAL_TOKEN || crypto.randomBytes(24).toString('hex');
process.env.LEARNLOOP_INTERNAL_TOKEN = INTERNAL_TOKEN;

// 数据目录：env > local.config.json 的 dataDir > 源码模式的项目 data/ > userData/data
function setupDataDir() {
  const devData = path.join(PROJECT_ROOT, 'data');
  process.env.LEARNLOOP_DATA_DIR =
    process.env.LEARNLOOP_DATA_DIR
    || localConfig.dataDir
    || (fs.existsSync(devData) ? devData : null)
    || path.join(app.getPath('userData'), 'data');
}

async function serverAlive() {
  try {
    const res = await fetch(`${ORIGIN}/api/books`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

async function checkpointCurrentChat() {
  try {
    let sessionId = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      const saved = await mainWindow.webContents.executeJavaScript("localStorage.getItem('learnloop.activeChatSession')", true);
      sessionId = Number(saved) || null;
    }
    await fetch(`${ORIGIN}/api/chat/session/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-LearnLoop-Internal': INTERNAL_TOKEN },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(1800),
    });
  } catch { /* 退出与隐藏不能因归档失败卡住 */ }
}

async function ensureServer() {
  if (await serverAlive()) {
    console.log('[learnloop] 复用已在运行的后端');
    return;
  }
  await import(path.join(PROJECT_ROOT, 'server', 'index.js'));
  for (let i = 0; i < 50; i++) {
    if (await serverAlive()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('后端启动超时');
}

let mainWindow = null;
let isQuitting = false;
let quitCheckpointing = false;
let ownsPrimaryInstance = false;
app.on('before-quit', event => {
  if (!ownsPrimaryInstance) { isQuitting = true; return; }
  if (quitCheckpointing) { isQuitting = true; return; }
  event.preventDefault();
  quitCheckpointing = true;
  checkpointCurrentChat().finally(() => {
    isQuitting = true;
    app.quit();
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'LearnOrNot · 学不学',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 22 },
    backgroundColor: '#D8D1C3',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 独立查询参数强制一次真正的冷启动导航，避免 Chromium 沿用上次的 hash 页面。
  win.loadURL(`${ORIGIN}/?desktop=1`);
  // 给红绿灯按钮让出左侧空间（仅 App 内）
  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS('#topbar { padding-left: 96px !important; }');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  const iconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath) && app.dock) app.dock.setIcon(nativeImage.createFromPath(iconPath));

  // 点红叉仍是隐藏窗口；隐藏前软归档当前非空会话，但保持 current 供再次打开/冷启动续聊。
  let hideCheckpointing = false;
  win.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    if (hideCheckpointing) return;
    hideCheckpointing = true;
    checkpointCurrentChat().finally(() => {
      hideCheckpointing = false;
      if (!win.isDestroyed()) win.hide();
    });
  });
  win.on('closed', () => { mainWindow = null; });
  mainWindow = win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  ownsPrimaryInstance = true;
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    app.setName('LearnOrNot');
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'LearnOrNot', submenu: [
        { role: 'about', label: '关于 LearnOrNot' }, { type: 'separator' },
        { role: 'hide', label: '隐藏' }, { role: 'hideOthers', label: '隐藏其他' }, { type: 'separator' },
        { role: 'quit', label: '退出 LearnOrNot' },
      ] },
      { label: '编辑', submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ] },
      { label: '视图', submenu: [
        { role: 'reload', label: '重新加载' }, { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ] },
      { label: '窗口', submenu: [
        { role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' },
      ] },
    ]));
    setupDataDir();
    await ensureServer();
    createWindow();
    app.on('activate', () => {
      if (mainWindow) mainWindow.show();
      else createWindow();
    });
  });

  // macOS 惯例：窗口全关也不退出，驻留 Dock（后端保持运行，再开秒回）
  app.on('window-all-closed', () => { /* stay resident */ });
}
