const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 账号管理
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  saveAccount: (data) => ipcRenderer.invoke('save-account', data),
  deleteAccount: (steamId) => ipcRenderer.invoke('delete-account', steamId),

  // TOTP
  generateCode: (secret) => ipcRenderer.invoke('generate-code', secret),
  generateCodesBatch: (secrets) => ipcRenderer.invoke('generate-codes-batch', secrets),
  isValidSecret: (secret) => ipcRenderer.invoke('is-valid-secret', secret),

  // 剪贴板
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // 导入导出
  importAccounts: () => ipcRenderer.invoke('import-accounts'),
  exportSingleAccount: (data) => ipcRenderer.invoke('export-single-account', data),

  // 账号功能
  setInventoryPublic: (data) => ipcRenderer.invoke('set-inventory-public', data),
  editProfileName: (data) => ipcRenderer.invoke('edit-profile-name', data),
  randomAvatar: (data) => ipcRenderer.invoke('random-avatar', data),
  refreshMafile: (data) => ipcRenderer.invoke('refresh-mafile', data),
  confirmAllAndClose: (data) => ipcRenderer.invoke('confirm-all-and-close', data),

  // steam-session 两阶段登录（MobileApp 平台，获取 JWT access token）
  steamLoginPhase1: (data) => ipcRenderer.invoke('steam-login-phase1', data),
  steamLoginPhase2: (data) => ipcRenderer.invoke('steam-login-phase2', data),
  // 合并的两阶段登录（自动处理 guard code）
  steamLogin: (data) => ipcRenderer.invoke('steam-login', data),

  // 绑定 API
  addAuthenticator: (data) => ipcRenderer.invoke('add-authenticator', data),
  finalizeAuthenticator: (data) => ipcRenderer.invoke('finalize-authenticator', data),
  queryAuthStatus: (data) => ipcRenderer.invoke('query-auth-status', data),
  // bind-renderer 使用的合并 API
  sendEmailCode: (data) => ipcRenderer.invoke('send-email-code', data),
  verifyEmailCode: (data) => ipcRenderer.invoke('verify-email-code', data),
  saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),

  // 重新登录获取 access_token（两阶段）
  reloginPhase1: (data) => ipcRenderer.invoke('relogin-for-access-token', data),
  reloginPhase2: (data) => ipcRenderer.invoke('relogin-guard', data),

  // QR 点击登录（屏幕截图 + LoginApprover 批准）
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  approveQRLogin: (data) => ipcRenderer.invoke('approve-qr-login', data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 交易确认
  getConfirmations: (data) => ipcRenderer.invoke('get-confirmations', data),
  confirmTrade: (data) => ipcRenderer.invoke('confirm-trade', data),

  // 头像获取
  getSteamAvatar: (steamId) => ipcRenderer.invoke('get-steam-avatar', steamId),

  // 根据 SteamID 获取玩家名称
  fetchPlayerNames: (steamIds) => ipcRenderer.invoke('fetch-player-names', steamIds),

  // 窗口
  hideWindow: () => ipcRenderer.send('hide-window'),

  // 事件监听
  onLoginSuccess: (cb) => ipcRenderer.on('login-success', (event, data) => cb(data)),
  onCopyLatestCode: (cb) => ipcRenderer.on('copy-latest-code', () => cb()),

  // 独立确认窗口
  openConfirmationWindow: (data, theme) => ipcRenderer.invoke('open-confirmation-window', data, theme),
  onConfirmationData: (cb) => ipcRenderer.on('confirmation-data', (event, data) => cb(data)),
  requestConfirmationData: () => ipcRenderer.send('request-confirmation-data'),
  updateConfirmationData: (data) => ipcRenderer.send('update-confirmation-data', data),
  onReloginDoneRefresh: (cb) => ipcRenderer.on('relogin-done-refresh', (event, data) => cb(data)),

  // 账号排序
  saveAccountOrder: (order) => ipcRenderer.invoke('save-account-order', order),

  // 绑定窗口
  openBindWindow: (theme) => ipcRenderer.invoke('open-bind-window', theme),
  closeBindWindow: () => ipcRenderer.send('close-bind-window'),
  notifyBindComplete: () => ipcRenderer.send('bind-complete'),
  onBindComplete: (cb) => ipcRenderer.on('bind-complete', () => cb()),
  // 通用窗口高度自适应：前端传入 .content 的实际高度（不含 titlebar），主进程据此调整窗口
  setWindowHeight: (height) => ipcRenderer.send('set-window-height', height),

  // 重新登录窗口
  openReloginWindow: (data, theme) => ipcRenderer.invoke('open-relogin-window', data, theme),
  requestReloginData: () => ipcRenderer.invoke('request-relogin-data'),
  onReloginInit: (cb) => ipcRenderer.on('relogin-init', (event, data) => cb(data)),
  notifyReloginDone: (data) => ipcRenderer.send('relogin-done', data),
  closeReloginWindow: () => ipcRenderer.send('close-relogin-window'),
  onReloginDone: (cb) => ipcRenderer.on('relogin-done', (event, data) => cb(data)),
  reloginSubmit: (data) => ipcRenderer.invoke('relogin-submit', data),

  // 主题同步
  notifyThemeChange: (theme) => ipcRenderer.send('theme-changed', theme),
  onThemeChange: (cb) => ipcRenderer.on('theme-changed', (event, theme) => cb(theme)),

  // 确认窗口请求重新登录（cookie 过期时）
  requestRelogin: (data) => ipcRenderer.send('confirmation-request-relogin', data),
  onConfirmationRequestRelogin: (cb) => ipcRenderer.on('confirmation-request-relogin', (event, data) => cb(data))
});
