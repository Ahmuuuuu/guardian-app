/**
 * Guardian 教师端桌面程序
 * Electron 窗口加载 http://localhost:3847 的管理界面
 *
 * 启动: npm run desktop  (在 server/ 目录下)
 * 编译: electron-builder 打包为独立 exe
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { getServerEnv } = require('../utils/load-env');

const SERVER_URL = getServerEnv('GUARDIAN_SERVER_URL', 'http://localhost:3847');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Guardian 教师端管控',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadURL(SERVER_URL);

  // 在标题栏显示实际连接的服务器地址
  win.webContents.on('page-title-updated', (e) => e.preventDefault());
  win.on('page-title-updated', () => win.setTitle(`Guardian 教师端管控 - ${SERVER_URL}`));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
