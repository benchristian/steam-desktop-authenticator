const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, dialog, session, screen, desktopCapturer, shell, systemPreferences, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { LoginSession, LoginApprover, EAuthTokenPlatformType, ESessionPersistence } = require('steam-session');
const SteamTotp = require('steam-totp');
const jsQR = require('jsqr');

// 设置进程标题（macOS Dock 悬停显示的名称）
process.title = 'Steam桌面令牌';

// 先设置应用名称（影响 Dock 悬停、菜单栏等处的名称）
app.setName('Steam桌面令牌');

// 固定 userData 路径，避免 app.setName() 改变数据目录
// 必须在 app.getPath('userData') 首次调用之前设置
const USER_DATA_DIR = path.join(app.getPath('appData'), 'steam-desktop-authenticator');
app.setPath('userData', USER_DATA_DIR);

// === 日志重定向到文件（用于调试） ===
const logStream = fs.createWriteStream('/tmp/steam-auth-debug-v5.log', { flags: 'w' });
const origLog = console.log, origError = console.error;
console.log = (...a) => { const m = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '); logStream.write('[L] ' + m + '\n'); origLog.apply(console, a); };
console.error = (...a) => { const m = a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '); logStream.write('[E] ' + m + '\n'); origError.apply(console, a); };
console.log('[main] 日志重定向已启用');

// 代理配置（用于 steam-session 连接 Steam 服务器）
// 可通过环境变量 SOCKS_PROXY 或 HTTP_PROXY 覆盖
// 默认使用系统代理 127.0.0.1:10900（macOS 通常由 Clash/Surge 等代理软件设置）
const PROXY_CONFIG = {
  httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || process.env.https_proxy || 'http://127.0.0.1:10900',
  socksProxy: process.env.SOCKS_PROXY || process.env.socks_proxy || ''
};

// CSV 账号密码文件路径（用于重新登录时自动填充密码）
const CSV_ACCOUNTS_PATH = '/Users/lucidity/CodeBuddy/20260619185425/steam账号.csv';

// 从 CSV 文件中查询账号密码
// CSV 格式：第一行为表头（steam账户,steam密码），后续行为数据
let csvAccountsCache = null;
let csvCacheTime = 0;
function loadCsvAccounts() {
  const now = Date.now();
  // 缓存 30 秒，避免频繁读取磁盘
  if (csvAccountsCache && (now - csvCacheTime) < 30000) {
    return csvAccountsCache;
  }
  try {
    if (!fs.existsSync(CSV_ACCOUNTS_PATH)) {
      console.log('[csv] CSV 文件不存在:', CSV_ACCOUNTS_PATH);
      return null;
    }
    const content = fs.readFileSync(CSV_ACCOUNTS_PATH, 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null;

    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 2) {
        const username = parts[0].trim();
        const password = parts[1].trim();
        if (username && password) {
          map.set(username, password);
        }
      }
    }
    csvAccountsCache = map;
    csvCacheTime = now;
    console.log('[csv] 已加载', map.size, '个账号密码');
    return map;
  } catch (e) {
    console.error('[csv] 读取 CSV 失败:', e.message);
    return null;
  }
}

function queryPasswordFromCsv(accountName) {
  const map = loadCsvAccounts();
  if (!map) return null;
  return map.get(accountName) || null;
}

let mainWindow = null;
let confirmationWindow = null;
let confirmationData = null; // 保存当前确认窗口的账号数据
let bindWindow = null;
let reloginWindow = null;

// 计算子窗口位置：放置在主窗口右侧，间距 20px
function getChildWindowPosition(childWidth, childHeight) {
  if (!mainWindow || mainWindow.isDestroyed()) return undefined;
  const [mainX, mainY] = mainWindow.getPosition();
  const [mainW] = mainWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x: mainX, y: mainY });
  const { x: screenX, y: screenY, width: screenW, height: screenH } = display.workArea;

  let targetX = mainX + mainW + 20;
  let targetY = mainY;

  // 如果右侧空间不足，放到左侧
  if (targetX + childWidth > screenX + screenW) {
    targetX = mainX - childWidth - 20;
    if (targetX < screenX) targetX = screenX + 20;
  }

  // 确保不超出屏幕底部
  if (targetY + childHeight > screenY + screenH) {
    targetY = screenY + screenH - childHeight;
  }
  // 确保不超出屏幕顶部
  if (targetY < screenY) targetY = screenY;

  return { x: Math.round(targetX), y: Math.round(targetY) };
}
let tray = null;
let isQuitting = false;

const DATA_FILE = path.join(app.getPath('userData'), 'maFiles');

// Steam API
const STEAM_API = 'api.steampowered.com';
const STEAM_COMMUNITY = 'steamcommunity.com';

// 获取 LoginSession 的代理选项
function getSessionOptions() {
  if (PROXY_CONFIG.socksProxy) {
    return { socksProxy: PROXY_CONFIG.socksProxy };
  }
  if (PROXY_CONFIG.httpProxy) {
    return { httpProxy: PROXY_CONFIG.httpProxy };
  }
  return {};
}

// ============ 窗口管理 ============
function createWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  const iconPath = path.join(__dirname, 'icon.png');
  mainWindow = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 400,
    minHeight: 550,
    title: 'Steam 桌面令牌验证器',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    resizable: true,
    backgroundColor: isDark ? '#0a0e14' : '#f6f8fa',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  mainWindow.loadFile('index.html');

  mainWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============ 交易确认独立窗口 ============
function createConfirmationWindow(data, theme) {
  // 如果已存在，先关闭
  if (confirmationWindow && !confirmationWindow.isDestroyed()) {
    confirmationWindow.focus();
    // 发送新的账号数据
    confirmationWindow.webContents.send('confirmation-data', data);
    confirmationData = data;
    return;
  }

  confirmationData = data;

  const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  const iconPath = path.join(__dirname, 'icon.png');
  confirmationWindow = new BrowserWindow({
    width: 520,
    height: 500,
    minWidth: 420,
    minHeight: 380,
    title: '交易确认 - ' + (data.accountName || data.steamId || ''),
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    resizable: true,
    parent: mainWindow,
    modal: false,
    show: false,
    backgroundColor: isDark ? '#161b22' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  confirmationWindow.loadFile('confirmation.html');

  // 在 DOM 就绪但首次绘制前，立即注入正确的主题
  confirmationWindow.webContents.once('dom-ready', () => {
    const actualTheme = isDark ? 'dark' : 'light';
    confirmationWindow.webContents.executeJavaScript(`
      document.documentElement.setAttribute('data-theme', '${actualTheme}');
    `);
  });

  confirmationWindow.once('ready-to-show', () => {
    const pos = getChildWindowPosition(520, 500);
    if (pos) confirmationWindow.setPosition(pos.x, pos.y);
    confirmationWindow.show();
    // 同步主题到子窗口
    confirmationWindow.webContents.send('theme-changed', theme || 'system');
    // 窗口准备好后发送数据
    confirmationWindow.webContents.send('confirmation-data', data);
  });

  confirmationWindow.on('closed', () => {
    confirmationWindow = null;
    confirmationData = null;
  });
}

// ============ 绑定账号独立窗口 ============
function createBindWindow(theme) {
  if (bindWindow && !bindWindow.isDestroyed()) {
    bindWindow.focus();
    return;
  }

  const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  const iconPath = path.join(__dirname, 'icon.png');
  bindWindow = new BrowserWindow({
    width: 480,
    height: 700,
    minWidth: 400,
    minHeight: 550,
    title: '绑定 Steam 令牌',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    resizable: true,
    parent: mainWindow,
    modal: false,
    show: false,
    backgroundColor: isDark ? '#161b22' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  bindWindow.loadFile('bind.html');

  // 在 DOM 就绪但首次绘制前，立即注入正确的主题
  // 这比 ready-to-show 更早，确保渲染时就用正确的主题
  bindWindow.webContents.once('dom-ready', () => {
    const actualTheme = isDark ? 'dark' : 'light';
    bindWindow.webContents.executeJavaScript(`
      document.documentElement.setAttribute('data-theme', '${actualTheme}');
    `);
  });

  bindWindow.once('ready-to-show', () => {
    const pos = getChildWindowPosition(480, 700);
    if (pos) bindWindow.setPosition(pos.x, pos.y);
    bindWindow.show();
    // 再次同步主题到子窗口（确保一致性）
    bindWindow.webContents.send('theme-changed', theme || 'system');
  });

  bindWindow.on('closed', () => {
    bindWindow = null;
  });
}

// ============ 重新登录独立窗口 ============
function createReloginWindow(data, theme) {
  // 从 CSV 查询密码（新窗口和已有窗口都需要）
  if (data && data.accountName) {
    const csvPassword = queryPasswordFromCsv(data.accountName);
    if (csvPassword) {
      data.autoPassword = csvPassword;
      console.log('[relogin] CSV 中找到账号密码:', data.accountName);
    } else {
      console.log('[relogin] CSV 中未找到账号密码:', data.accountName);
    }
  } else {
    console.log('[relogin] data 中没有 accountName，跳过 CSV 查询');
  }

  if (reloginWindow && !reloginWindow.isDestroyed()) {
    reloginWindow.focus();
    // 同步更新 pendingReloginData，确保方式4（requestReloginData）也能拿到密码
    pendingReloginData = data;
    console.log('[relogin] 复用已有窗口，发送 relogin-init, autoPassword:', data.autoPassword ? '有' : '无');
    // 重新发送初始化数据
    reloginWindow.webContents.send('relogin-init', data);
    return;
  }

  const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  const iconPath = path.join(__dirname, 'icon.png');
  reloginWindow = new BrowserWindow({
    width: 460,
    height: 520,
    minWidth: 380,
    minHeight: 420,
    title: '重新登录获取令牌',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    resizable: true,
    parent: mainWindow,
    modal: false,
    show: false,
    backgroundColor: isDark ? '#161b22' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  reloginWindow.loadFile('steam-relogin.html');

  // 在 DOM 就绪但首次绘制前，立即注入正确的主题
  reloginWindow.webContents.once('dom-ready', () => {
    const actualTheme = isDark ? 'dark' : 'light';
    reloginWindow.webContents.executeJavaScript(`
      document.documentElement.setAttribute('data-theme', '${actualTheme}');
    `);
  });

  // 使用 ready-to-show 确保首帧渲染完成后才显示窗口，防止闪黑
  reloginWindow.once('ready-to-show', () => {
    const pos = getChildWindowPosition(460, 520);
    if (pos) reloginWindow.setPosition(pos.x, pos.y);
    reloginWindow.show();
    // 同步主题到子窗口（确保一致性）
    reloginWindow.webContents.send('theme-changed', theme || 'system');

    // 从 CSV 查询密码，自动填充到重新登录窗口
    if (data && data.accountName) {
      const csvPassword = queryPasswordFromCsv(data.accountName);
      if (csvPassword) {
        data.autoPassword = csvPassword;
        console.log('[relogin] CSV 中找到账号密码:', data.accountName);
      }
    }

    // 将数据注入为全局变量，渲染进程直接读取
    const dataJson = JSON.stringify(data);
    reloginWindow.webContents.executeJavaScript(`
      window.__reloginData = ${dataJson};
      window.dispatchEvent(new CustomEvent('relogin-data-ready', { detail: ${dataJson} }));
    `);
  });

  reloginWindow.on('closed', () => {
    reloginWindow = null;
  });
}

// ============ Tray ============
function createTray() {
  const size = 16;
  const imgBuffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const cx = size / 2, cy = size / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < size / 2 - 1) {
        imgBuffer[idx] = 0x1a; imgBuffer[idx+1] = 0x9f;
        imgBuffer[idx+2] = 0xff; imgBuffer[idx+3] = 255;
      } else {
        imgBuffer[idx+3] = 0;
      }
    }
  }
  const icon = nativeImage.createFromBuffer(imgBuffer, { width: size, height: size });
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  updateTrayMenu();
  tray.setToolTip('Steam桌面令牌');
  tray.on('click', () => {
    if (mainWindow) mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function updateTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示/隐藏', click: () => { if (mainWindow) mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); }},
    { type: 'separator' },
    { label: '复制最新验证码', click: () => { mainWindow?.webContents.send('copy-latest-code'); }},
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); }}
  ]));
}

// ============ 数据存储 ============
// 一次性迁移：修复已保存 maFile 中 steamLoginSecure 的错误 SteamID 前缀
function migrateFixSteamLoginSecureCookies() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const files = fs.readdirSync(DATA_FILE).filter(f => f.endsWith('.maFile'));
    let fixedCount = 0;
    for (const file of files) {
      const filePath = path.join(DATA_FILE, file);
      const rawContent = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(rawContent);
      const steamId = data.SteamID || (data.Session && data.Session.SteamID);
      const webCookies = data.web_cookies || '';
      if (!steamId || !webCookies) continue;
      const fixed = fixSteamLoginSecureCookie(webCookies, String(steamId));
      if (fixed !== webCookies) {
        data.web_cookies = fixed;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        fixedCount++;
        console.log('[migrate] 修复 cookie 前缀:', file);
      }
    }
    if (fixedCount > 0) console.log('[migrate] 共修复', fixedCount, '个 maFile 的 steamLoginSecure');
  } catch (e) {
    console.error('[migrate] 修复 cookie 前缀失败:', e.message);
  }
}

function loadAccounts() {
  try {
    if (!fs.existsSync(DATA_FILE)) fs.mkdirSync(DATA_FILE, { recursive: true });
    const files = fs.readdirSync(DATA_FILE).filter(f => f.endsWith('.maFile'));
    const accounts = [];
    let autoFixedCount = 0;
    for (const file of files) {
      const filePath = path.join(DATA_FILE, file);
      const rawContent = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(rawContent);

      // ── 启动时 SteamID 一致性校验 ──
      // 从 JWT（access_token 或 web_cookies 或 Session.SteamLoginSecure）提取权威 SteamID
      let authoritativeSteamId = null;
      if (data.access_token) {
        authoritativeSteamId = parseSteamIdFromToken(data.access_token);
      }
      if (!authoritativeSteamId && data.web_cookies) {
        authoritativeSteamId = getSteamIdFromWebCookie(data.web_cookies);
      }
      if (!authoritativeSteamId && data.Session && data.Session.SteamLoginSecure) {
        // Session.SteamLoginSecure 格式也是 "steamId||JWT" 或 "steamId%7C%7CJWT"
        authoritativeSteamId = getSteamIdFromWebCookie('steamLoginSecure=' + data.Session.SteamLoginSecure);
        if (authoritativeSteamId) {
          console.log('[loadAccounts] 从 Session.SteamLoginSecure 解析权威 SteamID:', authoritativeSteamId);
        }
      }
      if (!authoritativeSteamId && data.Session && data.Session.SteamLogin) {
        authoritativeSteamId = getSteamIdFromWebCookie('steamLoginSecure=' + data.Session.SteamLogin);
      }

      // 用正则从原始 JSON 文本中提取顶层 SteamID（避免 JSON.parse 大整数精度丢失）
      const topMatch = rawContent.match(/"SteamID":\s*"(\d+)"/);
      if (topMatch) {
        data.SteamID = topMatch[1]; // 字符串，精确值
      } else if (data.SteamID && typeof data.SteamID === 'number') {
        const numMatch = rawContent.match(/"SteamID":\s*(\d+)/);
        data.SteamID = numMatch ? numMatch[1] : String(data.SteamID);
      }

      // Session.SteamID 也确保为字符串
      if (data.Session && data.Session.SteamID !== undefined) {
        data.Session.SteamID = String(data.Session.SteamID);
      }

      // 如果 JWT 中有权威 SteamID，检查并自动修复不一致
      if (authoritativeSteamId) {
        let needsFix = false;
        if (String(data.SteamID) !== String(authoritativeSteamId)) {
          console.warn('[loadAccounts] ⚠️ 文件', file, 'SteamID 不一致，自动修复:', data.SteamID, '→', authoritativeSteamId);
          data.SteamID = authoritativeSteamId;
          needsFix = true;
        }
        if (data.Session && String(data.Session.SteamID) !== String(authoritativeSteamId)) {
          console.warn('[loadAccounts] ⚠️ 文件', file, 'Session.SteamID 不一致，自动修复:', data.Session.SteamID, '→', authoritativeSteamId);
          data.Session.SteamID = authoritativeSteamId;
          needsFix = true;
        }
        // web_cookies 中的 steamLoginSecure 前缀也必须一致
        if (data.web_cookies) {
          const fixedCookies = fixSteamLoginSecureCookie(data.web_cookies, authoritativeSteamId);
          if (fixedCookies !== data.web_cookies) {
            console.warn('[loadAccounts] ⚠️ 文件', file, 'web_cookies steamLoginSecure 前缀不一致，自动修复为:', authoritativeSteamId);
            data.web_cookies = fixedCookies;
            needsFix = true;
          }
        }
        // 文件名也可能不一致，修复后重命名
        const expectedFilename = `${authoritativeSteamId}.maFile`;
        if (file !== expectedFilename) {
          console.warn('[loadAccounts] ⚠️ 文件名不一致，自动修复:', file, '→', expectedFilename);
          needsFix = true;
        }
        if (needsFix) {
          // 写回修复后的数据到新文件名
          const targetPath = path.join(DATA_FILE, expectedFilename);
          fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf-8');
          if (file !== expectedFilename && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          autoFixedCount++;
        }
      }

      accounts.push(data);
    }
    if (autoFixedCount > 0) {
      console.log('[loadAccounts] ✅ 启动时自动修复了', autoFixedCount, '个账号的 SteamID 不一致');
    }
    return accounts;
  } catch (err) {
    console.error('加载账号失败:', err);
    return [];
  }
}

function saveAccount(accountData) {
  try {
    if (!fs.existsSync(DATA_FILE)) fs.mkdirSync(DATA_FILE, { recursive: true });

    // ── 核心：从 JWT 中提取权威 SteamID ──
    // JWT 中的 sub 是 Steam 服务器签发的唯一可信 SteamID
    // 优先级: access_token > web_cookies > 原有字段
    let authoritativeSteamId = null;

    // 1. 从 access_token JWT 解析
    if (accountData.access_token) {
      authoritativeSteamId = parseSteamIdFromToken(accountData.access_token);
      if (authoritativeSteamId) {
        console.log('[saveAccount] 从 access_token JWT 解析权威 SteamID:', authoritativeSteamId);
      }
    }

    // 2. 降级：从 web_cookies 的 steamLoginSecure JWT 解析
    if (!authoritativeSteamId && accountData.web_cookies) {
      authoritativeSteamId = getSteamIdFromWebCookie(accountData.web_cookies);
      if (authoritativeSteamId) {
        console.log('[saveAccount] 从 web_cookies JWT 解析权威 SteamID:', authoritativeSteamId);
      }
    }

    // 3. 如果从 JWT 获取到了权威 SteamID，统一所有字段
    const oldSteamId = accountData.SteamID || accountData.steamid || (accountData.Session && accountData.Session.SteamID);
    if (authoritativeSteamId && String(oldSteamId) !== String(authoritativeSteamId)) {
      console.warn('[saveAccount] ⚠️ SteamID 不一致！旧值:', oldSteamId, '→ 权威值(JWT):', authoritativeSteamId, '已自动修复');
      accountData.SteamID = authoritativeSteamId;
      if (accountData.Session) {
        accountData.Session.SteamID = authoritativeSteamId;
      }
      // 如果旧文件存在，先删除（避免残留错误文件）
      if (oldSteamId) {
        const oldPath = path.join(DATA_FILE, `${oldSteamId}.maFile`);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
          console.log('[saveAccount] 已删除旧文件:', `${oldSteamId}.maFile`);
        }
      }
    }

    // 确保顶层和 Session 中的 SteamID 都是字符串（防止 JSON 序列化时精度丢失）
    if (accountData.SteamID && typeof accountData.SteamID === 'number') {
      accountData.SteamID = String(accountData.SteamID);
    }
    if (accountData.Session && accountData.Session.SteamID && typeof accountData.Session.SteamID === 'number') {
      accountData.Session.SteamID = String(accountData.Session.SteamID);
    }
    if (!accountData.SteamID && !accountData.steamid && accountData.Session && accountData.Session.SteamID) {
      accountData.SteamID = String(accountData.Session.SteamID);
    }

    // 用修复后的权威 SteamID 生成文件名
    const steamId = accountData.SteamID || accountData.steamid || (accountData.Session && accountData.Session.SteamID);
    const filename = `${steamId || accountData.account_name || 'unknown'}.maFile`;
    fs.writeFileSync(path.join(DATA_FILE, filename), JSON.stringify(accountData, null, 2), 'utf-8');
    console.log('[saveAccount] 已保存:', filename);
    return true;
  } catch (err) {
    console.error('保存账号失败:', err);
    return false;
  }
}

