/**
 * Guardian App - 主进程
 * 功能：监控有窗口的进程 + 浏览器URL白名单检测 + 远程管控
 * 设计目标：低资源占用，适配老旧电脑
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const os = require('os');
const iconvLite = require('iconv-lite');

// ============ 编码工具函数 ============
function safeLog(prefix, ...args) {
  const messages = args.map(arg => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  });
  console.log(prefix, ...messages);
}

function safeError(prefix, ...args) {
  const messages = args.map(arg => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch (e) { return String(arg); }
  });
  console.error(prefix, ...messages);
}

// ============ 路径常量（必须在其他代码之前定义） ============
const DATA_DIR = path.join(__dirname, '..', 'data');
const WHITELIST_FILE = path.join(DATA_DIR, 'whitelist.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const REMOTE_CONFIG_FILE = path.join(DATA_DIR, 'remote-config.json');

// ============ 远程管理模块 ============
let remote = null;
let remoteConfig = { enabled: false, serverUrl: '', studentId: '', studentName: '', bindCode: '' };

try {
  remote = require('./remote-client');
} catch (e) {
  safeError('[Remote] 远程模块加载失败:', e.message);
}

function initRemote() {
  try {
    if (fs.existsSync(REMOTE_CONFIG_FILE)) {
      remoteConfig = JSON.parse(fs.readFileSync(REMOTE_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) { }

  if (!remote || !remoteConfig.enabled || !remoteConfig.serverUrl) return;

  safeLog('[Remote] 子机模式已启用，连接:', remoteConfig.serverUrl);

  if (remote && remote.on) {
    remote.on('command', (cmd) => {
      safeLog('[Remote] 收到指令:', cmd.action);
      switch (cmd.action) {
        case 'toggle-guard':
          if (cmd.enabled && !isGuardActive) startGuard();
          else if (!cmd.enabled && isGuardActive) stopGuard();
          break;
        case 'update-whitelist':
          whitelist = { ...whitelist, ...cmd.whitelist };
          fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2), 'utf-8');
          if (mainWindow) mainWindow.webContents.send('whitelist-updated', whitelist);
          break;
        case 'kill-process':
          exec(`taskkill /F /PID ${cmd.pid}`, () => { });
          break;
      }
    });

    remote.on('message', (msg) => {
      if (mainWindow) mainWindow.webContents.send('server-message', msg);
    });

    remote.on('connect', () => {
      if (mainWindow) mainWindow.webContents.send('remote-status', { connected: true });
    });

    remote.on('disconnect', () => {
      if (mainWindow) mainWindow.webContents.send('remote-status', { connected: false });
    });

    remote.connect(remoteConfig.serverUrl);
    if (remoteConfig.studentId) {
      remote.bindStudent(remoteConfig.studentId, remoteConfig.studentName || '');
    }
  }
}

function saveRemoteConfig(newConfig) {
  remoteConfig = { ...remoteConfig, ...newConfig };
  fs.writeFileSync(REMOTE_CONFIG_FILE, JSON.stringify(remoteConfig, null, 2), 'utf-8');
}

// ============ 默认白名单 (进程名 + URL域名) ============
const DEFAULT_WHITELIST = {
  processes: [
    'explorer.exe',
    'guardian-app.exe',
    'electron.exe',
    'Code.exe',
    'notepad.exe',
    'mspaint.exe',
    'calc.exe',
    'cmd.exe',
    'powershell.exe',
    'taskmgr.exe',
    'SystemSettings.exe'
  ],
  urls: [
    'localhost',
    '127.0.0.1',
    'baidu.com',
    'bing.com',
    'qq.com',
    'wechat.com'
  ],
  // 被允许的浏览器进程名（这些浏览器本身可以运行，但访问的URL受限）
  browsers: [
    'chrome.exe',
    'msedge.exe',
    'firefox.exe',
    'opera.exe',
    '360chrome.exe',
    '2345Explorer.exe',
    'liebao.exe',
    'SogouExplorer.exe'
  ]
};

const DEFAULT_CONFIG = {
  enabled: false,           // 守卫是否启用
  checkInterval: 3000,      // 检测间隔(ms)，老旧电脑调大
  killUnknown: false,        // 是否自动结束未知进程（演示模式先关闭）
  notifyOnly: true,          // 仅通知，不强杀
  startWithWindows: false,
  minimizeToTray: true
};

// ============ 全局状态 ============
let mainWindow = null;
let tray = null;
let guardInterval = null;
let whitelist = DEFAULT_WHITELIST;
let config = DEFAULT_CONFIG;
let detectedViolations = [];
let isGuardActive = false;

// ============ 初始化数据目录 ============
function initData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(WHITELIST_FILE)) {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(DEFAULT_WHITELIST, null, 2), 'utf-8');
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
  // 读取已有配置
  try {
    whitelist = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf-8'));
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    safeError('配置读取失败，使用默认值', e);
    whitelist = DEFAULT_WHITELIST;
    config = DEFAULT_CONFIG;
  }
}

// ============ 获取当前所有有窗口的进程 ============
function getWindowedProcesses() {
  return new Promise((resolve) => {
    // 使用 PowerShell 获取有可见窗口的进程
    // Get-Process 过滤 MainWindowHandle != 0 表示有窗口
    // 使用 -Encoding UTF8 强制输出为 UTF-8
    const ps = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object Name,Id,MainWindowTitle | ConvertTo-Json -Compress"`;
    // 使用 utf8 编码直接读取（PowerShell 强制输出 UTF-8）
    exec(ps, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        let data = JSON.parse(stdout.trim());
        // 单个进程时不是数组
        if (!Array.isArray(data)) data = [data];
        resolve(data.map(p => ({
          name: (p.Name || '') + '.exe',
          pid: p.Id,
          title: p.MainWindowTitle || ''
        })));
      } catch (e) {
        safeError('[Encoding] 进程列表解析失败:', e.message);
        resolve([]);
      }
    });
  });
}

// ============ 获取浏览器当前URL (通过窗口标题推断) ============
function extractUrlFromTitle(title) {
  // 主流浏览器标题格式：
  // Chrome: "页面标题 - Google Chrome"
  // Edge:   "页面标题 - Microsoft Edge"
  // Firefox:"页面标题 — Mozilla Firefox"
  // 360:    "页面标题 - 360安全浏览器"
  // 通过 UI Automation 获取地址栏是最准确的，但资源占用高
  // 这里用简化方案：检测标题中是否包含已知违禁关键词
  return title;
}

// ============ 检查进程是否在白名单 ============
function isProcessAllowed(processName) {
  const name = processName.toLowerCase();
  // 系统关键进程直接放行
  const systemProcesses = [
    'system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
    'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'conhost.exe',
    'fontdrvhost.exe', 'sihost.exe', 'taskhostw.exe', 'runtimebroker.exe',
    'shellexperiencehost.exe', 'searchindexer.exe', 'spoolsv.exe',
    'audiodg.exe', 'ctfmon.exe', 'dllhost.exe'
  ];
  if (systemProcesses.includes(name)) return { allowed: true, reason: 'system' };

  // 检查用户白名单
  const allowed = whitelist.processes.some(p => p.toLowerCase() === name) ||
    whitelist.browsers.some(b => b.toLowerCase() === name);
  return { allowed, reason: allowed ? 'whitelist' : 'unknown' };
}

// ============ 结束进程 ============
function killProcess(pid, processName) {
  return new Promise((resolve) => {
    exec(`taskkill /F /PID ${pid}`, (err) => {
      resolve(!err);
    });
  });
}

// ============ 主守卫循环 ============
async function runGuardCheck() {
  if (!isGuardActive) return;

  const processes = await getWindowedProcesses();
  const violations = [];

  for (const proc of processes) {
    const check = isProcessAllowed(proc.name);
    if (!check.allowed) {
      violations.push({
        pid: proc.pid,
        name: proc.name,
        title: proc.title,
        time: new Date().toLocaleTimeString(),
        action: config.killUnknown ? 'killed' : 'detected'
      });

      if (config.killUnknown && !config.notifyOnly) {
        await killProcess(proc.pid, proc.name);
      }
    }
  }

  // 更新检测记录
  if (violations.length > 0) {
    detectedViolations = [...violations, ...detectedViolations].slice(0, 100);
    // 通知渲染进程刷新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('violations-update', violations);
    }
    // 上报到管控服务器
    if (remote && remote.isConnected()) {
      remote.updateStatus({ guardActive: isGuardActive, processCount: processes.length, violations: detectedViolations.slice(0, 10) });
    }
  }

  // 发送进程列表给渲染进程
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('processes-update', processes.map(p => ({
      ...p,
      allowed: isProcessAllowed(p.name).allowed
    })));
  }
}

// ============ 启动/停止守卫 ============
function startGuard() {
  if (guardInterval) clearInterval(guardInterval);
  isGuardActive = true;
  guardInterval = setInterval(runGuardCheck, config.checkInterval);
  runGuardCheck(); // 立即执行一次
  if (mainWindow) mainWindow.webContents.send('guard-status', true);
}

function stopGuard() {
  if (guardInterval) {
    clearInterval(guardInterval);
    guardInterval = null;
  }
  isGuardActive = false;
  if (mainWindow) mainWindow.webContents.send('guard-status', false);
}

// ============ 创建主窗口 ============
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    title: 'Guardian - 访问守卫',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: true,
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (config.minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============ 系统托盘 ============
function createTray() {
  // 用纯色小图标作为托盘图标
  const iconPath = path.join(__dirname, 'renderer', 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Guardian 访问守卫');

  const updateMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: `守卫状态: ${isGuardActive ? '运行中 🟢' : '已停止 🔴'}`, enabled: false },
      { type: 'separator' },
      { label: '显示主界面', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
      { type: 'separator' },
      { label: isGuardActive ? '停止守卫' : '启动守卫', click: () => { isGuardActive ? stopGuard() : startGuard(); updateMenu(); } },
      { type: 'separator' },
      {
        label: '退出 Guardian', click: () => {
          stopGuard();
          if (tray) { tray.destroy(); tray = null; }
          if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
          app.exit(0);  // 强制退出，不等待任何异步事件
        }
      }
    ]);
    tray.setContextMenu(menu);
  };

  updateMenu();
  // 单击也能显示主界面
  tray.on('click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
}

// ============ IPC 通信处理 ============
ipcMain.handle('get-whitelist', () => whitelist);
ipcMain.handle('get-config', () => config);
ipcMain.handle('get-violations', () => detectedViolations);
ipcMain.handle('get-guard-status', () => isGuardActive);

ipcMain.handle('save-whitelist', (_, data) => {
  whitelist = data;
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify(data, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('save-config', (_, data) => {
  config = { ...config, ...data };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  // 如果已启动守卫，重置间隔
  if (isGuardActive) {
    stopGuard();
    startGuard();
  }
  return true;
});

ipcMain.handle('toggle-guard', () => {
  if (isGuardActive) { stopGuard(); return false; }
  else { startGuard(); return true; }
});

ipcMain.handle('get-processes', async () => {
  return await getWindowedProcesses();
});

ipcMain.handle('kill-process', async (_, pid) => {
  return await killProcess(pid, '');
});

ipcMain.handle('clear-violations', () => {
  detectedViolations = [];
  return true;
});

// ============ 远程管控 API ============
ipcMain.handle('get-remote-config', () => {
  return { ...remoteConfig, serverUrl: remoteConfig.serverUrl || '' };
});

ipcMain.handle('save-remote-config', (_, data) => {
  saveRemoteConfig(data);
  if (data.enabled && data.serverUrl && remote) {
    // 重新连接
    if (remote.isConnected()) remote.disconnect();
    remote.connect(data.serverUrl);
  } else if (!data.enabled && remote) {
    remote.disconnect();
  }
  return true;
});

ipcMain.handle('bind-student', async (_, joinCode) => {
  // 向服务器请求绑定
  const http = require('http');
  const urlObj = new URL(remoteConfig.serverUrl);
  const hostname = urlObj.hostname;
  const port = urlObj.port || (urlObj.protocol === 'wss:' ? '443' : '80');
  return new Promise((resolve) => {
    const req = http.request({ hostname, port, path: '/api/student/bind', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) {
            remoteConfig.studentId = r.studentId;
            remoteConfig.studentName = r.studentName;
            saveRemoteConfig(remoteConfig);
            if (remote) remote.bindStudent(r.studentId, r.studentName);
            resolve({ ok: true, studentId: r.studentId, studentName: r.studentName });
          } else {
            resolve({ ok: false, msg: r.msg });
          }
        } catch (e) { resolve({ ok: false, msg: '绑定失败' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, msg: '无法连接管控服务器' }));
    req.write(JSON.stringify({ joinCode, hostname: os.hostname() }));
    req.end();
  });
});

// ============ 应用生命周期 ============
app.whenReady().then(() => {
  initData();
  createWindow();
  createTray();
  initRemote();  // 初始化远程管控连接

  // 如果之前是启动状态，自动恢复
  if (config.autoStart) {
    startGuard();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  stopGuard();
});
