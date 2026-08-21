// 一次性脚本：用 Electron 离屏渲染把 icon.svg 截成 1024x1024 PNG
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SIZE = 512;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, 'icon-egypt.html'));
  await new Promise(r => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('icon.png written', JSON.stringify(img.getSize()));
  app.quit();
});