function deleteAccountFile(steamId) {
  try {
    const files = fs.readdirSync(DATA_FILE);
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_FILE, file), 'utf-8'));
      const dataSteamId = data.SteamID || data.steamid || (data.Session && data.Session.SteamID);
      if (String(dataSteamId) === String(steamId)) {
        fs.unlinkSync(path.join(DATA_FILE, file));
        return true;
      }
    }
  } catch (err) {
    console.error('删除账号失败:', err);
  }
  return false;
}

// 更新已有 maFile 中的 access_token 和 webCookies 字段
function updateAccountAccessToken(steamId, accessToken, webCookies) {
  try {
    if (!steamId || !accessToken) {
      console.error('[updateAccountAccessToken] 参数无效: steamId=', steamId, 'accessToken=', accessToken ? '***' : 'null');
      return false;
    }
    const authoritativeSteamId = parseSteamIdFromToken(accessToken);
    const files = fs.readdirSync(DATA_FILE);
    let matchedFile = null;
    let matchedData = null;
    let matchedPath = null;

    // 辅助：获取文件中的 SteamID
    const getFileSteamId = (data) => data.SteamID || data.steamid || (data.Session && data.Session.SteamID);

    // 1. 先尝试用传入的 steamId 精确匹配
    for (const file of files) {
      if (!file.endsWith('.maFile')) continue;
      const filePath = path.join(DATA_FILE, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (String(getFileSteamId(data)) === String(steamId)) {
        matchedFile = file;
        matchedData = data;
        matchedPath = filePath;
        break;
      }
    }

    // 2. 如果失败，尝试用 JWT 中的权威 SteamID 匹配（处理本地精度丢失/文件损坏的情况）
    if (!matchedFile && authoritativeSteamId) {
      for (const file of files) {
        if (!file.endsWith('.maFile')) continue;
        const filePath = path.join(DATA_FILE, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const fileSteamId = getFileSteamId(data);
        // 文件中的 SteamID 与权威值一致，或文件名为旧值但数据权威值一致
        if (String(fileSteamId) === String(authoritativeSteamId)) {
          matchedFile = file;
          matchedData = data;
          matchedPath = filePath;
          console.log('[updateAccountAccessToken] 用 JWT 权威 SteamID 匹配到文件:', file);
          break;
        }
        // 文件名是旧错误值（如 76561199268458480.maFile），但内部已有权威 SteamID 字段
        const fileNameSid = file.replace('.maFile', '');
        if (String(fileNameSid) === String(steamId) && String(fileSteamId) === String(authoritativeSteamId)) {
          matchedFile = file;
          matchedData = data;
          matchedPath = filePath;
          console.log('[updateAccountAccessToken] 用文件名匹配到文件:', file);
          break;
        }
      }
    }

    if (!matchedFile) {
      console.error('[updateAccountAccessToken] 未找到匹配的 maFile, steamId=', steamId, 'authoritative=', authoritativeSteamId);
      return false;
    }

    const correctSteamId = authoritativeSteamId || String(steamId);
    matchedData.access_token = accessToken;
    if (webCookies) {
      matchedData.web_cookies = fixSteamLoginSecureCookie(webCookies, correctSteamId);
    }

    // 统一 SteamID 字段为权威值
    if (String(matchedData.SteamID) !== String(correctSteamId)) {
      console.warn('[updateAccountAccessToken] ⚠️ 修正 SteamID:', matchedData.SteamID, '→', correctSteamId);
      matchedData.SteamID = correctSteamId;
    }
    if (matchedData.Session && String(matchedData.Session.SteamID) !== String(correctSteamId)) {
      console.warn('[updateAccountAccessToken] ⚠️ 修正 Session.SteamID:', matchedData.Session.SteamID, '→', correctSteamId);
      matchedData.Session.SteamID = correctSteamId;
    }

    // 同步修正 Session.SteamLogin / SteamLoginSecure 的 SteamID 前缀
    if (matchedData.Session) {
      for (const key of ['SteamLogin', 'SteamLoginSecure']) {
        const val = matchedData.Session[key];
        if (typeof val === 'string') {
          const sep = val.includes('%7C%7C') ? val.indexOf('%7C%7C') : val.indexOf('||');
          if (sep !== -1) {
            const prefix = val.substring(0, sep);
            if (String(prefix) !== String(correctSteamId)) {
              console.warn('[updateAccountAccessToken] ⚠️ 修正 Session.' + key + ' 前缀:', prefix, '→', correctSteamId);
              matchedData.Session[key] = correctSteamId + val.substring(sep);
            }
          }
        }
      }
    }

    // 保存到正确的文件名
    const expectedFilename = `${correctSteamId}.maFile`;
    const targetPath = path.join(DATA_FILE, expectedFilename);
    if (matchedFile !== expectedFilename) {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      fs.writeFileSync(targetPath, JSON.stringify(matchedData, null, 2), 'utf-8');
      fs.unlinkSync(matchedPath);
      console.log('[updateAccountAccessToken] 文件已重命名并修复:', matchedFile, '->', expectedFilename);
    } else {
      fs.writeFileSync(matchedPath, JSON.stringify(matchedData, null, 2), 'utf-8');
      console.log('[updateAccountAccessToken] 已更新', matchedFile, '的 access_token' + (webCookies ? ' + web_cookies' : ''));
    }
    return true;
  } catch (err) {
    console.error('[updateAccountAccessToken] 失败:', err.message);
    return false;
  }
}

// ============ Steam API ============
function steamApiRequest(method, endpoint, params, cookies, accessToken, extraHeaders) {
  return new Promise((resolve, reject) => {
    // access_token 放在 URL query string 中（与 node-steamcommunity 一致）
    let queryParts = [];
    if (accessToken) {
      queryParts.push(`access_token=${encodeURIComponent(accessToken)}`);
    }

    const reqPath = queryParts.length > 0
      ? `${endpoint}?${queryParts.join('&')}`
      : endpoint;

    let body = '';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Host': STEAM_API
    };
    if (cookies) {
      headers['Cookie'] = cookies;
    }
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }
    if (method === 'POST' && params && Object.keys(params).length > 0) {
      body = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    // 有 HTTP 代理时：先建立 CONNECT 隧道，再通过隧道发 HTTPS
    if (PROXY_CONFIG.httpProxy) {
      try {
        const proxyUrl = new URL(PROXY_CONFIG.httpProxy);
        const proxyHost = proxyUrl.hostname;
        const proxyPort = parseInt(proxyUrl.port) || 80;

        const http = require('http');
        const connectReq = http.request({
          hostname: proxyHost,
          port: proxyPort,
          method: 'CONNECT',
          path: `${STEAM_API}:443`,
          headers: {
            'Host': `${STEAM_API}:443`,
            'User-Agent': headers['User-Agent']
          }
        });

        connectReq.on('connect', (res, socket) => {
          // 通过已建立的隧道发送 HTTPS 请求
          const httpsOpts = {
            socket: socket,
            hostname: STEAM_API,
            path: reqPath,
            method: method,
            headers: headers
          };

          const httpsReq = https.request(httpsOpts, (httpsRes) => {
            let data = '';
            httpsRes.on('data', chunk => data += chunk);
            httpsRes.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, statusCode: httpsRes.statusCode }); }
            });
          });
          httpsReq.on('error', (err) => {
            console.error('[steamApiRequest] HTTPS through proxy error:', err.message);
            reject(err);
          });
          httpsReq.end(body || undefined);
        });

        connectReq.on('error', (err) => {
          console.error('[steamApiRequest] CONNECT error:', err.message);
          reject(err);
        });
        connectReq.end();
        return;
      } catch (e) {
        console.error('[steamApiRequest] 代理配置解析失败:', e.message);
        reject(e);
        return;
      }
    }

    // 直连模式
    const options = {
      hostname: STEAM_API,
      path: reqPath,
      method: method,
      headers: headers,
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, statusCode: res.statusCode }); }
      });
    });
    req.on('timeout', () => {
      console.error('[steamApiRequest] 请求超时');
      req.destroy();
      reject(new Error('请求超时（30秒）'));
    });
    req.on('error', (err) => {
      console.error('[steamApiRequest] 请求失败:', err.message);
      reject(err);
    });
    req.end(body || undefined);
  });
}

  // 请求 steamcommunity.com（用于 mobileconf 等端点），支持代理
// options.rawResponse: 如果为 true，返回原始响应字符串而不是 JSON 解析后的对象
function steamCommunityRequest(method, path, params, cookies, referer, options) {
  return new Promise((resolve, reject) => {
    let body = '';
    const rawResponse = options && options.rawResponse;
    const REQUEST_TIMEOUT = 15000; // 15 秒超时
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': rawResponse ? 'text/html, */*' : 'application/json',
      'Host': STEAM_COMMUNITY
    };
    if (cookies) {
      headers['Cookie'] = cookies;
    }
    if (referer) {
      headers['Referer'] = referer;
    }
    if (method === 'POST' && params && Object.keys(params).length > 0) {
      body = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    if (PROXY_CONFIG.httpProxy) {
      try {
        const proxyUrl = new URL(PROXY_CONFIG.httpProxy);
        const proxyHost = proxyUrl.hostname;
        const proxyPort = parseInt(proxyUrl.port) || 80;
        const http = require('http');

        const connectReq = http.request({
          hostname: proxyHost,
          port: proxyPort,
          method: 'CONNECT',
          path: `${STEAM_COMMUNITY}:443`,
          headers: { 'Host': `${STEAM_COMMUNITY}:443`, 'User-Agent': headers['User-Agent'] }
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          connectReq.destroy();
          reject(new Error('请求超时'));
        }, REQUEST_TIMEOUT);

        connectReq.on('connect', (res, socket) => {
          if (timedOut) return;
          clearTimeout(timer);
          const httpsReq = https.request({
            socket, hostname: STEAM_COMMUNITY, path, method, headers
          }, (httpsRes) => {
            let data = '';
            httpsRes.on('data', chunk => data += chunk);
            httpsRes.on('end', () => {
              if (rawResponse) { resolve(data); }
              else { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, statusCode: httpsRes.statusCode }); } }
            });
          });
          httpsReq.on('error', (err) => { if (!timedOut) reject(err); });
          httpsReq.end(body || undefined);
        });
        connectReq.on('error', (err) => { if (!timedOut) reject(err); });
        connectReq.end();
        return;
      } catch (e) {
        reject(e);
        return;
      }
    }

    // 直连
    let timedOut = false;
    const req = https.request({
      hostname: STEAM_COMMUNITY, path, method, headers
    }, (res) => {
      if (timedOut) return;
      clearTimeout(timer);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (rawResponse) { resolve(data); }
        else { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data, statusCode: res.statusCode }); } }
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new Error('请求超时'));
    }, REQUEST_TIMEOUT);
    req.on('error', (err) => { if (!timedOut) reject(err); });
    req.end(body || undefined);
  });
}

async function addAuthenticator(accessToken, steamId) {
  console.log('[addAuthenticator] accessToken 前20字符:', accessToken ? accessToken.substring(0, 20) + '...' : '(空)');
  console.log('[addAuthenticator] steamId:', steamId, '类型:', typeof steamId);
  const params = {
    steamid: steamId,
    authenticator_type: 1,
    device_identifier: generateDeviceId(steamId),
    sms_phone_id: 1,
    version: 2
  };
  const result = await steamApiRequest('POST', '/ITwoFactorService/AddAuthenticator/v1/', params, null, accessToken);
  console.log('[addAuthenticator] 原始响应 statusCode:', result.statusCode, 'has raw:', !!result.raw, 'has response:', !!result.response);
  if (result.raw) {
    console.error('[addAuthenticator] 非JSON响应, 前300字符:', String(result.raw).substring(0, 300));
  }
  return result;
}

async function finalizeWithCode(accessToken, steamId, code, codeType, sharedSecret) {
  // 参考 node-steamcommunity 的实现：
  // 1. 先用 steam-totp 获取时间偏移
  // 2. 用 sharedSecret + 时间偏移生成 authenticator_code
  // 3. 如果 want_more=true，diff += 30 重试，最多 30 次
  // 4. status=89 表示激活码无效，直接失败

  const maxTries = 10; // 减少重试次数，避免卡住太久
  let diff = 0;

  // 获取与 Steam 服务器的时间偏移（使用 steam-totp）
  try {
    diff = await new Promise((resolve) => {
      SteamTotp.getTimeOffset((err, offset) => {
        if (err) { console.warn('[finalize] getTimeOffset error:', err.message); resolve(0); }
        else { resolve(offset); }
      });
    });
    console.log('[finalize] Steam time offset:', diff, 'seconds');
  } catch (e) {
    console.warn('[finalize] 获取时间偏移失败，使用本地时间:', e.message);
  }

  for (let attempts = 0; attempts < maxTries; attempts++) {
    const authCode = sharedSecret
      ? generateSteamGuardCode(sharedSecret, diff).code
      : '';

    const params = {
      steamid: steamId,
      authenticator_code: authCode,
      authenticator_time: Math.floor(Date.now() / 1000),
      activation_code: code
    };

    // 注意：validate_sms_code 仅用于短信验证，邮箱验证不需要
    // 邮箱验证码通过 activation_code 传入即可
    if (codeType === 'sms') {
      params.validate_sms_code = 1;
    }

    console.log(`[finalize] attempt ${attempts + 1}/${maxTries}, diff=${diff}, authCode=${authCode}`);

    const result = await steamApiRequest('POST', '/ITwoFactorService/FinalizeAddAuthenticator/v1/', params, null, accessToken);

    if (!result.response) {
      console.log('[finalize] No response field:', JSON.stringify(result));
      return result;
    }

    const resp = result.response;

    // 使用服务器返回的时间来校准
    if (resp.server_time) {
      diff = resp.server_time - Math.floor(Date.now() / 1000);
      console.log('[finalize] Server time calibration, new diff:', diff);
    }

    if (resp.status === 89) {
      // 激活码无效（验证码错误或过期）
      console.log('[finalize] Invalid activation code (status=89)');
      return result;
    }

    if (resp.want_more) {
      // 需要更多尝试，增加时间偏移
      console.log(`[finalize] want_more=true, retry with diff += 30`);
      diff += 30;
      continue;
    }

    if (!resp.success) {
      console.log(`[finalize] Failed, status=${resp.status}, message=${resp.message}`);
      return result;
    }

    // success = true，完成！
    console.log('[finalize] Success!');
    return result;
  }

  console.log('[finalize] Max retries reached');
  return { response: { status: 88, message: '无法生成正确的验证码（时间同步问题，已重试' + maxTries + '次）' } };
}



// 从 Steam web cookie 的 steamLoginSecure JWT 中解析 sub（即 Steam 登录态实际身份）
// 从 Steam web cookie 的 steamLoginSecure JWT 中解析 sub（即 Steam 登录态实际身份）
function getSteamIdFromWebCookie(webCookies) {
  if (!webCookies) return null;
  try {
    const match = webCookies.match(/steamLoginSecure=([^;]+)/);
    if (!match) return null;
    let value = decodeURIComponent(match[1]);
    // 值格式: "steamId||JWT" 或 "steamId%7C%7CJWT"（已经 decodeURIComponent 后变成 "steamId||JWT"）
    const sepIdx = value.indexOf('||');
    if (sepIdx === -1) return null;
    const jwt = value.substring(sepIdx + 2);
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    payload += '='.repeat((4 - payload.length % 4) % 4);
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    return decoded.sub || null;
  } catch (e) {
    return null;
  }
}

// 为交易确认统一 cookie 中 steamLoginSecure 的前缀与 JWT sub，解决 steam-session 生成的 access_token sub 错误问题
function getEffectiveConfirmationCookies(webCookies, steamId) {
  if (!webCookies) return { effectiveSteamId: steamId, effectiveCookies: webCookies };
  const cookieSub = getSteamIdFromWebCookie(webCookies);
  if (!cookieSub || String(cookieSub) === String(steamId)) {
    return { effectiveSteamId: steamId, effectiveCookies: webCookies };
  }
  const prefixMatch = webCookies.match(/steamLoginSecure=(\d+)/);
  const cookiePrefix = prefixMatch ? prefixMatch[1] : null;
  let effectiveCookies = webCookies;
  if (cookiePrefix && String(cookiePrefix) !== String(cookieSub)) {
    effectiveCookies = webCookies.replace(/(steamLoginSecure=)\d+/, `$1${cookieSub}`);
    console.log(`[getEffectiveConfirmationCookies] cookie 前缀与 JWT sub 不一致 (prefix=${cookiePrefix}, sub=${cookieSub}), 已统一为 sub`);
  }
  console.log(`[getEffectiveConfirmationCookies] 使用 cookie 中的 SteamID: ${cookieSub}`);
  return { effectiveSteamId: cookieSub, effectiveCookies };
}


function generateDeviceId(steamId) {
  // 使用 steam-totp 的 getDeviceID，与 node-steamcommunity / SDA 保持一致
  try {
    return SteamTotp.getDeviceID({ getSteamID64: () => steamId.toString() });
  } catch (e) {
    // 降级方案
    const hash = crypto.createHash('sha256').update(steamId.toString()).digest('hex');
    return `android:${hash.substr(0,8)}-${hash.substr(8,4)}-${hash.substr(12,4)}-${hash.substr(16,4)}-${hash.substr(20,12)}`;
  }
}

// ============ TOTP ============
// 直接使用 steam-totp 库（与 node-steamcommunity 一致）
function generateSteamGuardCode(sharedSecret, timeOffset = 0) {
  if (!sharedSecret) throw new Error('shared_secret 不能为空');
  const code = SteamTotp.generateAuthCode(sharedSecret, timeOffset);
  const currentTime = SteamTotp.time(timeOffset);
  const timeRemaining = 30 - (currentTime % 30);
  return { code, timeRemaining, period: 30 };
}

function isValidSecret(secret) {
  if (!secret || typeof secret !== 'string') return false;
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(secret)) return false;
  try {
    const bytes = Buffer.from(secret, 'base64');
    return bytes.length > 0;
  } catch { return false; }
}

// steam-session 的 session.steamID 存在 off-by-one bug，返回的 SteamID 比实际多 1
// 从 JWT access token 中解析正确的 SteamID64
function parseSteamIdFromToken(accessToken) {
  if (!accessToken) return null;
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    // 补齐 base64 padding
    payload += '='.repeat((4 - payload.length % 4) % 4);
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    return decoded.sub || null;
  } catch (e) {
    console.error('[parseSteamIdFromToken] 解析失败:', e.message);
    return null;
  }
}

// 修复 steam-session 生成的 steamLoginSecure cookie 中错误的 SteamID 前缀
// cookie 值可能是 "steamId||JWT" 或 URL 编码的 "steamId%7C%7CJWT"
function fixSteamLoginSecureCookie(webCookies, correctSteamId) {
  if (!webCookies || !correctSteamId) return webCookies;
  return webCookies
    .replace(/(steamLoginSecure=)\d+(\|\|)/, `$1${correctSteamId}$2`)
    .replace(/(steamLoginSecure=)\d+(%7C%7C)/, `$1${correctSteamId}$2`);
}

// ============ 移除令牌 ============
// Steam API: POST /ITwoFactorService/RemoveAuthenticator/v1/
// 参数: steamid, revocation_code, steamguard_scheme=2, steamguard_code, access_token
async function removeAuthenticator(accessToken, steamId, revocationCode, sharedSecret) {
  // 生成当前 TOTP 作为 steamguard_code
  const guardCode = generateSteamGuardCode(sharedSecret).code;
  const params = {
    steamid: steamId,
    revocation_code: revocationCode,
    steamguard_scheme: 2,
    steamguard_code: guardCode,
    access_token: accessToken
  };
  console.log('[removeAuthenticator] 调用 RemoveAuthenticator API, steamId:', steamId);
  return await steamApiRequest('POST', '/ITwoFactorService/RemoveAuthenticator/v1/', params, null, accessToken);
}

// ============ steam-session 登录（两阶段） ============
// 阶段1: 发送用户名密码 → 返回是否需要 Steam Guard 验证码
// 阶段2: 如果阶段1返回 needGuard，用户输入验证码后再次调用 → 完成登录

let loginSessions = {}; // sessionId -> { session, username }

async function steamSessionLoginPhase1(username, password) {
  const sessionId = crypto.randomUUID();
  const session = new LoginSession(EAuthTokenPlatformType.MobileApp, getSessionOptions());
  session.loginTimeout = 120000;

  loginSessions[sessionId] = { session, username };

  return new Promise((resolve, reject) => {
    let resolved = false;

    session.on('authenticated', async () => {
      if (resolved) return;
      resolved = true;
      console.log('[steam-session] 认证成功, session.steamID:', session.steamID);
      console.log('[steam-session] authenticated 时 accessToken:', !!session.accessToken, 'type:', typeof session.accessToken, 'len:', session.accessToken ? session.accessToken.length : 0);
      console.log('[steam-session] authenticated 时 refreshToken:', !!session.refreshToken, 'len:', session.refreshToken ? session.refreshToken.length : 0);
      try {
        // 注意：对于 MobileApp 平台，LoginSession._doPoll 内部已经调用过 refreshAccessToken()
        // 如果 session.accessToken 已存在，不要再次调用，否则可能因代理/WebSocket 问题覆盖掉有效 token
        if (!session.accessToken) {
          console.log('[steam-session] accessToken 为空，尝试 refreshAccessToken...');
          await session.refreshAccessToken();
          console.log('[steam-session] refreshAccessToken 完成, accessToken 存在:', !!session.accessToken, '长度:', session.accessToken ? session.accessToken.length : 0);
        } else {
          console.log('[steam-session] accessToken 已存在 (来自 _doPoll), 长度:', session.accessToken.length);
        }
        if (!session.accessToken) {
          throw new Error('无法获取 accessToken（可能是代理或网络问题导致 API 返回异常）');
        }
        const webCookies = await session.getWebCookies();
        console.log('[steam-session] getWebCookies 完成, cookies 数量:', webCookies ? webCookies.length : 0);
        delete loginSessions[sessionId];
        // 从 JWT 解析正确 SteamID（session.steamID 有 off-by-one bug）
        const correctSteamId = parseSteamIdFromToken(session.accessToken) || session.steamID.toString();
        console.log('[steam-session] 正确 SteamID (from JWT):', correctSteamId);
        resolve({
          success: true,
          needGuard: false,
          steamId: correctSteamId,
          accountName: session.accountName,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          webCookies: fixSteamLoginSecureCookie(webCookies.join('; '), correctSteamId)
        });
      } catch (e) {
        delete loginSessions[sessionId];
        reject(new Error('获取 access token 失败: ' + e.message));
      }
    });

    session.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      delete loginSessions[sessionId];
      reject(new Error(err.message || '登录失败'));
    });

    session.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      delete loginSessions[sessionId];
      reject(new Error('登录超时'));
    });

    session.startWithCredentials({
      accountName: username,
      password: password
    }).then(result => {
      if (resolved) return;
      if (result.actionRequired) {
        // 需要 Steam Guard 验证码
        // EAuthSessionGuardType 枚举值:
        //   0=Unknown, 1=None, 2=EmailCode, 3=DeviceCode,
        //   4=DeviceConfirmation, 5=EmailConfirmation, 6=MachineToken, 7=LegacyMachineAuth
        const guardTypes = (result.validActions || []).map(a => {
          switch (a.type) {
            case 2: return 'email';               // EmailCode
            case 3: return 'device';              // DeviceCode (手机令牌 TOTP)
            case 4: return 'device_confirmation'; // DeviceConfirmation
            case 5: return 'email_confirmation';  // EmailConfirmation
            default: return 'unknown';
          }
        });
        // 提取邮箱域名（detail 字段包含如 gmail.com）
        const emailDomain = (result.validActions || [])
          .filter(a => a.type === 2)  // EmailCode
          .map(a => a.detail || '')
          .find(Boolean) || '';
        resolve({
          success: true,
          needGuard: true,
          sessionId: sessionId,
          guardType: guardTypes.join(','),
          guardDetail: (result.validActions || []).map(a => a.detail || '').filter(Boolean).join(', '),
          emailDomain: emailDomain
        });
      }
      // 不需要额外操作，等待 authenticated 事件
    }).catch(err => {
      if (resolved) return;
      resolved = true;
      delete loginSessions[sessionId];
      reject(new Error(err.message || '登录请求失败'));
    });
  });
}

async function steamSessionLoginPhase2(sessionId, guardCode) {
  const entry = loginSessions[sessionId];
  if (!entry) {
    throw new Error('登录会话已过期，请重新开始');
  }

  const { session } = entry;

  return new Promise((resolve, reject) => {
    let resolved = false;

    session.on('authenticated', async () => {
      if (resolved) return;
      resolved = true;
      console.log('[steam-session] 认证成功 (phase2), session.steamID:', session.steamID);
      try {
        // 同 phase1，如果 accessToken 已存在则不要重复调用
        if (!session.accessToken) {
          console.log('[steam-session] phase2 accessToken 为空，尝试 refreshAccessToken...');
          await session.refreshAccessToken();
          console.log('[steam-session] phase2 refreshAccessToken 完成, accessToken 存在:', !!session.accessToken, '长度:', session.accessToken ? session.accessToken.length : 0);
        } else {
          console.log('[steam-session] phase2 accessToken 已存在 (来自 _doPoll), 长度:', session.accessToken.length);
        }
        if (!session.accessToken) {
          throw new Error('无法获取 accessToken（可能是代理或网络问题导致 API 返回异常）');
        }
        const webCookies = await session.getWebCookies();
        console.log('[steam-session] phase2 getWebCookies 完成, cookies 数量:', webCookies ? webCookies.length : 0);
        delete loginSessions[sessionId];
        // 从 JWT 解析正确 SteamID（session.steamID 有 off-by-one bug）
        const correctSteamId = parseSteamIdFromToken(session.accessToken) || session.steamID.toString();
        console.log('[steam-session] 正确 SteamID (from JWT):', correctSteamId);
        resolve({
          success: true,
          steamId: correctSteamId,
          accountName: session.accountName,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          webCookies: fixSteamLoginSecureCookie(webCookies.join('; '), correctSteamId)
        });
      } catch (e) {
        delete loginSessions[sessionId];
        reject(new Error('获取 access token 失败: ' + e.message));
      }
    });

    session.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      delete loginSessions[sessionId];
      reject(new Error(err.message || '验证码错误或登录失败'));
    });

    session.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      delete loginSessions[sessionId];
      reject(new Error('登录超时'));
    });

    session.submitSteamGuardCode(guardCode).catch(err => {
      if (resolved) return;
      resolved = true;
      delete loginSessions[sessionId];
      reject(new Error(err.message || '验证码提交失败'));
    });
  });
}

// ============ IPC ============
function setupIPC() {
  ipcMain.handle('get-accounts', () => loadAccounts());
  ipcMain.handle('save-account', (event, accountData) => saveAccount(accountData));
  ipcMain.handle('delete-account', (event, steamId) => deleteAccountFile(steamId));

  ipcMain.handle('generate-code', (event, sharedSecret) => {
    try { return generateSteamGuardCode(sharedSecret); }
    catch (err) { return { code: 'ERROR', timeRemaining: 0, error: err.message }; }
  });

  // 批量生成验证码（一次性计算所有账号的验证码，避免 N 次 IPC 往返）
  ipcMain.handle('generate-codes-batch', (event, secrets) => {
    const results = {};
    for (const [uid, secret] of Object.entries(secrets)) {
      try {
        const r = generateSteamGuardCode(secret);
        results[uid] = { code: r.code, timeRemaining: r.timeRemaining };
      } catch (err) {
        results[uid] = { code: 'ERR', timeRemaining: 0, error: err.message };
      }
    }
    return results;
  });

  ipcMain.handle('is-valid-secret', (event, secret) => isValidSecret(secret));

  ipcMain.handle('copy-to-clipboard', (event, text) => {
    console.log('[copy-to-clipboard] 复制到剪贴板:', text);
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('import-accounts', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 maFiles',
      filters: [{ name: 'maFile / JSON', extensions: ['maFile', 'json'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const imported = [];
      for (const fp of result.filePaths) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          if (data.shared_secret) { saveAccount(data); imported.push(data); }
          else if (Array.isArray(data)) {
            for (const acc of data) {
              if (acc.shared_secret) { saveAccount(acc); imported.push(acc); }
            }
          }
        } catch (err) { console.error('导入失败:', fp, err); }
      }
      return { success: true, count: imported.length };
    }
    return { success: false };
  });

  // ============ steam-session 两阶段登录 ============
  // 阶段1: 发送用户名密码
  ipcMain.handle('steam-login-phase1', async (event, { username, password }) => {
    try {
      console.log('[steam-login-phase1] 开始登录:', username);
      return await steamSessionLoginPhase1(username, password);
    } catch (err) {
      console.error('[steam-login-phase1] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 阶段2: 提交 Steam Guard 验证码
  ipcMain.handle('steam-login-phase2', async (event, { sessionId, guardCode }) => {
    try {
      console.log('[steam-login-phase2] 提交验证码, sessionId:', sessionId);
      return await steamSessionLoginPhase2(sessionId, guardCode);
    } catch (err) {
      console.error('[steam-login-phase2] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 合并两阶段登录（bind-renderer 使用）
  // 用 account 名作为 key 保存 sessionId
  const pendingLoginSessions = {};
  ipcMain.handle('steam-login', async (event, { account, password, guardCode }) => {
    try {
      if (!guardCode) {
        // 第一阶段：发送用户名密码
        const result = await steamSessionLoginPhase1(account, password);
        console.log('[steam-login] 第一阶段结果:', JSON.stringify({
          success: result.success,
          needGuard: result.needGuard,
          hasToken: !!result.accessToken,
          tokenLength: result.accessToken ? result.accessToken.length : 0,
          tokenType: typeof result.accessToken,
          tokenFirstChars: typeof result.accessToken === 'string' ? result.accessToken.substring(0, 10) : 'N/A',
          steamId: result.steamId,
          guardType: result.guardType,
          guardDetail: result.guardDetail,
          emailDomain: result.emailDomain,
          allKeys: Object.keys(result)
        }));
        if (result.success && result.needGuard) {
          // 保存 sessionId 供第二阶段使用
          pendingLoginSessions[account] = result.sessionId;
        }
        return result;
      } else {
        // 第二阶段：提交 guard code
        const sessionId = pendingLoginSessions[account];
        if (!sessionId) {
          return { success: false, message: '登录会话已过期，请重新开始' };
        }
        delete pendingLoginSessions[account];
        const result = await steamSessionLoginPhase2(sessionId, guardCode);
        console.log('[steam-login] 第二阶段结果:', JSON.stringify({ success: result.success, hasToken: !!result.accessToken, steamId: result.steamId }));
        if (result.success) {
          // 第二阶段成功，但需要包含 revocationCode（bind-renderer 需要）
          // steamSessionLoginPhase2 返回 { success, steamId, accountName, accessToken, refreshToken, webCookies }
          return { ...result, needGuard: false };
        }
        return result;
      }
    } catch (err) {
      console.error('[steam-login] 失败:', err.message);
      return { success: false, message: err.message };
    }
  });

  // ============ 绑定流程 API ============
  ipcMain.handle('add-authenticator', async (event, { accessToken, steamId }) => {
    try {
      console.log('[add-authenticator] calling with steamId:', steamId);
      return await addAuthenticator(accessToken, steamId);
    }
    catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('finalize-authenticator', async (event, { accessToken, steamId, accountName, smsCode, codeType, sharedSecret, identitySecret, secret1, revocationCode, webCookies }) => {
    try {
      const result = await finalizeWithCode(accessToken, steamId, smsCode, codeType || 'email', sharedSecret);
      console.log('[finalize-authenticator] result:', JSON.stringify(result));

      // FinalizeAddAuthenticator 成功时返回 response.success = true
      // shared_secret/identity_secret 等数据来自 AddAuthenticator 步骤（已通过参数传入）
      if (result.response && result.response.success) {
        const authenticatorData = {
          account_name: accountName || '', // 使用登录时获取的 Steam 用户名
          SteamID: steamId,
          shared_secret: sharedSecret || result.response.shared_secret || '',
          identity_secret: identitySecret || result.response.identity_secret || '',
          secret_1: secret1 || result.response.secret_1 || '',
          revocation_code: revocationCode || result.response.revocation_code || '',
          access_token: accessToken || '', // 保存 access_token，用于 LoginApprover 等操作
          web_cookies: webCookies || '', // 保存 web cookies，用于浏览器自动化
          status: 1,
          device_id: generateDeviceId(steamId)
        };
        return { success: true, data: authenticatorData };
      }

      // status=89 表示激活码无效
      if (result.response && result.response.status === 89) {
        return { success: false, error: '邮箱验证码无效或已过期，请重新发送' };
      }

      return { success: false, error: result.response?.message || result.response?.detail || '绑定失败，请重试' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('query-auth-status', async (event, { accessToken, steamId }) => {
    const params = { steamid: steamId };
    try { return await steamApiRequest('POST', '/ITwoFactorService/QueryStatus/v1/', params, null, accessToken); }
    catch (err) { return { success: false, error: err.message }; }
  });

  // bind-renderer 使用的合并 API

  // 发送邮箱验证码（调用 AddAuthenticator 触发）
  ipcMain.handle('send-email-code', async (event, { accessToken, steamId }) => {
    try {
      console.log('[send-email-code] 触发邮件验证码, steamId:', steamId);
      console.log('[send-email-code] accessToken 前20字符:', accessToken ? accessToken.substring(0, 20) + '...' : '(空)');
      if (!accessToken) {
        return { success: false, error: '登录信息丢失，请点击下方"返回上一步"重新登录', needRelogin: true };
      }
      const result = await addAuthenticator(accessToken, steamId);
      console.log('[send-email-code] AddAuthenticator 响应:', JSON.stringify(result));
      if (result.response) {
        // Steam API 返回的 response 可能 success: false（如 status=84）
        if (result.response.shared_secret) {
          return {
            success: true,
            sharedSecret: result.response.shared_secret || '',
            identitySecret: result.response.identity_secret || '',
            secret1: result.response.secret_1 || '',
            revocationCode: result.response.revocation_code || '',
          };
        }
        const status = result.response.status;
        const detail = result.response.detail || result.response.message || '';
        console.log('[send-email-code] response 状态:', status, detail);
        // 即使没有 shared_secret，只要 response 存在且不是明确的错误，也视为已触发
        if (status === 1 || status === undefined || (status >= 80 && status < 90)) {
          return {
            success: true,
            sharedSecret: result.response.shared_secret || '',
            identitySecret: result.response.identity_secret || '',
            secret1: result.response.secret_1 || '',
            revocationCode: result.response.revocation_code || '',
            status: status,
            detail: detail,
          };
        }
        return { success: false, error: detail || `AddAuthenticator 返回异常状态 (status=${status})` };
      }
      // 没有 response 字段 —— Steam API 返回非 JSON（可能是网络/代理问题，或 accessToken 无效）
      if (result.raw) {
        const rawStr = String(result.raw).substring(0, 500);
        const sc = result.statusCode || 0;
        console.error('[send-email-code] Steam API 返回非 JSON, statusCode:', sc, 'body:', rawStr);
        // 根据 HTTP 状态码给出更具体的错误提示
        if (sc === 401 || sc === 403) {
          return { success: false, error: `认证失败 (HTTP ${sc})，accessToken 可能已过期或无效，请返回上一步重新登录`, needRelogin: true };
        }
        if (sc === 429) {
          return { success: false, error: '请求过于频繁 (HTTP 429)，请稍等片刻后重试' };
        }
        return { success: false, error: `Steam API 返回异常 (HTTP ${sc})，请检查网络连接后重试。详情: ${rawStr.substring(0, 100)}` };
      }
      return { success: false, error: result.error || 'Steam API 无响应，请检查网络连接' };
    } catch (err) {
      console.error('[send-email-code] 失败:', err.message);
      return { success: false, error: '网络请求失败: ' + (err.message || '未知错误') };
    }
  });

  // 验证邮箱验证码（调用 FinalizeAddAuthenticator）
  ipcMain.handle('verify-email-code', async (event, data) => {
    try {
      console.log('[verify-email-code] 验证邮箱验证码, steamId:', data.steamId);
      const result = await finalizeWithCode(
        data.accessToken,
        data.steamId,
        data.code,
        'email',
        data.sharedSecret
      );
      if (result.response && result.response.success) {
        return {
          success: true,
          revocationCode: result.response.revocation_code || '',
          sharedSecret: result.response.shared_secret || data.sharedSecret || '',
          identitySecret: result.response.identity_secret || data.identitySecret || '',
          secret1: result.response.secret_1 || data.secret1 || '',
        };
      }
      return { success: false, error: result.response?.message || result.response?.detail || '验证码无效' };
    } catch (err) {
      console.error('[verify-email-code] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 保存账号凭据到本地
  ipcMain.handle('save-credentials', async (event, data) => {
    try {
      console.log('[save-credentials] 保存账号:', data.account, 'steamId:', data.steamId);
      const accountData = {
        account_name: data.account || '',
        SteamID: data.steamId,
        shared_secret: data.sharedSecret || '',
        identity_secret: data.identitySecret || '',
        secret_1: data.secret1 || '',
        revocation_code: data.revocationCode || '',
        access_token: data.accessToken || '',
        web_cookies: data.webCookies || '',
        status: 1,
        device_id: generateDeviceId(data.steamId)
      };
      saveAccount(accountData);
      // 通知主窗口刷新
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bind-complete');
      }
      return { success: true };
    } catch (err) {
      console.error('[save-credentials] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('hide-window', () => { mainWindow?.hide(); });

  // 主题同步：主窗口切换主题后，同步到所有子窗口
  ipcMain.on('theme-changed', (event, theme) => {
    const windows = [bindWindow, reloginWindow, confirmationWindow, mainWindow];
    // 根据主题确定背景色（主窗口用 --bg-app，子窗口用 --bg-secondary）
    const isDark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
    const mainBgColor = isDark ? '#0a0e14' : '#f6f8fa';
    const subBgColor = isDark ? '#161b22' : '#ffffff';
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        const bg = win === mainWindow ? mainBgColor : subBgColor;
        win.setBackgroundColor(bg);
        if (win !== mainWindow) {
          win.webContents.send('theme-changed', theme);
        }
      }
    }
  });

  // 绑定窗口
  ipcMain.handle('open-bind-window', (event, theme) => {
    createBindWindow(theme);
    return { success: true };
  });

  ipcMain.on('close-bind-window', () => {
    if (bindWindow && !bindWindow.isDestroyed()) {
      bindWindow.close();
    }
  });

  // 通用窗口高度自适应：子窗口前端测量 .window 元素完整高度，主进程直接使用
  ipcMain.on('set-window-height', (event, totalHeight) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return;

    // 根据不同的窗口类型设置不同的限制
    let minHeight = 300, maxHeight = 900;

    if (senderWindow === bindWindow) {
      minHeight = 400; maxHeight = 900;
    } else if (senderWindow === reloginWindow) {
      minHeight = 350; maxHeight = 800;
    } else if (senderWindow === confirmationWindow) {
      minHeight = 350; maxHeight = 900;
    }

    const clampedHeight = Math.max(minHeight, Math.min(maxHeight, Math.round(totalHeight)));
    const [currentWidth] = senderWindow.getSize();
    senderWindow.setSize(currentWidth, clampedHeight, false);
  });

  // 绑定完成通知主窗口刷新
  ipcMain.on('bind-complete', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bind-complete');
    }
  });

  // 重新登录窗口
  let pendingReloginData = null;

  ipcMain.handle('open-relogin-window', (event, data, theme) => {
    // 强制 steamId 为字符串，避免 JS 大整数精度丢失导致显示/保存错误
    if (data && data.steamId) {
      data.steamId = String(data.steamId);
    }
    pendingReloginData = data;
    createReloginWindow(data, theme);
    return { success: true };
  });

  // 渲染进程主动请求初始化数据（解决 ready-to-show 时序问题）
  ipcMain.handle('request-relogin-data', () => {
    const data = pendingReloginData;
    if (data && data.accountName) {
      const csvPassword = queryPasswordFromCsv(data.accountName);
      if (csvPassword) {
        data.autoPassword = csvPassword;
      }
    }
    return data || null;
  });

  // 从 CSV 查询密码（备用 API）
  ipcMain.handle('query-password-from-csv', (event, accountName) => {
    return queryPasswordFromCsv(accountName);
  });

  ipcMain.on('close-relogin-window', () => {
    if (reloginWindow && !reloginWindow.isDestroyed()) {
      reloginWindow.close();
    }
  });

  // 重新登录提交：使用已有的 steamId/sharedSecret 数据 + 用户输入的密码执行登录
  ipcMain.handle('relogin-submit', async (event, { accountName, password }) => {
    const data = pendingReloginData;
    if (!data) {
      return { success: false, error: '登录数据丢失，请关闭窗口重试' };
    }
    const { steamId, sharedSecret } = data;
    if (!steamId || !sharedSecret) {
      return { success: false, error: '缺少账号密钥信息，请重新绑定' };
    }

    try {
      console.log('[relogin-submit] 开始重新登录, steamId:', steamId);
      const sessionId = crypto.randomUUID();
      const session = new LoginSession(EAuthTokenPlatformType.MobileApp, getSessionOptions());
      session.loginTimeout = 120000;

      const result = await new Promise((resolve) => {
        let resolved = false;

        session.on('authenticated', async () => {
          if (resolved) return;
          resolved = true;
          console.log('[relogin-submit] 认证成功');
          try {
            if (!session.accessToken) {
              await session.refreshAccessToken();
            }
            const token = session.accessToken;
            const webCookiesRaw = session.getWebCookies ? await session.getWebCookies() : '';
            // getWebCookies() 返回 string[]，需要 join 为 cookie 字符串
            const webCookies = Array.isArray(webCookiesRaw) ? webCookiesRaw.join('; ') : (typeof webCookiesRaw === 'string' ? webCookiesRaw : '');
            console.log('[relogin-submit] 获取到 accessToken:', token ? token.substring(0, 20) + '...' : 'null', ', cookies 数量:', Array.isArray(webCookiesRaw) ? webCookiesRaw.length : (webCookies ? 'non-empty' : 'empty'));

            // 从 JWT 中获取权威 SteamID（session.steamID 有精度丢失/错位 bug）
            const correctSteamId = parseSteamIdFromToken(token) || String(steamId);
            if (String(steamId) !== correctSteamId) {
              console.warn('[relogin-submit] ⚠️ steamId 不一致，以 JWT sub 为准:', steamId, '→', correctSteamId);
            }
            // 修正 web_cookies 中可能因精度丢失产生的错误前缀
            const fixedWebCookies = fixSteamLoginSecureCookie(webCookies, correctSteamId);

            // 用旧的 steamId 匹配文件，内部会用 correctSteamId 修正并重命名
            const updated = updateAccountAccessToken(steamId, token, fixedWebCookies);
            if (!updated) {
              resolve({ success: false, error: '登录成功但更新账号数据失败' });
              return;
            }
            // 只返回可序列化的简单值，避免 IPC 序列化失败
            resolve({ success: true, steamId: String(correctSteamId) });
          } catch (e) {
            console.error('[relogin-submit] 获取 token 失败:', e.message);
            resolve({ success: false, error: '获取令牌失败: ' + e.message });
          } finally {
            delete loginSessions[sessionId];
          }
        });

        session.on('error', (err) => {
          if (resolved) return;
          resolved = true;
          console.error('[relogin-submit] 登录失败:', err.message);
          delete loginSessions[sessionId];
          resolve({ success: false, error: err.message || '登录失败' });
        });

        // 预生成 TOTP 验证码
        let steamGuardCode = null;
        try {
          steamGuardCode = generateSteamGuardCode(sharedSecret).code;
          console.log('[relogin-submit] 预生成 TOTP:', steamGuardCode);
        } catch (e) {
          console.warn('[relogin-submit] 生成 TOTP 失败:', e.message);
        }

        const credentialsDetails = {
          accountName: accountName,
          password: password,
          steamGuardCode: steamGuardCode || undefined,
          persistentSession: true
        };

        loginSessions[sessionId] = session;
        session.startWithCredentials(credentialsDetails).catch((err) => {
          if (resolved) return;
          resolved = true;
          console.error('[relogin-submit] startWithCredentials 失败:', err.message);
          delete loginSessions[sessionId];
          resolve({ success: false, error: err.message || '登录请求失败' });
        });
      });

      return result;
    } catch (err) {
      console.error('[relogin-submit] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 重新登录完成通知主窗口
  ipcMain.on('relogin-done', (event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('relogin-done', data);
    }
    // 如果确认窗口打开着，直接从磁盘读取更新后的账号数据并推送
    // 这样做是为了避免竞态：主窗口 renderer 的 onReloginDone 是异步的，
    // 如果在它更新 confirmationData 之前确认窗口就请求数据，会拿到旧数据
    if (confirmationWindow && !confirmationWindow.isDestroyed() && data && data.steamId) {
      try {
        const steamId = String(data.steamId);
        const files = fs.readdirSync(DATA_FILE);
        for (const file of files) {
          if (!file.endsWith('.maFile')) continue;
          const filePath = path.join(DATA_FILE, file);
          const accData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const accSteamId = accData.SteamID || accData.steamid || (accData.Session && accData.Session.SteamID);
          if (String(accSteamId) === steamId) {
            const accountName = accData.account_name || steamId;
            confirmationData = {
              accountName,
              steamId,
              identitySecret: accData.identity_secret || '',
              deviceId: accData.device_id || '',
              webCookies: accData.web_cookies || '',
              accessToken: accData.access_token || ''
            };
            confirmationWindow.webContents.send('confirmation-data', confirmationData);
            console.log('[relogin-done] 已直接推送更新后的数据到确认窗口, steamId:', steamId);
            break;
          }
        }
      } catch (err) {
        console.error('[relogin-done] 读取更新后的账号数据失败:', err.message);
      }
      // 兜底通知：携带最新的账号数据一起发送，避免确认窗口依赖 IPC 时序
      confirmationWindow.webContents.send('relogin-done-refresh', {
        ...data,
        accountData: confirmationData
      });
    }
  });

  // 保存账号排序
  ipcMain.handle('save-account-order', (event, order) => {
    try {
      const orderPath = path.join(DATA_FILE, '.order.json');
      fs.writeFileSync(orderPath, JSON.stringify(order, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============ 独立确认窗口 ============
  ipcMain.handle('open-confirmation-window', (event, data, theme) => {
    createConfirmationWindow(data, theme);
    return { success: true };
  });

  // 确认窗口请求数据（窗口重新加载或首次加载时）
  ipcMain.on('request-confirmation-data', (event) => {
    if (confirmationData) {
      event.sender.send('confirmation-data', confirmationData);
    }
  });

  // 主窗口重新登录后，推送更新后的账号数据给确认窗口
  ipcMain.on('update-confirmation-data', (event, data) => {
    confirmationData = data;
    if (confirmationWindow && !confirmationWindow.isDestroyed()) {
      confirmationWindow.webContents.send('confirmation-data', data);
    }
  });

  // 确认窗口请求重新登录（cookie 过期时，通知主窗口打开重新登录）
  ipcMain.on('confirmation-request-relogin', (event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('confirmation-request-relogin', data);
    }
  });

  // ============ 交易确认 ============
  // 参考 node-steamcommunity 实现，使用 steamcommunity.com/mobileconf 端点
  ipcMain.handle('get-confirmations', async (event, { steamId, identitySecret, deviceId, webCookies }) => {
    try {
      if (!identitySecret) {
        return { success: false, error: '缺少 identity_secret' };
      }
      if (!steamId) {
        return { success: false, error: '缺少 steamId' };
      }

      // Steam 的 MobileApp access_token JWT sub 可能与账号真实 SteamID 不一致（steam-session bug）。
      // 交易确认校验的是 cookie 内部一致性，因此这里把 steamLoginSecure 前缀统一到 JWT sub，
      // 并用该 sub 作为请求参数，避免前缀/sub 不一致导致 Steam 认为凭证无效。
      const { effectiveSteamId, effectiveCookies } = getEffectiveConfirmationCookies(webCookies, steamId);
      if (String(effectiveSteamId) !== String(steamId)) {
        console.log(`[get-confirmations] 使用 cookie 中的 SteamID 请求: ${effectiveSteamId}`);
      }

      const timeKey = Math.floor(Date.now() / 1000);
      const confirmationKey = generateConfirmationKey(identitySecret, timeKey, 'conf');

      // 构建查询参数
      const queryParams = new URLSearchParams({
        p: deviceId || generateDeviceId(effectiveSteamId),
        a: String(effectiveSteamId),
        k: confirmationKey,
        t: String(timeKey),
        m: 'react',
        tag: 'conf'
      });

      const path = `/mobileconf/getlist?${queryParams.toString()}`;

      console.log('[get-confirmations] 请求 mobileconf/getlist, steamId:', steamId);

      const listResult = await steamCommunityRequest('GET', path, null, effectiveCookies || null);

      console.log('[get-confirmations] 原始响应:', JSON.stringify(listResult).substring(0, 2000));

      // 检查是否需要重新认证（cookie 过期）
      if (listResult.needauth === true || listResult.needauth === 'true') {
        return { success: false, error: '登录凭证已过期，请重新登录该账号后再试' };
      }

      // 解析响应 - 按照 node-steamcommunity 的方式映射字段
      let rawConfs = [];
      if (listResult.success === true || listResult.success === false) {
        rawConfs = listResult.conf || [];
      } else if (listResult.conf) {
        rawConfs = listResult.conf;
      }

      // 将原始字段映射为渲染器需要的格式
      const confirmations = rawConfs.map(conf => ({
        id: conf.id,
        type: conf.type,
        typeName: conf.type_name || '',       // 原始类型名称（如 "交易报价" / "Market Listing"）
        creator: conf.creator_id || '',
        key: conf.nonce,                      // 确认密钥
        headline: conf.headline || '',         // 物品/描述标题
        title: `${conf.type_name || 'Confirm'} - ${conf.headline || ''}`,  // 兼容旧版
        summary: conf.summary || [],           // 完整 summary 数组
        receiving: conf.type === 1 ? ((conf.summary || [])[1] || '') : '',
        sending: (conf.summary || [])[0] || '',
        time: conf.creation_time,
        timestamp: conf.creation_time ? new Date(conf.creation_time * 1000) : null,
        icon: conf.icon || ''
      }));

      console.log('[get-confirmations] 获取到', confirmations.length, '个待确认项');
      confirmations.forEach((c, i) => {
        console.log(`[get-confirmations] [${i}] type=${c.type} typeName="${c.typeName}" headline="${c.headline}" creator="${c.creator}" icon="${c.icon}" sending="${c.sending}" receiving="${c.receiving}"`);
        console.log(`[get-confirmations] [${i}] raw summary:`, JSON.stringify(c.summary));
      });

      return {
        success: true,
        confirmCount: confirmations.length,
        confirmations: confirmations
      };
    } catch (err) {
      console.error('[get-confirmations] 错误:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('confirm-trade', async (event, { steamId, identitySecret, confirmationId, confirmationKey, action, deviceId, webCookies }) => {
    try {
      // 处理 steam-session access_token sub 与真实 SteamID 不一致的情况
      const { effectiveSteamId, effectiveCookies } = getEffectiveConfirmationCookies(webCookies, steamId);
      if (String(effectiveSteamId) !== String(steamId)) {
        console.log(`[confirm-trade] 使用 cookie 中的 SteamID: ${effectiveSteamId}`);
      }

      const timeKey = Math.floor(Date.now() / 1000);
      const tag = action === 'allow' ? 'allow' : 'cancel';
      const key = generateConfirmationKey(identitySecret, timeKey, tag);

      const params = {
        op: action || 'allow',
        cid: confirmationId,
        ck: confirmationKey,
        p: deviceId || generateDeviceId(effectiveSteamId),
        a: String(effectiveSteamId),
        k: key,
        t: String(timeKey),
        m: 'react',
        tag: tag
      };

      console.log('[confirm-trade] 发送确认请求 (GET), action:', action, 'cid:', confirmationId);

      // 单个确认操作使用 GET 请求（node-steamcommunity 实现也是 GET）
      const result = await steamCommunityRequest(
        'GET',
        '/mobileconf/ajaxop?' + new URLSearchParams(params).toString(),
        null,
        effectiveCookies || null
      );

      console.log('[confirm-trade] 响应:', JSON.stringify(result));

      if (result.success) {
        return { success: true, result };
      } else {
        return { success: false, error: result.message || '确认操作失败' };
      }
    } catch (err) {
      console.error('[confirm-trade] 错误:', err.message);
      return { success: false, error: err.message };
    }
  });

  // ============ 头像获取 ============
  ipcMain.handle('get-steam-avatar', async (event, { steamId, webCookies }) => {
    try {
      // 1. 从 Steam 社区 XML 获取头像 URL
      let avatarUrl = await fetchSteamAvatarUrl(steamId);

      // 2. 如果 XML 没有（缓存延迟），尝试用 cookie 从 HTML 页面提取
      if (!avatarUrl && webCookies) {
        console.log(`[avatar] XML 无头像，尝试用 cookie 获取: ${steamId}`);
        avatarUrl = await fetchSteamAvatarFromHtml(steamId, webCookies);
      }

      if (!avatarUrl) {
        return { success: false, error: '无法获取头像 URL' };
      }

      // 3. 在 main 进程下载头像，转为 base64 data URI（避免 CSP 问题）
      const dataUri = await downloadImageAsDataUri(avatarUrl);
      if (dataUri) {
        return { success: true, url: dataUri };
      }
      return { success: false, error: '下载头像失败' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============ 根据 SteamID 获取玩家名称 ============
  ipcMain.handle('fetch-player-names', async (event, steamIds) => {
    try {
      const names = await fetchPlayerNamesBatch(steamIds);
      return { success: true, names };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============ QR 点击登录 ============

  // 截取所有屏幕，逐个识别二维码，找到后返回该屏幕的截图和坐标偏移
  ipcMain.handle('capture-screen', async () => {
    try {
      // 获取所有显示器信息
      const displays = screen.getAllDisplays();
      const primaryDisplay = screen.getPrimaryDisplay();

      console.log('[capture-screen] displays count:', displays.length);

      // 使用每个显示器各自的实际分辨率截图
      for (const display of displays) {
        const thumbW = display.bounds.width * display.scaleFactor;
        const thumbH = display.bounds.height * display.scaleFactor;
        console.log('[capture-screen] trying display:', display.label, 'id:', display.id, 'thumbnailSize:', thumbW, 'x', thumbH);

        let sources;
        try {
          sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: thumbW, height: thumbH }
          });
        } catch (capErr) {
          // macOS 没有屏幕录制权限时会抛出异常
          if (process.platform === 'darwin') {
            const errMsg = capErr.message || '';
            if (errMsg.includes('screen') || errMsg.includes('capture') || errMsg.includes('permission')) {
              return { success: false, error: '需要屏幕录制权限。请前往 系统设置 → 隐私与安全性 → 屏幕录制，找到 Electron 并勾选启用。\n\n如果列表中没有 Electron，请点击 + 手动添加：\n/Users/lucidity/CodeBuddy/20260619185428/steam-authenticator/node_modules/electron/dist/Electron.app' };
            }
          }
          throw capErr;
        }

        // 找到匹配当前 display 的 source
        for (const source of sources) {
          if (String(source.display_id) !== String(display.id)) continue;

          const thumbnail = source.thumbnail;
          if (!thumbnail || thumbnail.isEmpty()) {
            console.log(`[capture-screen] source "${source.name}" EMPTY`);
            continue;
          }

          const imgSize = thumbnail.getSize();
          const pngBuffer = thumbnail.toPNG();

          // 保存截图到桌面
          const desktopDir = app.getPath('desktop');
          const filePath = path.join(desktopDir, `steam-auth-screenshot-${source.display_id || 'unknown'}.png`);
          fs.writeFileSync(filePath, pngBuffer);
          console.log(`[capture-screen] source "${source.name}" display_id=${source.display_id} size=${imgSize.width}x${imgSize.height} saved`);

          // nativeImage.toBitmap() 在 macOS 返回 BGRA，jsQR 需要 RGBA
          const bitmapBGRA = thumbnail.toBitmap();
          const pixelCount = imgSize.width * imgSize.height;
          const bitmapRGBA = new Uint8ClampedArray(pixelCount * 4);
          for (let i = 0; i < pixelCount; i++) {
            const src = i * 4;
            const dst = i * 4;
            bitmapRGBA[dst]     = bitmapBGRA[src + 2];
            bitmapRGBA[dst + 1] = bitmapBGRA[src + 1];
            bitmapRGBA[dst + 2] = bitmapBGRA[src];
            bitmapRGBA[dst + 3] = bitmapBGRA[src + 3];
          }

          // 先尝试原始分辨率
          console.log(`[capture-screen] running jsQR on "${source.name}" (${imgSize.width}x${imgSize.height})`);
          let qrResult = jsQR(bitmapRGBA, imgSize.width, imgSize.height);

          // 如果失败，尝试缩小到 50% 再识别
          if (!qrResult && (imgSize.width > 2000 || imgSize.height > 2000)) {
            const scale = 0.5;
            const sw = Math.floor(imgSize.width * scale);
            const sh = Math.floor(imgSize.height * scale);
            console.log(`[capture-screen] retrying at 50% scale: ${sw}x${sh}`);
            const scaled = new Uint8ClampedArray(sw * sh * 4);
            for (let y = 0; y < sh; y++) {
              for (let x = 0; x < sw; x++) {
                const sx = Math.floor(x / scale);
                const sy = Math.floor(y / scale);
                const srcIdx = (sy * imgSize.width + sx) * 4;
                const dstIdx = (y * sw + x) * 4;
                scaled[dstIdx]     = bitmapRGBA[srcIdx];
                scaled[dstIdx + 1] = bitmapRGBA[srcIdx + 1];
                scaled[dstIdx + 2] = bitmapRGBA[srcIdx + 2];
                scaled[dstIdx + 3] = bitmapRGBA[srcIdx + 3];
              }
            }
            const scaledResult = jsQR(scaled, sw, sh);
            if (scaledResult) {
              // 把坐标映射回原始分辨率
              qrResult = {
                data: scaledResult.data,
                location: {
                  topLeftCorner:     { x: scaledResult.location.topLeftCorner.x / scale, y: scaledResult.location.topLeftCorner.y / scale },
                  topRightCorner:    { x: scaledResult.location.topRightCorner.x / scale, y: scaledResult.location.topRightCorner.y / scale },
                  bottomLeftCorner:  { x: scaledResult.location.bottomLeftCorner.x / scale, y: scaledResult.location.bottomLeftCorner.y / scale },
                  bottomRightCorner: { x: scaledResult.location.bottomRightCorner.x / scale, y: scaledResult.location.bottomRightCorner.y / scale }
                }
              };
            }
          }

          if (qrResult) {
            console.log('[capture-screen] QR found in source:', source.name, 'display_id:', source.display_id, 'data:', qrResult.data.substring(0, 60));

            return {
              success: true,
              data: pngBuffer.toString('base64'),
              width: imgSize.width,
              height: imgSize.height,
              qrFound: true,
              qrData: qrResult.data,
              qrCenterX: (qrResult.location.topLeftCorner.x + qrResult.location.topRightCorner.x
                + qrResult.location.bottomLeftCorner.x + qrResult.location.bottomRightCorner.x) / 4,
              qrCenterY: (qrResult.location.topLeftCorner.y + qrResult.location.topRightCorner.y
                + qrResult.location.bottomLeftCorner.y + qrResult.location.bottomRightCorner.y) / 4,
              offsetX: display.bounds.x,
              offsetY: display.bounds.y,
              displayName: source.name
            };
          } else {
            console.log('[capture-screen] jsQR: no QR found in source:', source.name);
          }
        }
      }

      // 所有屏幕都没找到二维码，返回错误提示
      return {
        success: false,
        error: `在 ${displays.length} 个屏幕中均未找到 Steam 登录二维码。请确保：\n1. Steam 登录页面的二维码在某个屏幕中完全可见\n2. 二维码未被其他窗口遮挡`
      };

    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 重新登录以获取 access_token（用于已有 maFile 但缺少 access_token 的账号）
  ipcMain.handle('relogin-for-access-token', async (event, { username, password, steamId, sharedSecret }) => {
    try {
      console.log('[relogin-for-access-token] 开始重新登录, steamId:', steamId);

      const sessionId = crypto.randomUUID();
      const session = new LoginSession(EAuthTokenPlatformType.MobileApp, getSessionOptions());
      session.loginTimeout = 120000;

      loginSessions[sessionId] = { session, username };

      return new Promise((resolve, reject) => {
        let resolved = false;

        session.on('authenticated', async () => {
          if (resolved) return;
          resolved = true;
          console.log('[relogin-for-access-token] 认证成功');
          try {
            // 同前，如果 accessToken 已存在则不要重复调用
            if (!session.accessToken) {
              await session.refreshAccessToken();
            }
            if (!session.accessToken) {
              throw new Error('无法获取 accessToken（可能是代理或网络问题导致 API 返回异常）');
            }
            const webCookies = await session.getWebCookies();
            const webCookiesStr = webCookies.join('; ');
            delete loginSessions[sessionId];

            // 从 JWT 获取权威 SteamID，修正可能因精度丢失产生的错误
            const correctSteamId = parseSteamIdFromToken(session.accessToken) || String(steamId);
            if (String(steamId) !== correctSteamId) {
              console.warn('[relogin-for-access-token] ⚠️ steamId 不一致，以 JWT sub 为准:', steamId, '→', correctSteamId);
            }
            const fixedWebCookies = fixSteamLoginSecureCookie(webCookiesStr, correctSteamId);

            // 用旧的 steamId 匹配文件，内部会用 correctSteamId 修正并重命名
            const updated = updateAccountAccessToken(steamId, session.accessToken, fixedWebCookies);
            resolve({
              success: true,
              needGuard: false,
              message: updated ? '登录成功，access_token 已更新' : '登录成功但更新 maFile 失败'
            });
          } catch (e) {
            delete loginSessions[sessionId];
            resolve({ success: false, error: '获取 access token 失败: ' + e.message });
          }
        });

        session.on('error', (err) => {
          if (resolved) return;
          resolved = true;
          delete loginSessions[sessionId];
          resolve({ success: false, error: err.message || '登录失败' });
        });

        session.on('timeout', () => {
          if (resolved) return;
          resolved = true;
          delete loginSessions[sessionId];
          resolve({ success: false, error: '登录超时' });
        });

        // 如果有 sharedSecret，生成 TOTP 并作为 steamGuardCode 传入 startWithCredentials
        // steam-session 库内部会自动用它验证（_attemptTotpCodeAuth），实现一步完成登录
        let steamGuardCode = null;
        if (sharedSecret) {
          try {
            steamGuardCode = generateSteamGuardCode(sharedSecret).code;
            console.log('[relogin-for-access-token] 预生成 TOTP 验证码:', steamGuardCode);
          } catch (e) {
            console.warn('[relogin-for-access-token] 生成 TOTP 失败:', e.message);
          }
        }

        const credentialsDetails = {
          accountName: username,
          password: password
        };
        if (steamGuardCode) {
          credentialsDetails.steamGuardCode = steamGuardCode;
        }

        session.startWithCredentials(credentialsDetails).then(result => {
          if (resolved) return;

          if (!result.actionRequired) {
            // 不需要额外操作（库内部已用 TOTP 自动验证），等待 authenticated 事件
            console.log('[relogin-for-access-token] 无需额外操作，等待 authenticated...');
            return;
          }

          // 走到这里说明需要手动输入验证码（没有 sharedSecret 或 TOTP 验证失败）
          // EAuthSessionGuardType: 0=Unknown,1=None,2=EmailCode,3=DeviceCode,4=DeviceConfirmation,5=EmailConfirmation
          const actions = result.validActions || [];
          const guardTypeNames = actions.map(a => {
            switch (a.type) {
              case 2: return '邮箱验证码';   // EmailCode
              case 3: return '手机验证码';   // DeviceCode
              case 4: return '设备确认';     // DeviceConfirmation
              case 5: return '邮箱确认';     // EmailConfirmation
              default: return '验证码';
            }
          }).join(' 或 ');

          resolve({
            success: true,
            needGuard: true,
            sessionId: sessionId,
            guardType: guardTypeNames,
            guardDetail: (result.validActions || []).map(a => a.detail || '').filter(Boolean).join(', ')
          });
        }).catch(err => {
          if (resolved) return;
          resolved = true;
          delete loginSessions[sessionId];
          resolve({ success: false, error: err.message || '登录请求失败' });
        });
      });
    } catch (err) {
      console.error('[relogin-for-access-token] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 阶段2: 提交 Steam Guard 验证码完成登录
  ipcMain.handle('relogin-guard', async (event, { sessionId, guardCode, steamId }) => {
    try {
      console.log('[relogin-guard] 提交验证码, steamId:', steamId);
      const result = await steamSessionLoginPhase2(sessionId, guardCode);
      if (result.success) {
        const updated = updateAccountAccessToken(steamId, result.accessToken, result.webCookies);
        if (!updated) {
          return { success: false, error: '登录成功但更新 maFile 失败：找不到对应账号文件' };
        }
        console.log('[relogin-guard] 验证码验证成功，access_token + web_cookies 已保存');
        return { success: true, message: '登录成功，access_token 已更新' };
      }
      return { success: false, error: result.error || '验证码错误' };
    } catch (err) {
      console.error('[relogin-guard] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 移除令牌（调用 Steam API RemoveAuthenticator）
  ipcMain.handle('remove-authenticator', async (event, { accessToken, steamId, revocationCode, sharedSecret }) => {
    try {
      console.log('[remove-authenticator] 移除令牌, steamId:', steamId);
      return await removeAuthenticator(accessToken, steamId, revocationCode, sharedSecret);
    } catch (err) {
      console.error('[remove-authenticator] 失败:', err.message);
      return { success: false, error: err.message };
    }
  });

  // 用已有账号的凭证批准 QR 登录（等同于手机 App 确认扫码登录）
  ipcMain.handle('approve-qr-login', async (event, { accessToken, sharedSecret, qrChallengeUrl }) => {
    try {
      console.log('[approve-qr-login] 开始批准 QR 登录...');
      console.log('[approve-qr-login] qrChallengeUrl:', qrChallengeUrl.substring(0, 80));

      // 1. 创建 LoginApprover（需要 MobileApp 平台的 accessToken），传入代理配置
      const approver = new LoginApprover(accessToken, sharedSecret, getSessionOptions());
      console.log('[approve-qr-login] LoginApprover 已创建');

      // 2. 获取登录会话信息（可选，用于确认登录来源）
      try {
        const sessionInfo = await approver.getAuthSessionInfo(qrChallengeUrl);
        console.log('[approve-qr-login] 会话信息:', JSON.stringify({
          ip: sessionInfo.ip,
          location: sessionInfo.location,
          deviceName: sessionInfo.deviceFriendlyName,
          locationMismatch: sessionInfo.locationMismatch
        }));
      } catch (e) {
        console.warn('[approve-qr-login] 获取会话信息失败（非致命）:', e.message);
      }

      // 3. 批准登录
      await approver.approveAuthSession({
        qrChallengeUrl: qrChallengeUrl,
        approve: true,
        persistence: ESessionPersistence.Persistent
      });
      console.log('[approve-qr-login] QR 登录已批准！');

      return { success: true };
    } catch (err) {
      console.error('[approve-qr-login] 失败:', err.message);
      // 如果是 401/403 认证错误，提供更友好的提示
      const msg = String(err.message || '');
      if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
        return { success: false, error: 'accessToken 已过期或无效，请返回账号列表重新登录该账号', needRelogin: true };
      }
      return { success: false, error: err.message };
    }
  });

  // 在默认浏览器中打开 URL
  ipcMain.handle('open-external', async (event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 在截图中识别 QR 码位置
  ipcMain.handle('detect-qr-in-image', async (event, { imageDataBase64, width, height }) => {
    try {
      const buffer = Buffer.from(imageDataBase64, 'base64');

      // 保存截图到桌面，方便调试
      const debugPath = path.join(app.getPath('desktop'), 'steam-auth-screenshot.png');
      fs.writeFileSync(debugPath, buffer);
      console.log('[capture-screen] 截图已保存至:', debugPath, 'size:', width, 'x', height);

      // 将 PNG Buffer 解码为 RGBA 像素数据
      const png = nativeImage.createFromBuffer(buffer);
      const size = png.getSize();
      const bitmap = png.toBitmap();

      // jsqr 需要 Uint8ClampedArray
      const imageData = {
        data: new Uint8ClampedArray(bitmap),
        width: size.width,
        height: size.height
      };

      const result = jsQR(imageData.data, imageData.width, imageData.height);
      console.log('[detect-qr] jsQR result:', result ? 'found: ' + result.data.substring(0, 50) : 'not found');

      if (result) {
        // 返回 QR 码的边界框中心点
        const centerX = result.location.topLeftCorner.x + result.location.topRightCorner.x
          + result.location.bottomLeftCorner.x + result.location.bottomRightCorner.x;
        const centerY = result.location.topLeftCorner.y + result.location.topRightCorner.y
          + result.location.bottomLeftCorner.y + result.location.bottomRightCorner.y;

        return {
          success: true,
          found: true,
          data: result.data,
          location: {
            topLeft: result.location.topLeftCorner,
            topRight: result.location.topRightCorner,
            bottomLeft: result.location.bottomLeftCorner,
            bottomRight: result.location.bottomRightCorner,
            centerX: centerX / 4,
            centerY: centerY / 4
          }
        };
      }
      return { success: true, found: false };
    } catch (err) {
      return { success: false, error: err.message, found: false };
    }
  });

  // 鼠标移动并点击
  ipcMain.handle('mouse-click', async (event, { x, y }) => {
    try {
      const rx = Math.round(x);
      const ry = Math.round(y);

      if (process.platform === 'darwin') {
        // macOS: 使用 JXA (JavaScript for Automation) 调用 CoreGraphics
        const jxaScript = [
          'ObjC.import("CoreGraphics");',
          `var pt = $.CGPointMake(${rx}, ${ry});`,
          '',
          '// 移动鼠标',
          'var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, 0);',
          '$.CGEventPost($.kCGHIDEventTap, move);',
          '',
          '// 短暂延迟',
          'var start = $.CFAbsoluteTimeGetCurrent();',
          'while ($.CFAbsoluteTimeGetCurrent() - start < 0.05) {}',
          '',
          '// 鼠标按下',
          'var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, 0);',
          '$.CGEventPost($.kCGHIDEventTap, down);',
          '',
          'start = $.CFAbsoluteTimeGetCurrent();',
          'while ($.CFAbsoluteTimeGetCurrent() - start < 0.05) {}',
          '',
          '// 鼠标释放',
          'var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, 0);',
          '$.CGEventPost($.kCGHIDEventTap, up);'
        ].join('\n');
        execSync(`osascript -l JavaScript -e '${jxaScript.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
      } else if (process.platform === 'win32') {
        // Windows: 使用 PowerShell
        const tmpFile = path.join(app.getPath('temp'), `steam-qr-click-${Date.now()}.ps1`);
        const psCode = [
          'Add-Type -AssemblyName System.Windows.Forms',
          `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${rx}, ${ry})`,
          'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);\' -Name Win32 -Namespace System',
          'Start-Sleep -Milliseconds 50',
          '[System.Win32]::mouse_event(0x0002, 0, 0, 0, 0)',
          'Start-Sleep -Milliseconds 50',
          '[System.Win32]::mouse_event(0x0004, 0, 0, 0, 0)'
        ].join('\n');
        fs.writeFileSync(tmpFile, psCode, 'utf-8');
        try {
          execSync(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 5000 });
        } finally {
          try { fs.unlinkSync(tmpFile); } catch {}
        }
      } else {
        // Linux: 使用 xdotool
        execSync(`xdotool mousemove ${rx} ${ry} click 1`, { timeout: 5000 });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取鼠标当前位置
  ipcMain.handle('get-mouse-position', async () => {
    try {
      const point = screen.getCursorScreenPoint();
      return { success: true, x: point.x, y: point.y };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取所有显示器信息
  ipcMain.handle('get-displays', async () => {
    try {
      const displays = screen.getAllDisplays();
      return {
        success: true,
        displays: displays.map(d => ({
          id: d.id,
          bounds: d.bounds,
          workArea: d.workArea,
          scaleFactor: d.scaleFactor,
          isPrimary: d.id === screen.getPrimaryDisplay().id
        }))
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 导出单个账号的 maFile 文件
  ipcMain.handle('export-single-account', async (event, { steamId }) => {
    try {
      const files = fs.readdirSync(DATA_FILE);
      for (const file of files) {
        if (!file.endsWith('.maFile')) continue;
        const filePath = path.join(DATA_FILE, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const dataSteamId = data.SteamID || data.steamid || (data.Session && data.Session.SteamID);
        if (String(dataSteamId) === String(steamId)) {
          const defaultName = (dataSteamId || data.account_name || 'account') + '.maFile';
          const result = await dialog.showSaveDialog(mainWindow, {
            title: '导出令牌文件',
            defaultPath: defaultName,
            filters: [{ name: 'maFile', extensions: ['maFile'] }]
          });
          if (!result.canceled && result.filePath) {
            fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
            return { success: true, path: result.filePath };
          }
          return { success: false, error: '已取消' };
        }
      }
      return { success: false, error: '未找到匹配的账号文件' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 设置 Steam 库存隐私为公开（使用隐藏 BrowserWindow + 自动化，走系统代理）
  ipcMain.handle('set-inventory-public', async (event, { steamId, webCookies }) => {
    return new Promise(async (resolve) => {
      let bw = null;
      let resolved = false;

      function done(result) {
        if (resolved) return;
        resolved = true;
        if (bw && !bw.isDestroyed()) {
          try { bw.close(); } catch {}
        }
        resolve(result);
      }

      try {
        if (!webCookies) {
          return done({ success: false, error: '缺少 web_cookies，请先重新登录获取' });
        }
        if (!steamId) {
          return done({ success: false, error: '缺少 steamId' });
        }

        console.log('[set-inventory-public] 设置库存公开, steamId:', steamId);

        // 创建隐藏的 BrowserWindow（走 Electron 网络栈，自动使用系统代理）
        bw = new BrowserWindow({
          width: 800,
          height: 600,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
          }
        });

        // 设置 Steam 登录 cookies
        const cookieStrings = webCookies.split(';').map(c => c.trim()).filter(Boolean);
        console.log('[set-inventory-public] 设置', cookieStrings.length, '个 cookies');

        // 设置过期时间为 30 天后
        const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

        // 提取 sessionid（sessionid 被设为 httpOnly，无法从 document.cookie 读取，需要从主进程传入）
        let sessionId = '';
        for (const cookieStr of cookieStrings) {
          const eqIdx = cookieStr.indexOf('=');
          if (eqIdx <= 0) continue;
          const name = cookieStr.substring(0, eqIdx).trim();
          const value = cookieStr.substring(eqIdx + 1).trim();
          if (!name || !value) continue;
          if (name === 'sessionid') sessionId = value;

          const domains = ['.steamcommunity.com', 'steamcommunity.com', '.store.steampowered.com'];
          for (const domain of domains) {
            try {
              await bw.webContents.session.cookies.set({
                url: 'https://steamcommunity.com',
                name: name,
                value: value,
                domain: domain,
                path: '/',
                secure: true,
                httpOnly: name === 'steamLoginSecure' || name === 'sessionid' || name === 'steamRefresh_steam',
                sameSite: 'no_restriction',
                expirationDate: expiry
              });
            } catch (e) {
              // 忽略单个 cookie 设置错误
            }
          }
        }

        console.log('[set-inventory-public] sessionid from webCookies:', sessionId ? sessionId.substring(0, 10) + '...' : '未找到');

        // 如果 webCookies 中没有 sessionid，尝试从 Electron cookie store 回退读取
        if (!sessionId) {
          try {
            const cookies = await bw.webContents.session.cookies.get({ domain: 'steamcommunity.com', name: 'sessionid' });
            if (cookies && cookies.length > 0) {
              sessionId = cookies[0].value;
              console.log('[set-inventory-public] 从 cookie store 获取 sessionid:', sessionId.substring(0, 10) + '...');
            }
          } catch (e) {
            console.error('[set-inventory-public] 读取 cookie store 失败:', e.message);
          }
        }

        // 短暂等待确保 cookies 已写入
        await new Promise(r => setTimeout(r, 300));

        const settingsUrl = `https://steamcommunity.com/profiles/${steamId}/edit/settings`;

        // 监听页面加载
        bw.webContents.on('did-finish-load', async () => {
          const currentUrl = bw.webContents.getURL();
          console.log('[set-inventory-public] 页面加载完成:', currentUrl);

          // 检查是否被重定向到登录页
          if (currentUrl.includes('/login/') || currentUrl.includes('login.steampowered.com')) {
            return done({ success: false, error: 'Steam 登录态已过期，web_cookies 无效，请先重新登录获取' });
          }

          if (!currentUrl.includes('/edit/settings')) {
            return done({ success: false, error: '未能进入隐私设置页面' });
          }

          try {
            // 在页面中执行 JavaScript：获取隐私设置 → 修改库存为公开 → 提交
            // sessionid 从主进程传入（因为被设为 httpOnly，document.cookie 读不到）
            const result = await bw.webContents.executeJavaScript(`
              (function() {
                var SESSIONID = ${JSON.stringify(sessionId)};
                return new Promise((resolve, reject) => {
                  try {
                    // 从页面中获取 data-profile-edit 属性
                    const profileEdit = document.querySelector('[data-profile-edit]');
                    if (!profileEdit) {
                      return resolve({ success: false, error: '无法解析隐私设置数据' });
                    }

                    const rawData = profileEdit.getAttribute('data-profile-edit');
                    if (!rawData) {
                      return resolve({ success: false, error: '未找到隐私设置数据' });
                    }

                    let configData;
                    try {
                      configData = JSON.parse(rawData);
                    } catch (e) {
                      return resolve({ success: false, error: '解析隐私设置JSON失败: ' + e.message });
                    }

                    const privacy = configData.Privacy && configData.Privacy.PrivacySettings;
                    if (!privacy) {
                      return resolve({ success: false, error: '未找到隐私设置数据' });
                    }

                    // 设置库存为公开（3）
                    privacy.PrivacyInventory = 3;

                    const sessionid = SESSIONID;

                    if (!sessionid) {
                      return resolve({ success: false, error: '无法获取 sessionid，cookie 中未包含 sessionid' });
                    }

                    // 使用 XMLHttpRequest 提交
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', 'https://steamcommunity.com/profiles/${steamId}/ajaxsetprivacy/', true);
                    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                    xhr.withCredentials = true;
                    xhr.timeout = 10000;

                    xhr.onload = function() {
                      try {
                        if (xhr.status === 0) {
                          return resolve({ success: false, error: '请求被阻止（状态码 0），可能是跨域或代理问题' });
                        }
                        if (xhr.status !== 200) {
                          return resolve({ success: false, error: 'HTTP ' + xhr.status + ': ' + String(xhr.responseText || '').substring(0, 200) });
                        }
                        const respText = xhr.responseText || '';
                        const respData = JSON.parse(respText);
                        resolve({
                          success: respData.success === 1,
                          response: respData
                        });
                      } catch (e) {
                        resolve({ success: false, error: '解析响应失败: ' + String(xhr.responseText || '').substring(0, 200) + ' | error: ' + e.message });
                      }
                    };

                    xhr.onerror = function() {
                      resolve({ success: false, error: '网络请求失败（可能是代理或连接问题）' });
                    };

                    xhr.ontimeout = function() {
                      resolve({ success: false, error: '请求超时（10秒）' });
                    };

                    const body = 'sessionid=' + encodeURIComponent(sessionid) +
                      '&Privacy=' + encodeURIComponent(JSON.stringify(privacy)) +
                      '&eCommentPermission=' + (configData.Privacy?.eCommentPermission || 0);
                    xhr.send(body);
                  } catch (e) {
                    resolve({ success: false, error: e.message });
                  }
                });
              })()
            `);

            console.log('[set-inventory-public] 页面操作结果:', JSON.stringify(result));

            if (!result) {
              done({ success: false, error: '页面脚本执行返回空结果，可能页面未完全加载或脚本执行失败' });
            } else if (result.success) {
              done({ success: true, message: '库存隐私已设置为公开' });
            } else {
              done({ success: false, error: result.error || '设置失败: ' + JSON.stringify(result.response) });
            }

          } catch (err) {
            done({ success: false, error: '页面操作失败: ' + err.message });
          }
        });

        // 监听页面加载失败
        bw.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
          console.error('[set-inventory-public] 页面加载失败:', errorDescription);
          done({ success: false, error: '页面加载失败: ' + errorDescription + '（可能需要代理连接 steamcommunity.com）' });
        });

        // 加载隐私设置页面
        console.log('[set-inventory-public] 开始加载:', settingsUrl);
        await bw.loadURL(settingsUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        // 超时处理
        setTimeout(() => {
          done({ success: false, error: '操作超时（30秒），请确认 web_cookies 有效且网络可访问 steamcommunity.com' });
        }, 30000);

      } catch (err) {
        done({ success: false, error: err.message });
      }
    });
  });

  // 更新 maFile 文件（重新获取 Steam 令牌状态数据）
  ipcMain.handle('refresh-mafile', async (event, { accessToken, steamId }) => {
    try {
      if (!accessToken) {
        return { success: false, error: '缺少 access_token，请先重新登录获取' };
      }
      // 查询令牌状态以获取最新数据
      const params = { steamid: steamId };
      const result = await steamApiRequest('POST', '/ITwoFactorService/QueryStatus/v1/', params, null, accessToken);
      console.log('[refresh-mafile] QueryStatus result:', JSON.stringify(result));

      if (!result.response) {
        return { success: false, error: '查询令牌状态失败: ' + (result.error || '无响应') };
      }

      // 更新本地 maFile
      const files = fs.readdirSync(DATA_FILE);
      for (const file of files) {
        if (!file.endsWith('.maFile')) continue;
        const filePath = path.join(DATA_FILE, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const dataSteamId = data.SteamID || data.steamid || (data.Session && data.Session.SteamID);
        if (String(dataSteamId) === String(steamId)) {
          // 合并最新状态数据
          if (result.response.status !== undefined) data.status = result.response.status;
          if (result.response.server_time) data.server_time = result.response.server_time;
          if (result.response.shared_secret) data.shared_secret = result.response.shared_secret;
          if (result.response.identity_secret) data.identity_secret = result.response.identity_secret;
          data.last_updated = new Date().toISOString();
          // 如果文件名不是 SteamID 格式，重命名为 SteamID.maFile
          const expectedFilename = `${steamId}.maFile`;
          const targetPath = path.join(DATA_FILE, expectedFilename);
          if (file !== expectedFilename && !fs.existsSync(targetPath)) {
            fs.renameSync(filePath, targetPath);
            console.log('[refresh-mafile] 文件已重命名:', file, '->', expectedFilename);
          } else {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
          }
          console.log('[refresh-mafile] 已更新', file);
          return { success: true, message: 'maFile 已更新' };
        }
      }
      return { success: false, error: '未找到匹配的账号文件' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 确认并关闭交易保护弹窗（通过 API 直接请求，与库存公开逻辑一致）
  // 使用 Steam 端点：POST https://steamcommunity.com/trade/new/acknowledge
  // 参数：sessionid + message=1
  // 参考：node-steamcommunity acknowledgeTradeProtection 方法
  ipcMain.handle('confirm-all-and-close', async (event, { steamId, webCookies }) => {
    return new Promise(async (resolve) => {
      let bw = null;
      let resolved = false;

      function done(result) {
        if (resolved) return;
        resolved = true;
        if (bw && !bw.isDestroyed()) {
          try { bw.close(); } catch {}
        }
        resolve(result);
      }

      try {
        if (!webCookies) {
          return done({ success: false, error: '缺少 web_cookies，请先重新登录获取' });
        }
        if (!steamId) {
          return done({ success: false, error: '缺少 steamId' });
        }

        console.log('[confirm-all] 确认交易保护, steamId:', steamId);

        // 创建隐藏的 BrowserWindow（走 Electron 网络栈，自动使用系统代理）
        bw = new BrowserWindow({
          width: 800,
          height: 600,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
          }
        });

        // 设置 Steam 登录 cookies
        const cookieStrings = webCookies.split(';').map(c => c.trim()).filter(Boolean);
        console.log('[confirm-all] 设置', cookieStrings.length, '个 cookies');

        // 设置过期时间为 30 天后
        const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

        // 提取 sessionid
        let sessionId = '';
        for (const cookieStr of cookieStrings) {
          const eqIdx = cookieStr.indexOf('=');
          if (eqIdx <= 0) continue;
          const name = cookieStr.substring(0, eqIdx).trim();
          const value = cookieStr.substring(eqIdx + 1).trim();
          if (!name || !value) continue;
          if (name === 'sessionid') sessionId = value;

          const domains = ['.steamcommunity.com', 'steamcommunity.com', '.store.steampowered.com'];
          for (const domain of domains) {
            try {
              await bw.webContents.session.cookies.set({
                url: 'https://steamcommunity.com',
                name: name,
                value: value,
                domain: domain,
                path: '/',
                secure: true,
                httpOnly: name === 'steamLoginSecure' || name === 'sessionid' || name === 'steamRefresh_steam',
                sameSite: 'no_restriction',
                expirationDate: expiry
              });
            } catch (e) {
              // 忽略单个 cookie 设置错误
            }
          }
        }

        console.log('[confirm-all] sessionid from webCookies:', sessionId ? sessionId.substring(0, 10) + '...' : '未找到');

        // 如果 webCookies 中没有 sessionid，尝试从 Electron cookie store 回退读取
        if (!sessionId) {
          try {
            const cookies = await bw.webContents.session.cookies.get({ domain: 'steamcommunity.com', name: 'sessionid' });
            if (cookies && cookies.length > 0) {
              sessionId = cookies[0].value;
              console.log('[confirm-all] 从 cookie store 获取 sessionid:', sessionId.substring(0, 10) + '...');
            }
          } catch (e) {
            console.error('[confirm-all] 读取 cookie store 失败:', e.message);
          }
        }

        // 短暂等待确保 cookies 已写入
        await new Promise(r => setTimeout(r, 300));

        // 先导航到 Steam 任意页面，确保 cookie 生效且登录态建立
        const profileUrl = `https://steamcommunity.com/profiles/${steamId}`;

        // 监听页面加载
        bw.webContents.on('did-finish-load', async () => {
          const currentUrl = bw.webContents.getURL();
          console.log('[confirm-all] 页面加载完成:', currentUrl);

          // 检查是否被重定向到登录页
          if (currentUrl.includes('/login/') || currentUrl.includes('login.steampowered.com')) {
            return done({ success: false, error: 'Steam 登录态已过期，web_cookies 无效，请先重新登录获取' });
          }

          try {
            // 确保 sessionid 可用
            if (!sessionId) {
              // 最后尝试从页面中获取
              const pageSessionId = await bw.webContents.executeJavaScript(`
                (function() {
                  const g_sessionID = (typeof g_sessionID !== 'undefined') ? g_sessionID : '';
                  if (g_sessionID) return g_sessionID;
                  // 从 cookie 读取
                  const match = document.cookie.match(/sessionid=([^;]+)/);
                  return match ? match[1] : '';
                })()
              `);
              if (pageSessionId) {
                sessionId = pageSessionId;
                console.log('[confirm-all] 从页面获取 sessionid:', sessionId.substring(0, 10) + '...');
              }
            }

            if (!sessionId) {
              return done({ success: false, error: '无法获取 sessionid，cookie 中未包含 sessionid' });
            }

            // 在页面中发送 POST 请求到交易保护确认端点
            const result = await bw.webContents.executeJavaScript(`
              (function() {
                return new Promise((resolve, reject) => {
                  try {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', 'https://steamcommunity.com/trade/new/acknowledge', true);
                    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                    xhr.withCredentials = true;
                    xhr.timeout = 10000;

                    xhr.onload = function() {
                      try {
                        if (xhr.status === 0) {
                          return resolve({ success: false, error: '请求被阻止（状态码 0），可能是跨域或代理问题' });
                        }
                        if (xhr.status !== 200) {
                          return resolve({ success: false, error: 'HTTP ' + xhr.status + ': ' + String(xhr.responseText || '').substring(0, 200) });
                        }
                        const respText = xhr.responseText || '';
                        let respData;
                        try {
                          respData = JSON.parse(respText);
                        } catch (e) {
                          respData = { raw: respText };
                        }
                        resolve({
                          success: true,
                          response: respData
                        });
                      } catch (e) {
                        resolve({ success: false, error: '解析响应失败: ' + String(xhr.responseText || '').substring(0, 200) + ' | error: ' + e.message });
                      }
                    };

                    xhr.onerror = function() {
                      resolve({ success: false, error: '网络请求失败（可能是代理或连接问题）' });
                    };

                    xhr.ontimeout = function() {
                      resolve({ success: false, error: '请求超时（10秒）' });
                    };

                    const body = 'sessionid=' + encodeURIComponent('${sessionId}') + '&message=1';
                    xhr.send(body);
                  } catch (e) {
                    resolve({ success: false, error: e.message });
                  }
                });
              })()
            `);

            console.log('[confirm-all] API 请求结果:', JSON.stringify(result));

            if (!result) {
              done({ success: false, error: 'API 请求返回空结果' });
            } else if (result.success) {
              done({ success: true, message: '交易保护弹窗已确认并关闭' });
            } else {
              done({ success: false, error: result.error || '确认失败' });
            }

          } catch (err) {
            done({ success: false, error: '确认操作失败: ' + err.message });
          }
        });

        // 监听页面加载失败
        bw.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
          console.error('[confirm-all] 页面加载失败:', errorDescription);
          done({ success: false, error: '页面加载失败: ' + errorDescription + '（可能需要代理连接 steamcommunity.com）' });
        });

        // 加载个人资料页面（先建立登录态）
        console.log('[confirm-all] 开始加载:', profileUrl);
        await bw.loadURL(profileUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        // 超时处理
        setTimeout(() => {
          done({ success: false, error: '操作超时（30秒），请确认 web_cookies 有效且网络可访问 steamcommunity.com' });
        }, 30000);

      } catch (err) {
        done({ success: false, error: err.message });
      }
    });
  });
}

  // 编辑个人资料名称（将 Steam 个人资料名称改为与账户名一致）
  // 新策略：BrowserWindow 加载 edit 页面获取正确 Cookie 上下文 → 用 fetch 发 POST
  ipcMain.handle('edit-profile-name', async (event, { steamId, webCookies, accountName }) => {
    return new Promise(async (resolve) => {
      let bw = null;
      let resolved = false;

      function done(result) {
        if (resolved) return;
        resolved = true;
        if (bw && !bw.isDestroyed()) {
          try { bw.close(); } catch (_) {}
        }
        resolve(result);
      }

      try {
        if (!steamId) return done({ success: false, error: '缺少 steamId' });
        if (!accountName) return done({ success: false, error: '缺少目标名称' });
        if (!webCookies) return done({ success: false, error: '缺少 web_cookies，请先重新登录' });

        console.log('[edit-profile-name] 修改个人资料名称, steamId:', steamId, 'targetName:', accountName);

        bw = new BrowserWindow({
          width: 800, height: 600,
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        });

        // 设置 Steam 登录 cookies
        const cookieStrings = webCookies.split(';').map(c => c.trim()).filter(Boolean);
        const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

        console.log('[edit-profile-name] 设置 cookies, 共', cookieStrings.length, '条, webCookies 前100字符:', webCookies.substring(0, 100));

        let sessionId = '';
        const importantCookies = ['sessionid', 'steamLoginSecure', 'steamLogin', 'steamRefresh_steam', 'browserid', 'steamCountry'];
        for (const cs of cookieStrings) {
          const eqIdx = cs.indexOf('=');
          if (eqIdx === -1) continue;
          const name = cs.substring(0, eqIdx).trim();
          const value = cs.substring(eqIdx + 1);
          if (!name || !value) continue;

          if (name === 'sessionid') sessionId = value;

          // 只对重要的 Steam cookie 设置
          if (importantCookies.includes(name)) {
            // 用 cookie: URL 格式设置（更可靠）
            const cookieUrl = `https://steamcommunity.com/; ${name}=${value}; Domain=.steamcommunity.com; Path=/; Secure; HttpOnly; Max-Age=${30 * 24 * 60 * 60}`;
            try {
              await bw.webContents.loadURL(cookieUrl); // 不会真的加载，只是触发 cookie 设置
            } catch (_) {}

            // 也通过 cookies.set 设置
            const domains = ['.steamcommunity.com', 'steamcommunity.com'];
            for (const domain of domains) {
              try {
                await bw.webContents.session.cookies.set({
                  url: 'https://steamcommunity.com',
                  name, value, domain, path: '/',
                  secure: true,
                  httpOnly: true,
                  sameSite: 'no_restriction',
                  expirationDate: expiry
                });
              } catch (e) {
                console.log('[edit-profile-name] 设置 cookie 失败:', name, 'domain:', domain, 'error:', e.message);
              }
            }
          }
        }

        // 也尝试设置 store.steampowered.com 的 cookie
        try {
          const steamStoreCookies = await bw.webContents.session.cookies.get({ domain: 'steamcommunity.com' });
          for (const c of steamStoreCookies) {
            try {
              await bw.webContents.session.cookies.set({
                url: 'https://store.steampowered.com',
                name: c.name, value: c.value, domain: '.store.steampowered.com',
                path: '/', secure: true, httpOnly: c.httpOnly,
                sameSite: 'no_restriction', expirationDate: expiry
              });
            } catch (_) {}
          }
        } catch (_) {}

        if (!sessionId) {
          try {
            const cookies = await bw.webContents.session.cookies.get({ name: 'sessionid' });
            if (cookies && cookies.length > 0) sessionId = cookies[0].value;
          } catch (_) {}
        }

        // 验证 cookie 设置结果
        try {
          const setCookies = await bw.webContents.session.cookies.get({ domain: 'steamcommunity.com' });
          console.log('[edit-profile-name] 已设置的 steamcommunity cookies:', setCookies.map(c => c.name + '=' + c.value.substring(0, 20) + '...').join(', '));
        } catch (_) {}

        console.log('[edit-profile-name] sessionid:', sessionId ? sessionId.substring(0, 10) + '...' : '未找到');
        if (!sessionId) return done({ success: false, error: '无法获取 sessionid' });

        await new Promise(r => setTimeout(r, 500));

        // 先加载 Steam edit 页面建立 Cookie 上下文
        const profileUrl = `https://steamcommunity.com/profiles/${steamId}/edit`;
        console.log('[edit-profile-name] 加载 edit 页面建立 Cookie 上下文:', profileUrl);

        bw.webContents.on('did-finish-load', async () => {
          const currentUrl = bw.webContents.getURL();
          console.log('[edit-profile-name] 页面加载完成:', currentUrl);

          // 检查登录状态
          if (currentUrl.includes('/login/') || currentUrl.includes('login.steampowered.com')) {
            return done({ success: false, error: 'Steam 登录态已过期，web_cookies 无效，请先重新登录' });
          }

          // 页面加载后重新读取最新的 sessionid（Steam 可能会在加载时刷新）
          try {
            const freshCookies = await bw.webContents.session.cookies.get({ domain: 'steamcommunity.com', name: 'sessionid' });
            if (freshCookies && freshCookies.length > 0 && freshCookies[0].value) {
              sessionId = freshCookies[0].value;
              console.log('[edit-profile-name] 使用页面加载后的 sessionid:', sessionId.substring(0, 10) + '...');
            }
          } catch (_) {}

          // 也尝试从页面 JS 全局变量 g_sessionID 获取（页面加载后可能和 cookie 不同）
          try {
            const pageSessionId = await bw.webContents.executeJavaScript(`
              (function() {
                if (typeof g_sessionID !== 'undefined' && g_sessionID) return g_sessionID;
                // 尝试从页面中的脚本或 input 提取
                const m = document.documentElement.innerHTML.match(/g_sessionID\\s*=\\s*["']([a-f0-9]+)["']/i);
                if (m) return m[1];
                const input = document.querySelector('input[name="sessionID"], input[name="sessionid"]');
                if (input) return input.value;
                return '';
              })()
            `);
            if (pageSessionId && pageSessionId !== sessionId) {
              console.log('[edit-profile-name] 从页面获取到新的 sessionid:', pageSessionId.substring(0, 10) + '...');
              sessionId = pageSessionId;
            }
          } catch (e) {
            console.log('[edit-profile-name] 从页面获取 sessionid 失败:', e.message);
          }

          if (!sessionId) return done({ success: false, error: '无法获取 sessionid' });

          // 页面加载成功后，直接用 fetch 发 POST 请求（Cookie 由浏览器自动携带）
          try {
            // 先验证 Cookie 是否有效
            const cookieCheck = await bw.webContents.executeJavaScript(`
              (function() {
                return 'document.cookie length: ' + document.cookie.length + ', first 200 chars: ' + document.cookie.substring(0, 200);
              })()
            `);
            console.log('[edit-profile-name] 页面 Cookie 状态:', cookieCheck);

            const postUrl = `https://steamcommunity.com/profiles/${steamId}/edit`;
            console.log('[edit-profile-name] 发送 POST 请求到:', postUrl);

            const refererUrl = `https://steamcommunity.com/profiles/${steamId}/edit`;

            const result = await bw.webContents.executeJavaScript(`
              (async function() {
                try {
                  var formData = new URLSearchParams();
                  formData.append('sessionID', ${JSON.stringify(sessionId)});
                  formData.append('type', 'profileSave');
                  formData.append('personaName', ${JSON.stringify(accountName)});
                  formData.append('json', '1');
                  formData.append('real_name', '');
                  formData.append('summary', '');
                  formData.append('country', '');
                  formData.append('state', '');
                  formData.append('city', '');
                  formData.append('customURL', '');
                  formData.append('primary_group_steamid', '');
                  formData.append('weblink_1_title', '');
                  formData.append('weblink_1_url', '');
                  formData.append('weblink_2_title', '');
                  formData.append('weblink_2_url', '');
                  formData.append('weblink_3_title', '');
                  formData.append('weblink_3_url', '');

                  var resp = await fetch(${JSON.stringify(postUrl)}, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded',
                      'Origin': 'https://steamcommunity.com',
                      'Referer': ${JSON.stringify(refererUrl)},
                      'X-Requested-With': 'XMLHttpRequest',
                      'Accept': 'application/json, text/javascript, */*; q=0.01'
                    },
                    body: formData.toString(),
                    credentials: 'include'
                  });

                  var text = await resp.text();
                  console.log('[edit-profile-name-fetch] 响应状态:', resp.status, resp.statusText);
                  console.log('[edit-profile-name-fetch] 响应:', text.substring(0, 800));

                  try {
                    var json = JSON.parse(text);
                    if (json.success === 1) {
                      return { success: true, message: '个人资料名称已更新为: ' + ${JSON.stringify(accountName)} };
                    } else if (json.errmsg) {
                      return { success: false, error: json.errmsg };
                    } else if (json.success === false && json.message) {
                      return { success: false, error: json.message };
                    } else {
                      return { success: false, error: '未知响应: ' + JSON.stringify(json) };
                    }
                  } catch (e) {
                    // 响应不是 JSON，可能是 HTML（错误页面）
                    if (text.indexOf('登录') > -1 || text.indexOf('login') > -1 || text.indexOf('sign in') > -1) {
                      return { success: false, error: 'Cookie 无效，返回登录页面' };
                    }
                    if (text.indexOf('success') > -1 || text.indexOf('已成功') > -1) {
                      return { success: true, message: '个人资料名称已更新为: ' + ${JSON.stringify(accountName)} };
                    }
                    return { success: false, error: 'Steam 返回非 JSON 响应: ' + text.substring(0, 200) };
                  }
                } catch (err) {
                  return { success: false, error: 'fetch 请求失败: ' + err.message };
                }
              })()
            `);

            console.log('[edit-profile-name] 结果:', JSON.stringify(result));
            done(result || { success: false, error: '提交结果为空' });

          } catch (err) {
            done({ success: false, error: '页面操作失败: ' + err.message });
          }
        });

        bw.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
          console.error('[edit-profile-name] 页面加载失败:', errorDescription);
          done({ success: false, error: '页面加载失败: ' + errorDescription });
        });

        await bw.loadURL(profileUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        setTimeout(() => {
          done({ success: false, error: '操作超时（30秒），请确认 web_cookies 有效且网络可访问 steamcommunity.com' });
        }, 30000);

      } catch (err) {
        done({ success: false, error: err.message });
      }
    });
  });

  // 随机生成头像并替换 Steam 个人资料头像
  ipcMain.handle('random-avatar', async (event, { steamId, webCookies }) => {
    return new Promise(async (resolve) => {
      let bw = null;
      let resolved = false;

      function done(result) {
        if (resolved) return;
        resolved = true;
        if (bw && !bw.isDestroyed()) {
          try { bw.close(); } catch (_) {}
        }
        resolve(result);
      }

      try {
        if (!steamId) return done({ success: false, error: '缺少 steamId' });
        if (!webCookies) return done({ success: false, error: '缺少 web_cookies，请先重新登录' });

        // 处理 steam-session access_token sub 与传入 SteamID 不一致的问题
        // Steam 社区页面会校验 steamLoginSecure 前缀与 JWT sub 的一致性，不一致则判定 Cookie 无效
        const { effectiveSteamId, effectiveCookies } = getEffectiveConfirmationCookies(webCookies, steamId);
        if (String(effectiveSteamId) !== String(steamId)) {
          console.log(`[random-avatar] 检测到 cookie 身份不一致: 传入=${steamId}, cookie sub=${effectiveSteamId}, 将使用 ${effectiveSteamId} 请求`);
        }

        console.log('[random-avatar] 开始随机头像生成, steamId:', steamId, 'effectiveSteamId:', effectiveSteamId);

        bw = new BrowserWindow({
          width: 200, height: 200,
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        });

        // 设置 Steam 登录 cookies（使用统一后的 cookie，确保前缀与 JWT sub 一致）
        const cookieStrings = effectiveCookies.split(';').map(c => c.trim()).filter(Boolean);
        const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
        const importantCookies = ['sessionid', 'steamLoginSecure', 'steamLogin', 'steamRefresh_steam', 'browserid', 'steamCountry'];

        let sessionId = '';
        for (const cs of cookieStrings) {
          const eqIdx = cs.indexOf('=');
          if (eqIdx === -1) continue;
          const name = cs.substring(0, eqIdx).trim();
          const value = cs.substring(eqIdx + 1);
          if (!name || !value) continue;
          if (name === 'sessionid') sessionId = value;

          if (importantCookies.includes(name)) {
            const domains = ['.steamcommunity.com', 'steamcommunity.com'];
            for (const domain of domains) {
              try {
                await bw.webContents.session.cookies.set({
                  url: 'https://steamcommunity.com',
                  name, value, domain, path: '/',
                  secure: true, httpOnly: true,
                  sameSite: 'no_restriction', expirationDate: expiry
                });
              } catch (_) {}
            }
          }
        }

        if (!sessionId) {
          try {
            const cookies = await bw.webContents.session.cookies.get({ name: 'sessionid' });
            if (cookies && cookies.length > 0) sessionId = cookies[0].value;
          } catch (_) {}
        }
        console.log('[random-avatar] sessionid:', sessionId ? sessionId.substring(0, 10) + '...' : '未找到');
        if (!sessionId) return done({ success: false, error: '无法获取 sessionid' });

        // ===== 第一步：从 custom-avatars 文件夹随机选取一张头像图片 =====
        console.log('[random-avatar] 从 custom-avatars 文件夹随机选取头像...');
        let avatarBuffer = null;
        let avatarMimeType = 'image/png';
        let randomFile = 'avatar.png';
        try {
          const fs = require('fs');
          const path = require('path');
          const avatarsDir = path.join(__dirname, 'custom-avatars');
          
          if (!fs.existsSync(avatarsDir)) {
            return done({ success: false, error: 'custom-avatars 文件夹不存在，请在程序目录下创建 custom-avatars 文件夹并放入头像图片' });
          }
          
          const files = fs.readdirSync(avatarsDir).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
          });
          
          if (files.length === 0) {
            return done({ success: false, error: 'custom-avatars 文件夹中没有头像图片，请放入 .png/.jpg/.jpeg/.gif/.webp/.bmp 格式的图片' });
          }
          
          randomFile = files[Math.floor(Math.random() * files.length)];
          const filePath = path.join(avatarsDir, randomFile);
          const ext = path.extname(randomFile).toLowerCase();
          avatarMimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp'
            : ext === '.bmp' ? 'image/bmp'
            : 'image/png';
          
          avatarBuffer = fs.readFileSync(filePath);
          console.log('[random-avatar] 随机选中头像:', randomFile, '大小:', avatarBuffer.length, 'bytes');
        } catch (err) {
          console.error('[random-avatar] 读取本地头像失败:', err.message);
          return done({ success: false, error: '读取本地头像失败: ' + err.message });
        }

        // 加载 Steam 头像编辑页建立正确的 Cookie / session 上下文
        const profileUrl = `https://steamcommunity.com/profiles/${effectiveSteamId}/edit/avatar`;
        console.log('[random-avatar] 加载头像编辑页:', profileUrl);

        bw.webContents.on('did-finish-load', async () => {
          const currentUrl = bw.webContents.getURL();
          console.log('[random-avatar] 页面加载完成:', currentUrl);

          if (currentUrl.includes('/login/') || currentUrl.includes('login.steampowered.com')) {
            return done({ success: false, error: 'Steam 登录态已过期，web_cookies 无效' });
          }

          // 页面加载后重新读取最新的 sessionid（Steam 可能会在加载时刷新）
          try {
            const freshCookies = await bw.webContents.session.cookies.get({ domain: 'steamcommunity.com', name: 'sessionid' });
            if (freshCookies && freshCookies.length > 0 && freshCookies[0].value) {
              sessionId = freshCookies[0].value;
              console.log('[random-avatar] 使用页面加载后的 sessionid:', sessionId.substring(0, 10) + '...');
            }
          } catch (_) {}
          if (!sessionId) return done({ success: false, error: '无法获取 sessionid' });

          try {
            // 直接将本地头像图片上传到 Steam（不做任何裁剪/转换处理）
            const avatarBase64 = avatarBuffer.toString('base64');
            const result = await bw.webContents.executeJavaScript(`
              (async function() {
                try {
                  var avatarBase64 = ${JSON.stringify(avatarBase64)};
                  var avatarMime = ${JSON.stringify(avatarMimeType)};
                  var fileName = ${JSON.stringify(randomFile)};

                  // 从 base64 构建 Blob，保持原始格式
                  var byteString = atob(avatarBase64);
                  var ab = new ArrayBuffer(byteString.length);
                  var ia = new Uint8Array(ab);
                  for (var i = 0; i < byteString.length; i++) {
                    ia[i] = byteString.charCodeAt(i);
                  }
                  var avatarBlob = new Blob([ab], { type: avatarMime });

                  console.log('[random-avatar] 直接上传原始文件:', fileName, '大小:', avatarBlob.size, 'bytes');

                  // 上传到 Steam
                  var formData = new FormData();
                  formData.append('MAX_FILE_SIZE', avatarBlob.size);
                  formData.append('type', 'player_avatar_image');
                  formData.append('sId', ${JSON.stringify(effectiveSteamId)});
                  formData.append('sessionid', ${JSON.stringify(sessionId)});
                  formData.append('doSub', '1');
                  formData.append('json', '1');
                  formData.append('avatar', avatarBlob, fileName);

                  var uploadResp = await fetch('https://steamcommunity.com/actions/FileUploader', {
                    method: 'POST',
                    headers: {
                      'Origin': 'https://steamcommunity.com',
                      'Referer': ${JSON.stringify('https://steamcommunity.com/profiles/' + effectiveSteamId + '/edit/avatar')}
                    },
                    body: formData,
                    credentials: 'include'
                  });

                  var text = await uploadResp.text();
                  console.log('[random-avatar] 上传响应:', text.substring(0, 500));

                  try {
                    var json = JSON.parse(text);
                    if (json.success === true || json.success === 1) {
                      return { success: true, message: '头像已更换！', imageUrl: json.images ? json.images.full : '' };
                    } else if (json.errmsg) {
                      return { success: false, error: json.errmsg };
                    } else {
                      return { success: false, error: '未知响应: ' + JSON.stringify(json) };
                    }
                  } catch (e) {
                    if (text.indexOf('登录') > -1 || text.indexOf('login') > -1) {
                      return { success: false, error: 'Cookie 无效，返回登录页面' };
                    }
                    if (text.indexOf('success') > -1) {
                      return { success: true, message: '头像已更换！' };
                    }
                    return { success: false, error: 'Steam 返回非 JSON 响应: ' + text.substring(0, 200) };
                  }
                } catch (err) {
                  return { success: false, error: '操作失败: ' + err.message };
                }
              })()
            `);

            console.log('[random-avatar] 结果:', JSON.stringify(result));
            done(result || { success: false, error: '提交结果为空' });

          } catch (err) {
            done({ success: false, error: '页面操作失败: ' + err.message });
          }
        });

        bw.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
          console.error('[random-avatar] 页面加载失败:', errorDescription);
          done({ success: false, error: '页面加载失败: ' + errorDescription });
        });

        await bw.loadURL(profileUrl, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        setTimeout(() => {
          done({ success: false, error: '操作超时（30秒）' });
        }, 30000);

      } catch (err) {
        done({ success: false, error: err.message });
      }
    });
  });

// ============ 通过 SteamID 获取玩家头像 ============
// 使用 XML 接口获取头像 URL
// 注意：Steam XML 接口存在缓存延迟（几分钟到几十分钟），刚上传的头像可能不立即返回
function fetchSteamAvatarUrl(steamId64) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const request = net.request({
      method: 'GET',
      url: `https://steamcommunity.com/profiles/${steamId64}/?xml=1`,
      headers: { 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' }
    });

    let data = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        // 尝试提取 <avatarFull>
        const fullMatch = data.match(/<avatarFull><!\[CDATA\[(.+?)\]\]><\/avatarFull>/);
        if (fullMatch && fullMatch[1]) {
          console.log(`[avatar] XML avatarFull: ${steamId64}`);
          resolve(fullMatch[1]);
          return;
        }
        // 尝试提取 <avatarMedium>
        const mediumMatch = data.match(/<avatarMedium><!\[CDATA\[(.+?)\]\]><\/avatarMedium>/);
        if (mediumMatch && mediumMatch[1]) {
          resolve(mediumMatch[1]);
          return;
        }
        // 尝试提取 <avatarIcon>
        const iconMatch = data.match(/<avatarIcon><!\[CDATA\[(.+?)\]\]><\/avatarIcon>/);
        if (iconMatch && iconMatch[1]) {
          resolve(iconMatch[1]);
          return;
        }
        console.log(`[avatar] XML 无头像: ${steamId64}`);
        resolve(null);
      });
      response.on('error', () => { resolve(null); });
    });
    request.on('error', () => { resolve(null); });
    request.end();
  });
}

// 当 XML 接口缓存未更新时，通过带 cookie 的 session 请求 HTML 页面提取头像
function fetchSteamAvatarFromHtml(steamId64, webCookies) {
  return new Promise(async (resolve) => {
    try {
      const profileUrl = `https://steamcommunity.com/profiles/${steamId64}/`;

      // 使用 Electron 的 net.request（自动走系统代理），
      // 但通过 session 预置 cookie 来绕过 httpOnly 限制
      const ses = session.defaultSession;
      const cookieDomain = 'https://steamcommunity.com';

      // 解析 cookie 字符串并逐个设置到 session
      if (webCookies) {
        const cookiePairs = webCookies.split(';').map(c => c.trim()).filter(c => c);
        for (const pair of cookiePairs) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx <= 0) continue;
          const name = pair.substring(0, eqIdx).trim();
          const value = pair.substring(eqIdx + 1).trim();
          try {
            await ses.cookies.set({
              url: cookieDomain,
              name: name,
              value: value,
              httpOnly: false,
              secure: true,
              sameSite: 'no_restriction'
            });
          } catch (e) {
            // 忽略单个 cookie 设置错误
          }
        }
      }

      const { net } = require('electron');
      const request = net.request({
        method: 'GET',
        url: profileUrl,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      let html = '';
      request.on('response', (response) => {
        // 处理重定向
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          console.log(`[avatar] 重定向 ${response.statusCode}: ${steamId64} -> ${response.headers.location}`);
          resolve(null);
          return;
        }
        response.on('data', (chunk) => { html += chunk.toString(); });
        response.on('end', () => {
          // 匹配 playerAvatar 中的 src 或 srcset（支持多行）
          const m1 = html.match(/playerAvatar[\s\S]{0,200}?(?:src|srcset)="(https:\/\/avatars\.[^"]+\.(?:jpg|png|gif))"/i);
          if (m1 && m1[1]) {
            console.log(`[avatar] HTML 提取头像成功: ${steamId64} -> ${m1[1]}`);
            resolve(m1[1]);
            return;
          }
          // 备用: data-miniprofile
          const m2 = html.match(/data-miniprofile[\s\S]{0,200}?(?:src|srcset)="(https:\/\/avatars\.[^"]+\.(?:jpg|png|gif))"/i);
          if (m2 && m2[1]) {
            console.log(`[avatar] data-miniprofile 提取: ${steamId64} -> ${m2[1]}`);
            resolve(m2[1]);
            return;
          }
          // 兜底：直接匹配页面中的 _full 头像
          const m3 = html.match(/https:\/\/avatars\.[^"]+_full\.(?:jpg|png|gif)/i);
          if (m3 && m3[0]) {
            console.log(`[avatar] HTML 兜底匹配头像: ${steamId64} -> ${m3[0]}`);
            resolve(m3[0]);
            return;
          }
          console.log(`[avatar] HTML 也未找到头像: ${steamId64}, 页面长度: ${html.length}`);
          resolve(null);
        });
        response.on('error', (e) => {
          console.log(`[avatar] HTML 响应异常: ${steamId64} - ${e.message}`);
          resolve(null);
        });
      });

      request.on('error', (e) => {
        console.log(`[avatar] HTML 请求异常: ${steamId64} - ${e.message}`);
        resolve(null);
      });
      request.end();
    } catch (e) {
      console.log(`[avatar] HTML 请求异常: ${e.message}`);
      resolve(null);
    }
  });
}

// 下载图片并转为 base64 data URI
function downloadImageAsDataUri(imageUrl) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const url = new URL(imageUrl);
    const request = net.request({
      method: 'GET',
      url: imageUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const chunks = [];
    let contentType = 'image/jpeg';
    request.on('response', (response) => {
      contentType = response.headers['content-type'] || contentType;
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 0) {
          const base64 = buffer.toString('base64');
          resolve(`data:${contentType};base64,${base64}`);
        } else {
          resolve(null);
        }
      });
      response.on('error', () => { resolve(null); });
    });
    request.on('error', () => { resolve(null); });
    request.end();
  });
}

// ============ 通过 SteamID 获取玩家名称 ============
// 使用 steamcommunity.com 的 XML 接口，不需要 API key
function fetchPlayerName(steamId64) {
  return new Promise((resolve, reject) => {
    const { net } = require('electron');
    const request = net.request({
      method: 'GET',
      url: `https://steamcommunity.com/profiles/${steamId64}/?xml=1`
    });

    let data = '';
    let statusCode = 0;
    request.on('response', (response) => {
      statusCode = response.statusCode;
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        if (statusCode !== 200) {
          console.log(`[fetchName] steamId=${steamId64} 状态码=${statusCode}`);
          resolve(null);
          return;
        }
        // 从 XML 中提取 <steamID><![CDATA[名称]]></steamID>
        const match = data.match(/<steamID><!\[CDATA\[(.+?)\]\]><\/steamID>/);
        if (match && match[1]) {
          resolve(match[1]);
        } else {
          resolve(null); // 用户未设置 Steam 社区名称
        }
      });
      response.on('error', () => { resolve(null); });
    });
    request.on('error', (err) => {
      console.log(`[fetchName] 网络错误:`, err.message);
      resolve(null);
    });
    request.end();
  });
}

// 批量获取玩家名称（每批最多 20 个并发）
async function fetchPlayerNamesBatch(steamIds) {
  const results = {};
  // 分批处理，每批 10 个并发
  for (let i = 0; i < steamIds.length; i += 10) {
    const batch = steamIds.slice(i, i + 10);
    const names = await Promise.all(batch.map(async (sid) => {
      const name = await fetchPlayerName(sid);
      return { steamId: sid, name };
    }));
    for (const { steamId, name } of names) {
      if (name) results[steamId] = name;
    }
  }
  return results;
}

// ============ 交易确认密钥生成 ============
// 直接使用 steam-totp 库的 getConfirmationKey（HMAC-SHA1）
function generateConfirmationKey(identitySecret, time, tag) {
  if (!identitySecret) return '';
  try {
    return SteamTotp.getConfirmationKey(identitySecret, time, tag);
  } catch (e) {
    console.error('生成确认密钥失败:', e.message);
    return '';
  }
}

// ============ App 生命周期 ============
app.whenReady().then(() => {
  // 先修复已有 maFile 中 steamLoginSecure 的错误 SteamID 前缀
  migrateFixSteamLoginSecureCookies();

  // 设置 Dock 图标
  const iconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
    const iconImg = nativeImage.createFromPath(iconPath);
    if (!iconImg.isEmpty()) {
      app.dock.setIcon(iconImg);
      console.log('[main] Dock 图标已设置:', iconPath);
    } else {
      console.error('[main] 图标文件无效:', iconPath);
    }
  } else {
    console.error('[main] 图标文件不存在:', iconPath);
  }

  setupIPC();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { isQuitting = true; });
