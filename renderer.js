/**
 * Steam Authenticator - 渲染进程
 * 支持：令牌显示、搜索筛选、交易确认、分组列表、倒计时圆环
 */

console.log('[renderer] 脚本已加载');

// ============ State ============
let accounts = [];
let filteredAccounts = [];
let searchQuery = '';
let refreshTimer = null;
let selectedUid = null;
let selectedIndex = 0; // 在 filteredAccounts 中的索引
let countdown = 30;
const TOTAL_SECONDS = 30;
const CIRCUMFERENCE = 2 * Math.PI * 22; // r=22

let bindState = {
  steamId: '',
  accessToken: '',
  webCookies: '',
  refreshToken: '',
  sharedSecret: '',
  identitySecret: '',
  secret1: '',
  accountData: null,
  revocationCode: '',
  sessionId: '',
  accountName: ''
};
let accountIdMap = {};

let accountNamesFetched = false;
let accountNamesFetchRetries = 0;

// ============ DOM ============
const authCard = document.getElementById('authCard');
const accountAvatar = document.getElementById('accountAvatar');
const accountName = document.getElementById('accountName');
const accountId = document.getElementById('accountId');
const authCode = document.getElementById('authCode');
const countdownText = document.getElementById('countdownText');
const countdownCircle = document.getElementById('countdownCircle');
const progressBar = document.getElementById('progressBar');
const copyBtn = document.getElementById('copyBtn');
const copyText = document.getElementById('copyText');
const copyIcon = document.getElementById('copyIcon');
const listContent = document.getElementById('listContent');
const listCount = document.getElementById('listCount');
const totalBadge = document.getElementById('totalBadge');
const searchInput = document.getElementById('searchInput');
const toast = document.getElementById('toast');

const btnBind = document.getElementById('btn-bind');
const btnImport = document.getElementById('btn-import');
const btnQRClickLogin = document.getElementById('btn-qr-click-login');
const modalBind = document.getElementById('modal-bind');
const bindClose = document.getElementById('bind-close');

// QR Click Login Modal
const modalQRClick = document.getElementById('modal-qr-click');
const qrClickClose = document.getElementById('qr-click-close');
const qrClickAccountSelect = document.getElementById('qr-click-account-select');
const qrClickStatus = document.getElementById('qr-click-status');
const qrClickStatusText = document.getElementById('qr-click-status-text');
const qrClickResult = document.getElementById('qr-click-result');
const btnQRClickDetect = document.getElementById('btn-qr-click-detect');

// Confirmation Modal
const modalConfirmations = document.getElementById('modal-confirmations');
const confirmationsClose = document.getElementById('confirmations-close');

const stepLogin = document.getElementById('step-login');
const stepPhone = document.getElementById('step-phone');
const stepRevocation = document.getElementById('step-revocation');
const stepDone = document.getElementById('step-done');

// Context Menu
const contextMenu = document.getElementById('context-menu');
let contextMenuTargetUid = null;

// ============ Init ============
async function init() {
  console.log('[init] DOM 检查 - searchInput:', !!searchInput);
  initTheme();
  if (searchInput) {
    searchInput.addEventListener('input', onSearchInput);
    console.log('[init] 搜索事件已绑定');
  }
  try { await loadAccounts(); } catch (e) { console.error('init error:', e); }
  startRefreshTimer();
  setupEvents();
  console.log('[init] 初始化完成, accounts:', accounts.length);
}

async function loadAccounts() {
  accounts = await window.electronAPI.getAccounts();
  accounts.forEach((acc, i) => {
    if (typeof acc.SteamID === 'number') acc.SteamID = String(acc.SteamID);
    if (!acc.SteamID && acc.Session && acc.Session.SteamID) acc.SteamID = String(acc.Session.SteamID);
    if (typeof acc.Session?.SteamID === 'number') acc.Session.SteamID = String(acc.Session.SteamID);
    if (!acc._uid) {
      const sid = acc.SteamID || (acc.Session && acc.Session.SteamID);
      acc._uid = sid ? `${sid}_${i}` : `acc_${i}_${Date.now()}`;
    }
  });
  rebuildIdMap();
  applyFilter();
  renderAccounts();
  fetchMissingAccountNames();
}

async function fetchMissingAccountNames() {
  if (accountNamesFetched) return;
  if (accountNamesFetchRetries >= 3) return;
  accountNamesFetchRetries++;

  const needFetch = [];
  accounts.forEach(acc => {
    const sid = getSteamId(acc);
    if (sid && !acc.account_name) needFetch.push(sid);
  });

  if (needFetch.length === 0) { accountNamesFetched = true; return; }

  console.log(`[fetchNames] 需要从 Steam 获取 ${needFetch.length} 个账号的名称 (第${accountNamesFetchRetries}次)...`);
  try {
    const result = await window.electronAPI.fetchPlayerNames(needFetch);
    if (result.success && result.names) {
      let updated = 0;
      accounts.forEach(acc => {
        const sid = getSteamId(acc);
        if (sid && result.names[sid]) { acc.account_name = result.names[sid]; updated++; }
      });
      if (updated > 0) {
        console.log(`[fetchNames] 成功获取 ${updated} 个账号名称`);
        accountNamesFetched = true;
        rebuildIdMap();
        applyFilter();
        renderAccounts();
      } else {
        accountNamesFetched = true;
      }
    } else {
      setTimeout(() => { accountNamesFetched = false; fetchMissingAccountNames(); }, 5000);
    }
  } catch (err) {
    setTimeout(() => { accountNamesFetched = false; fetchMissingAccountNames(); }, 5000);
  }
}

function rebuildIdMap() {
  accountIdMap = {};
  accounts.forEach(acc => { accountIdMap[acc._uid] = acc; });
}

function applyFilter() {
  const trimmedQuery = searchQuery.trim();
  if (trimmedQuery) {
    const q = trimmedQuery.toLowerCase();
    filteredAccounts = accounts.filter((acc, i) => {
      const name = String(acc.account_name || getSteamId(acc) || `账号 ${i + 1}`).toLowerCase();
      const steamId = getSteamId(acc).toLowerCase();
      return name.includes(q) || steamId.includes(q);
    });
  } else {
    filteredAccounts = [...accounts];
  }
}

// ============ Group Accounts ============
function groupAccounts(list) {
  const groups = {};
  list.forEach(acc => {
    const name = acc.account_name || getSteamId(acc) || '';
    const letter = (name[0] || '#').toUpperCase();
    const key = /[A-Z]/.test(letter) ? letter : '#';
    if (!groups[key]) groups[key] = [];
    groups[key].push(acc);
  });
  return Object.entries(groups).sort((a, b) => {
    if (a[0] === '#') return 1;
    if (b[0] === '#') return -1;
    return a[0].localeCompare(b[0]);
  });
}

// ============ Render List ============
function renderAccounts() {
  if (filteredAccounts.length === 0 && accounts.length > 0) {
    listContent.innerHTML = `<div class="empty-state">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </div>
      <p class="empty-title">未找到匹配的账号</p>
      <p class="empty-desc">尝试其他搜索关键词</p>
    </div>`;
    listCount.textContent = `共 0 个账号`;
    totalBadge.textContent = `0 / ${accounts.length}`;
    return;
  }

  if (accounts.length === 0) {
    listContent.innerHTML = `<div class="empty-state">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      </div>
      <p class="empty-title">暂无 Steam 令牌</p>
      <p class="empty-desc">点击上方「添加新账号」直接登录 Steam 绑定验证器</p>
    </div>`;
    listCount.textContent = '共 0 个账号';
    totalBadge.textContent = '0 / 0';
    return;
  }

  // Default select first
  if (!selectedUid && filteredAccounts.length > 0) {
    selectedIndex = 0;
    selectedUid = filteredAccounts[0]._uid;
  }

  // Ensure selectedIndex is valid
  if (selectedUid) {
    const idx = filteredAccounts.findIndex(a => a._uid === selectedUid);
    if (idx >= 0) selectedIndex = idx;
    else { selectedIndex = 0; selectedUid = filteredAccounts[0]._uid; }
  }

  const groups = groupAccounts(filteredAccounts);
  const selectedAcc = filteredAccounts[selectedIndex];

  listContent.innerHTML = '';
  let globalIndex = 0;

  groups.forEach(([letter, items]) => {
    const group = document.createElement('div');
    group.className = 'group';
    group.innerHTML = `
      <div class="group-header" role="button" aria-expanded="true" tabindex="0">
        <div class="group-toggle">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="group-letter">${letter}</div>
        <div class="group-count">${items.length} 个</div>
      </div>
      <div class="group-items"></div>
    `;

    const groupItems = group.querySelector('.group-items');
    items.forEach(acc => {
      const isSelected = selectedAcc && acc._uid === selectedAcc._uid;
      const item = document.createElement('div');
      item.className = `account-item ${isSelected ? 'selected' : ''}`;
      item.dataset.index = globalIndex;
      item.dataset.uid = acc._uid;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', isSelected);
      item.tabIndex = -1;
      const name = acc.account_name || getSteamId(acc) || `账号 ${globalIndex + 1}`;
      const sid = getSteamId(acc);
      item.innerHTML = `
        <div class="item-avatar">${(name[0] || '?').toUpperCase()}</div>
        <div class="item-main">
          <div class="item-name">${escHtml(name)}</div>
          <div class="item-id">${escHtml(sid)}</div>
        </div>
        <button class="item-confirm-btn" title="交易确认" aria-label="交易确认">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      `;
      // 确认按钮点击事件
      const confirmBtn = item.querySelector('.item-confirm-btn');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          const uid = item.dataset.uid;
          const idx = filteredAccounts.findIndex(a => a._uid === uid);
          if (idx >= 0) {
            selectAccountByIndex(idx);
            const realIdx = accounts.indexOf(filteredAccounts[idx]);
            if (realIdx >= 0) openConfirmationsModal(realIdx);
          }
        });
      }

      item.addEventListener('click', function(e) {
        e.stopPropagation();
        const uid = this.dataset.uid;
        const idx = filteredAccounts.findIndex(a => a._uid === uid);
        if (idx >= 0) selectAccountByIndex(idx);
      });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = item.dataset.uid;
        const idx = filteredAccounts.findIndex(a => a._uid === uid);
        if (idx >= 0) selectAccountByIndex(idx);
        contextMenuTargetUid = acc._uid;
        const menuW = 220;
        const menuH = 460;
        let left = e.clientX;
        let top = e.clientY;
        if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
        if (top + menuH > window.innerHeight) top = window.innerHeight - menuH - 8;
        contextMenu.style.left = left + 'px';
        contextMenu.style.top = top + 'px';
        contextMenu.style.display = 'block';
      });
      groupItems.appendChild(item);
      globalIndex++;
    });

    // Group toggle
    const header = group.querySelector('.group-header');
    const toggleGroup = () => group.classList.toggle('collapsed');
    header.addEventListener('click', toggleGroup);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(); }
    });

    listContent.appendChild(group);
  });

  listCount.textContent = `共 ${filteredAccounts.length} 个账号`;
  totalBadge.textContent = `${filteredAccounts.length} / ${accounts.length}`;

  updateAuthCard();
}

// ============ Auth Card ============
function updateAuthCard() {
  if (!selectedUid || filteredAccounts.length === 0) return;
  const acc = getAccountByUid(selectedUid);
  if (!acc) return;

  const name = acc.account_name || getSteamId(acc) || '未知';
  accountName.textContent = name;
  const sid = getSteamId(acc);
  accountId.textContent = sid;

  // 加载 Steam 头像
  const initial = (name[0] || '?').toUpperCase();
  if (sid) {
    loadAvatarForCard(sid, initial);
  } else {
    setAvatarFallback(initial);
  }
}

async function loadAvatarForCard(steamId, fallbackInitial) {
  try {
    const result = await window.electronAPI.getSteamAvatar(steamId);
    if (result && result.success && result.url) {
      const img = new Image();
      img.onload = () => {
        accountAvatar.innerHTML = '';
        accountAvatar.appendChild(img);
      };
      img.onerror = () => {
        setAvatarFallback(fallbackInitial);
      };
      img.src = result.url;
    } else {
      setAvatarFallback(fallbackInitial);
    }
  } catch (e) {
    setAvatarFallback(fallbackInitial);
  }
}

function setAvatarFallback(initial) {
  accountAvatar.innerHTML = '';
  accountAvatar.textContent = initial;
}

// ============ Select Account ============
function selectAccountByIndex(index) {
  if (index < 0 || index >= filteredAccounts.length) return;
  selectedIndex = index;
  selectedUid = filteredAccounts[index]._uid;

  // Update list selection (用 uid 匹配，因为分组排序后 data-index 不再对应 filteredAccounts 索引)
  listContent.querySelectorAll('.account-item.selected').forEach(el => el.classList.remove('selected'));
  const target = listContent.querySelector(`.account-item[data-uid="${selectedUid}"]`);
  if (target) {
    target.classList.add('selected');
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  updateAuthCard();
  // 切换账号后立即刷新验证码和倒计时
  countdown = 0; // 让下一次 updateCodes 立即生成新验证码
  updateCodes();
}

// ============ Timer ============
async function updateCodes() {
  if (accounts.length === 0 || !selectedUid) return;

  countdown--;
  if (countdown < 0) {
    countdown = TOTAL_SECONDS;
    // Generate new code
    const acc = getAccountByUid(selectedUid);
    if (acc?.shared_secret) {
      const result = await window.electronAPI.generateCode(acc.shared_secret);
      if (result?.code) authCode.textContent = result.code;
    }
  }

  const ratio = countdown / TOTAL_SECONDS;
  const offset = CIRCUMFERENCE * (1 - ratio);
  countdownCircle.style.strokeDashoffset = offset;
  if (progressBar) progressBar.style.width = `${ratio * 100}%`;
  countdownText.textContent = countdown;

  // Reset states
  authCode.classList.remove('warning', 'danger');
  countdownText.classList.remove('warning', 'danger');
  countdownCircle.setAttribute('stroke', 'var(--accent)');
  if (progressBar) progressBar.style.background = 'var(--accent)';

  if (countdown <= 5) {
    authCode.classList.add('danger');
    countdownText.classList.add('danger');
    countdownCircle.setAttribute('stroke', 'var(--danger)');
    if (progressBar) progressBar.style.background = 'var(--danger)';
  } else if (countdown <= 10) {
    authCode.classList.add('warning');
    countdownText.classList.add('warning');
    countdownCircle.setAttribute('stroke', 'var(--warning)');
    if (progressBar) progressBar.style.background = 'var(--warning)';
  }
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  // Initialize countdown circle
  countdownCircle.style.strokeDasharray = CIRCUMFERENCE;
  refreshTimer = setInterval(updateCodes, 1000);
}

// ============ Search ============
function onSearchInput() {
  searchQuery = searchInput.value;
  applyFilter();
  selectedIndex = 0;
  if (filteredAccounts.length > 0) {
    selectedUid = filteredAccounts[0]._uid;
  } else {
    selectedUid = null;
  }
  renderAccounts();
}

// ============ Copy ============
async function copyCode() {
  if (!selectedUid) return;
  const acc = getAccountByUid(selectedUid);
  if (!acc?.shared_secret) return;

  const result = await window.electronAPI.generateCode(acc.shared_secret);
  const code = result?.code;
  if (!code || code === 'ERR') return;

  if (navigator.clipboard) navigator.clipboard.writeText(code);
  window.electronAPI.copyToClipboard(code);

  copyText.textContent = '已复制';
  copyBtn.classList.add('copied');
  copyIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
  toast.classList.add('show');

  setTimeout(() => {
    copyText.textContent = '复制';
    copyBtn.classList.remove('copied');
    copyIcon.innerHTML = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>';
    toast.classList.remove('show');
  }, 1800);
}

// ============ Helpers ============
function getAccountByUid(uid) {
  return accountIdMap[uid] || null;
}

function getSteamId(acc) {
  if (!acc) return '';
  const sid = acc.SteamID || acc.steamid || (acc.Session && acc.Session.SteamID);
  return sid ? String(sid) : '';
}

function escHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ============ Toast ============
let toastTimeout;
function showToast(msg, type) {
  toast.textContent = msg;
  toast.className = 'toast ' + (type || '') + ' show';
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.classList.remove('show'); }, 2500);
}

// ============ Theme ============
function initTheme() {
  const saved = localStorage.getItem('steam-auth-theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  if (current === 'light') {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('steam-auth-theme', 'dark');
    showToast('已切换为深色主题', 'success');
  } else if (current === 'dark') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('steam-auth-theme');
    showToast('已切换为跟随系统', 'success');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('steam-auth-theme', 'light');
    showToast('已切换为浅色主题', 'success');
  }
  window.electronAPI.notifyThemeChange(getCurrentTheme());
}
function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'system';
}

// ============ Context Menu ============
function hideContextMenu() {
  contextMenu.style.display = 'none';
  contextMenuTargetUid = null;
}
document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
}, true);
document.addEventListener('contextmenu', (e) => {
  if (!contextMenu.contains(e.target) && !e.target.closest('.account-item')) {
    hideContextMenu();
  }
});

// ============ Bind Modal ============
function openBindModal() {
  bindState = { steamId: '', accessToken: '', webCookies: '', refreshToken: '', sharedSecret: '', identitySecret: '', secret1: '', accountData: null, revocationCode: '', sessionId: '', accountName: '' };
  stepLogin.style.display = 'block';
  stepPhone.style.display = 'none';
  stepRevocation.style.display = 'none';
  stepDone.style.display = 'none';
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-guard-code').value = '';
  document.getElementById('guard-code-group').style.display = 'none';
  document.getElementById('login-status').style.display = 'none';
  document.getElementById('btn-steam-login').disabled = false;
  document.getElementById('btn-steam-login').textContent = '登录 Steam';
  document.getElementById('sms-status').style.display = 'none';
  document.getElementById('sms-code').value = '';
  document.getElementById('email-code-section').style.display = 'none';
  document.getElementById('btn-send-sms').disabled = false;
  document.getElementById('btn-verify-sms').disabled = false;
  document.getElementById('confirm-revocation-saved').checked = false;
  document.getElementById('btn-confirm-revocation').disabled = true;
  modalBind.style.display = 'flex';
  document.getElementById('login-username').focus();
}
function closeBindModal() {
  modalBind.style.display = 'none';
  bindState = { steamId: '', accessToken: '', webCookies: '', refreshToken: '', sharedSecret: '', identitySecret: '', secret1: '', accountData: null, revocationCode: '', sessionId: '', accountName: '' };
}

// Steam Login Phase 1
async function steamLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  if (!username || !password) { showToast('请输入 Steam 账号和密码', 'error'); return; }
  const statusBox = document.getElementById('login-status');
  const statusText = document.getElementById('login-status-text');
  statusBox.style.display = 'flex';
  statusText.textContent = '正在登录 Steam（模拟手机 App）...';
  document.getElementById('btn-steam-login').disabled = true;
  try {
    const result = await window.electronAPI.steamLoginPhase1({ username, password });
    if (!result.success) {
      statusText.textContent = '[错误] ' + (result.error || '登录失败');
      document.getElementById('btn-steam-login').disabled = false;
      return;
    }
    if (result.needGuard) {
      statusText.textContent = '[警告] 需要验证: ' + (result.guardType || '验证码');
      document.getElementById('guard-code-group').style.display = 'block';
      document.getElementById('guard-hint').textContent = '请查收你的 ' + (result.guardType || '邮箱/手机') + '，输入验证码后再次点击登录';
      document.getElementById('login-guard-code').focus();
      document.getElementById('btn-steam-login').disabled = false;
      document.getElementById('btn-steam-login').textContent = '提交验证码并登录';
      bindState.sessionId = result.sessionId;
      return;
    }
    onLoginSuccess(result);
  } catch (err) {
    statusText.textContent = '[错误] ' + err.message;
    document.getElementById('btn-steam-login').disabled = false;
  }
}

// Steam Login Phase 2 (with guard code)
async function steamLoginWithGuard() {
  const guardCode = document.getElementById('login-guard-code').value.trim();
  if (!guardCode) { showToast('请输入 Steam Guard 验证码', 'error'); return; }
  const statusText = document.getElementById('login-status-text');
  statusText.textContent = '正在验证 Steam Guard 验证码...';
  document.getElementById('btn-steam-login').disabled = true;
  try {
    const result = await window.electronAPI.steamLoginPhase2({ sessionId: bindState.sessionId, guardCode });
    if (!result.success) {
      statusText.textContent = '[错误] ' + (result.error || '验证码错误');
      document.getElementById('btn-steam-login').disabled = false;
      return;
    }
    onLoginSuccess(result);
  } catch (err) {
    statusText.textContent = '[错误] ' + err.message;
    document.getElementById('btn-steam-login').disabled = false;
  }
}

function onLoginSuccess(result) {
  bindState.steamId = result.steamId;
  bindState.accessToken = result.accessToken;
  bindState.webCookies = result.webCookies;
  bindState.refreshToken = result.refreshToken;
  bindState.sessionId = '';
  bindState.accountName = result.accountName || '';
  document.getElementById('login-status-text').textContent = '登录成功！SteamID: ' + result.steamId;
  document.getElementById('btn-steam-login').disabled = true;
  setTimeout(() => {
    stepLogin.style.display = 'none';
    stepPhone.style.display = 'block';
    showToast('Steam 登录成功！现在可以发送邮箱验证码', 'success');
  }, 800);
}

// Step 2: Email code
async function sendSMS() {
  const statusBox = document.getElementById('sms-status');
  const statusText = document.getElementById('sms-status-text');
  const emailCodeSection = document.getElementById('email-code-section');
  statusBox.style.display = 'flex';
  statusText.textContent = '正在向 Steam 请求发送邮箱验证码...';
  document.getElementById('btn-send-sms').disabled = true;
  try {
    const result = await window.electronAPI.addAuthenticator({ accessToken: bindState.accessToken, steamId: bindState.steamId });
    if (result.response && result.response.status === 1) {
      bindState.sharedSecret = result.response.shared_secret || '';
      bindState.identitySecret = result.response.identity_secret || '';
      bindState.secret1 = result.response.secret_1 || '';
      bindState.revocationCode = result.response.revocation_code || '';
      statusText.textContent = '验证码已发送，请查收你的注册邮箱';
      emailCodeSection.style.display = 'block';
      document.getElementById('sms-code').focus();
    } else {
      statusText.textContent = '[错误] 发送失败: ' + (result.error || result.response?.message || '未知错误');
    }
  } catch (err) {
    statusText.textContent = '[错误] 发送失败: ' + err.message;
  }
  document.getElementById('btn-send-sms').disabled = false;
}

async function verifySMS() {
  const smsCode = document.getElementById('sms-code').value.trim();
  if (!smsCode) { showToast('请输入邮箱验证码', 'error'); return; }
  const statusBox = document.getElementById('sms-status');
  const statusText = document.getElementById('sms-status-text');
  const verifyBtn = document.getElementById('btn-verify-sms');
  statusBox.style.display = 'flex';
  statusText.textContent = '正在验证...';
  verifyBtn.disabled = true;
  try {
    const result = await window.electronAPI.finalizeAuthenticator({
      accessToken: bindState.accessToken, steamId: bindState.steamId,
      accountName: bindState.accountName || '', smsCode, codeType: 'email',
      sharedSecret: bindState.sharedSecret, identitySecret: bindState.identitySecret,
      secret1: bindState.secret1, revocationCode: bindState.revocationCode,
      webCookies: bindState.webCookies || ''
    });
    if (result.success) {
      bindState.revocationCode = result.data?.revocation_code || '';
      bindState.accountData = result.data;
      document.getElementById('revocation-code').textContent = bindState.revocationCode;
      stepPhone.style.display = 'none';
      stepRevocation.style.display = 'block';
    } else {
      statusText.textContent = '[错误] 验证失败: ' + (result.error || '未知错误');
      verifyBtn.disabled = false;
    }
  } catch (err) {
    statusText.textContent = '[错误] ' + err.message;
    verifyBtn.disabled = false;
  }
}

function confirmRevocation() {
  const accountData = bindState.accountData;
  if (!accountData) { showToast('绑定数据丢失，请重新绑定', 'error'); return; }
  window.electronAPI.saveAccount(accountData).then(async () => {
    stepRevocation.style.display = 'none';
    stepDone.style.display = 'block';
    await loadAccounts();
  }).catch(err => showToast('保存失败: ' + err.message, 'error'));
}

function copyRevocationCode() {
  if (bindState.revocationCode) {
    window.electronAPI.copyToClipboard(bindState.revocationCode);
    const btn = document.getElementById('btn-copy-revocation');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = '复制成功 ✓';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  }
}

function finishBind() {
  closeBindModal();
  renderAccounts();
  showToast('Steam 令牌绑定成功！', 'success');
}

// ============ QR Click Login ============
function openQRClickLogin(preferSteamId, directAccountIndex) {
  if (accounts.length === 0) { showToast('请先绑定 Steam 账号', 'error'); return; }
  if (directAccountIndex !== undefined && directAccountIndex >= 0) {
    const acc = accounts[directAccountIndex];
    if (!acc) { showToast('账号数据异常', 'error'); return; }
    performQRClickLogin(directAccountIndex);
    return;
  }
  modalQRClick.style.display = 'flex';
  let selectedIdx = 0;
  if (preferSteamId) {
    const found = accounts.findIndex(acc => String(getSteamId(acc)) === String(preferSteamId));
    if (found >= 0) selectedIdx = found;
  }
  qrClickAccountSelect.innerHTML = accounts.map((acc, i) => {
    const name = acc.account_name || getSteamId(acc) || `账号 ${i + 1}`;
    return `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>${escHtml(name)}</option>`;
  }).join('');
  qrClickStatus.style.display = 'none';
  qrClickResult.style.display = 'none';
  qrClickResult.innerHTML = '';
  btnQRClickDetect.disabled = false;
  btnQRClickDetect.textContent = '开始识别并登录';
}

function closeQRClickLogin() { modalQRClick.style.display = 'none'; }

// ============ Relogin ============
function openReloginForAction(accountIndex, action) { openReloginModal(accountIndex, action); }
function openReloginModal(accountIndex, pendingAction) {
  const acc = accounts[accountIndex];
  if (!acc) return;
  const steamId = getSteamId(acc);
  const accountName = acc.account_name || steamId || '未知';
  window.electronAPI.openReloginWindow({
    steamId, accountName, accountIndex,
    sharedSecret: acc.shared_secret || '',
    pendingAction: pendingAction || null,
    pendingAccIndex: pendingAction ? accountIndex : -1
  }, getCurrentTheme());
}

async function onReloginDone(data) {
  accountNamesFetched = false;
  accountNamesFetchRetries = 0;
  await loadAccounts();
  const steamId = data.steamId;
  const pendingAction = data.pendingAction;
  const pendingAccIndex = data.pendingAccIndex;

  // 如果确认窗口打开了，把更新后的账号数据推送过去（含新的 webCookies）
  if (steamId) {
    const updatedAcc = accounts.find(acc => String(getSteamId(acc)) === String(steamId));
    if (updatedAcc) {
      window.electronAPI.updateConfirmationData({
        accountName: updatedAcc.account_name || steamId,
        steamId,
        identitySecret: updatedAcc.identity_secret || '',
        deviceId: updatedAcc.device_id || '',
        webCookies: updatedAcc.web_cookies || '',
        accessToken: updatedAcc.access_token || ''
      });
    }
  }

  if (pendingAction && pendingAccIndex >= 0 && pendingAccIndex < accounts.length) {
    setTimeout(async () => {
      const acc = accounts[pendingAccIndex];
      if (!acc) return;
      if (pendingAction === 'inventory-public') {
        const webCookies = acc.web_cookies || '';
        if (!webCookies) { showToast('登录成功但未获取到 web_cookies', 'error'); return; }
        const result = await window.electronAPI.setInventoryPublic({ webCookies, steamId: getSteamId(acc) });
        showToast(result.success ? '库存已设置为公开' : '设置失败', result.success ? 'success' : 'error');
      } else if (pendingAction === 'confirm-all') {
        const webCookies = acc.web_cookies || '';
        if (!webCookies) { showToast('登录成功但未获取到 web_cookies', 'error'); return; }
        const result = await window.electronAPI.confirmAllAndClose({ steamId: getSteamId(acc), webCookies });
        showToast(result.success ? (result.message || '已完成') : '操作失败', result.success ? 'success' : 'error');
      }
    }, 500);
    return;
  }
  // 只有从"扫描二维码登录"流程触发的重新登录，完成后才自动打开二维码扫描
  if (pendingAction === 'qr-login' && steamId) {
    setTimeout(() => {
      const idx = accounts.findIndex(acc => String(getSteamId(acc)) === String(steamId));
      if (idx >= 0) openQRClickLogin(null, idx);
    }, 300);
  }
  showToast('重新登录完成，列表已刷新', 'success');
}

async function performQRClickLogin(directAccountIndex) {
  const accountIndex = directAccountIndex !== undefined ? directAccountIndex : parseInt(qrClickAccountSelect.value);
  const acc = accounts[accountIndex];
  if (!acc) { showToast('请选择要登录的账号', 'error'); return; }
  const steamId = getSteamId(acc);
  if (!steamId || !acc.shared_secret) { showToast('该账号缺少必要的密钥信息', 'error'); return; }
  if (!acc.access_token) { openReloginModal(accountIndex, 'qr-login'); return; }

  const isSilent = directAccountIndex !== undefined;
  if (!isSilent) {
    btnQRClickDetect.disabled = true;
    btnQRClickDetect.textContent = '正在截取屏幕并识别二维码...';
    qrClickStatus.style.display = 'flex';
    qrClickStatusText.textContent = '正在截取所有屏幕并识别 Steam 登录二维码...';
    qrClickResult.style.display = 'none';
  }
  showToast('正在截取屏幕识别 Steam 登录二维码...', 'success');
  try {
    const capture = await window.electronAPI.captureScreen();
    if (!capture.success) { showQRClickError('操作失败: ' + (capture.error || '未知错误')); return; }
    if (!capture.qrFound) { showQRClickError('未在任何屏幕中找到 Steam 登录二维码'); return; }
    if (!isSilent) {
      qrClickStatusText.textContent = `已识别二维码，正在用账号确认登录...`;
      btnQRClickDetect.textContent = '正在批准 QR 登录...';
    }
    const approveResult = await window.electronAPI.approveQRLogin({
      accessToken: acc.access_token, sharedSecret: acc.shared_secret, qrChallengeUrl: capture.qrData
    });
    if (!approveResult.success) {
      if (approveResult.needRelogin) {
        showToast('accessToken 已过期，请重新登录', 'error');
        openReloginModal(accountIndex);
        return;
      } else {
        showQRClickError('QR 登录批准失败: ' + (approveResult.error || '未知错误'));
        return;
      }
    }
    if (!isSilent) {
      qrClickStatus.style.display = 'none';
      btnQRClickDetect.disabled = false;
      btnQRClickDetect.textContent = '开始识别并登录';
      qrClickResult.style.display = 'block';
      qrClickResult.innerHTML = `<div class="success-box"><p><strong>QR 登录已批准！</strong></p></div>`;
    }
    showToast('QR 登录已批准', 'success');
  } catch (err) {
    showQRClickError('操作失败: ' + err.message);
  }
}

function showQRClickError(msg) {
  if (qrClickStatus) qrClickStatus.style.display = 'none';
  if (qrClickResult) { qrClickResult.style.display = 'block'; qrClickResult.innerHTML = `<div class="error-box">${escHtml(msg)}</div>`; }
  if (btnQRClickDetect) { btnQRClickDetect.disabled = false; btnQRClickDetect.textContent = '重试识别'; }
  showToast(msg, 'error');
}

// ============ Confirmation ============
async function openConfirmationsModal(accountIndex) {
  const acc = accounts[accountIndex];
  if (!acc) return;
  const steamId = getSteamId(acc);
  try {
    await window.electronAPI.openConfirmationWindow({
      accountIndex, accountName: acc.account_name || steamId || '未知', steamId,
      identitySecret: acc.identity_secret || '', deviceId: acc.device_id || '',
      webCookies: acc.web_cookies || '', accessToken: acc.access_token || ''
    }, getCurrentTheme());
  } catch (err) { showToast('打开确认窗口失败: ' + err.message, 'error'); }
}

// ============ Import ============
async function importAccounts() {
  const result = await window.electronAPI.importAccounts();
  if (result.success) { await loadAccounts(); showToast(`成功导入 ${result.count} 个账号`, 'success'); }
}

// ============ Events ============
function setupEvents() {
  try {
    const btnToggleTheme = document.getElementById('btn-toggle-theme');
    if (btnToggleTheme) btnToggleTheme.addEventListener('click', toggleTheme);

    if (btnBind) btnBind.addEventListener('click', async () => {
      await window.electronAPI.openBindWindow(getCurrentTheme());
    });
    if (btnImport) btnImport.addEventListener('click', importAccounts);
    if (btnQRClickLogin) btnQRClickLogin.addEventListener('click', () => {
      if (selectedUid) {
        const idx = accounts.findIndex(acc => acc._uid === selectedUid);
        if (idx >= 0) { openQRClickLogin(null, idx); return; }
      }
      openQRClickLogin();
    });
    if (bindClose) bindClose.addEventListener('click', closeBindModal);
    document.querySelector('#modal-bind .modal-overlay')?.addEventListener('click', closeBindModal);

    // QR Click Login Modal
    if (qrClickClose) qrClickClose.addEventListener('click', closeQRClickLogin);
    document.querySelector('#modal-qr-click .modal-overlay')?.addEventListener('click', closeQRClickLogin);
    if (btnQRClickDetect) btnQRClickDetect.addEventListener('click', () => performQRClickLogin());

    // Relogin done
    window.electronAPI.onReloginDone(onReloginDone);

    // Confirmation window requests relogin (cookie expired)
    window.electronAPI.onConfirmationRequestRelogin((data) => {
      if (!data || !data.steamId) return;
      const idx = accounts.findIndex(acc => String(getSteamId(acc)) === String(data.steamId));
      if (idx >= 0) openReloginModal(idx);
    });

    // Confirmation
    if (confirmationsClose) confirmationsClose.addEventListener('click', () => {});

    // Copy button
    if (copyBtn) copyBtn.addEventListener('click', copyCode);

    // Bind login buttons
    document.getElementById('btn-steam-login')?.addEventListener('click', () => {
      if (bindState.sessionId) steamLoginWithGuard(); else steamLogin();
    });
    document.getElementById('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') steamLogin(); });
    document.getElementById('login-guard-code')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { if (bindState.sessionId) steamLoginWithGuard(); else steamLogin(); }
    });
    document.getElementById('btn-send-sms')?.addEventListener('click', sendSMS);
    document.getElementById('btn-verify-sms')?.addEventListener('click', verifySMS);
    document.getElementById('btn-copy-revocation')?.addEventListener('click', copyRevocationCode);
    document.getElementById('btn-confirm-revocation')?.addEventListener('click', confirmRevocation);
    document.getElementById('confirm-revocation-saved')?.addEventListener('change', e => {
      document.getElementById('btn-confirm-revocation').disabled = !e.target.checked;
    });
    document.getElementById('btn-finish-bind')?.addEventListener('click', finishBind);

    // 列表点击事件委托（fallback，确保点击一定能触发）
    if (listContent) {
      listContent.addEventListener('click', function(e) {
        const item = e.target.closest('.account-item');
        if (!item) return;
        const uid = item.dataset.uid;
        const idx = filteredAccounts.findIndex(a => a._uid === uid);
        if (idx >= 0) selectAccountByIndex(idx);
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target === searchInput) {
        if (e.key === 'Escape') { searchInput.blur(); }
        return;
      }
      if (e.key === 'Escape') {
        if (modalQRClick.style.display === 'flex') closeQRClickLogin();
        else if (modalBind.style.display === 'flex') closeBindModal();
        else window.electronAPI.hideWindow();
      }
      if (e.key === '/') { e.preventDefault(); searchInput.focus(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); openBindModal(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); searchInput.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); selectAccountByIndex(selectedIndex + 1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); selectAccountByIndex(selectedIndex - 1); }
      if (e.key === 'Enter') { e.preventDefault(); copyCode(); }
    });

    // Context menu items
    contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        const uid = contextMenuTargetUid;
        hideContextMenu();
        if (!uid) return;
        const acc = getAccountByUid(uid);
        if (!acc) return;

        switch (action) {
          case 'copy-code': {
            if (acc?.shared_secret) {
              const result = await window.electronAPI.generateCode(acc.shared_secret);
              if (result?.code && result.code !== 'ERR') {
                await window.electronAPI.copyToClipboard(result.code);
                showToast(`验证码 ${result.code} 已复制`, 'success');
              }
            }
            break;
          }
          case 'copy-name': {
            const name = acc.account_name || getSteamId(acc) || '未知';
            await window.electronAPI.copyToClipboard(name);
            showToast(`已复制: ${name}`, 'success');
            break;
          }
          case 'copy-steamid': {
            const sid = getSteamId(acc);
            if (sid) { await window.electronAPI.copyToClipboard(sid); showToast(`已复制 SteamID: ${sid}`, 'success'); }
            break;
          }
          case 'export-mafile': {
            const sid = getSteamId(acc);
            if (sid) { const r = await window.electronAPI.exportSingleAccount({ steamId: sid }); if (r.success) showToast('已导出', 'success'); }
            break;
          }
          case 'edit-profile-name': {
            const wc = acc.web_cookies || '';
            if (!wc) { openReloginForAction(accounts.indexOf(acc), 'edit-profile-name'); break; }
            const targetName = acc.account_name || getSteamId(acc);
            if (!targetName) { showToast('无法获取目标名称', 'error'); break; }
            const r = await window.electronAPI.editProfileName({ webCookies: wc, steamId: getSteamId(acc), accountName: targetName });
            showToast(r.success ? (r.message || '名称已同步') : ('同步失败: ' + (r.error || '未知错误')), r.success ? 'success' : 'error');
            break;
          }
          case 'random-avatar': {
            const wc = acc.web_cookies || '';
            if (!wc) { openReloginForAction(accounts.indexOf(acc), 'random-avatar'); break; }
            showToast('正在获取随机头像...', 'info');
            const r = await window.electronAPI.randomAvatar({ webCookies: wc, steamId: getSteamId(acc) });
            showToast(r.success ? (r.message || '头像已更换') : ('更换失败: ' + (r.error || '未知错误')), r.success ? 'success' : 'error');
            break;
          }
          case 'inventory-public': {
            const wc = acc.web_cookies || '';
            if (!wc) { openReloginForAction(accounts.indexOf(acc), 'inventory-public'); break; }
            const r = await window.electronAPI.setInventoryPublic({ webCookies: wc, steamId: getSteamId(acc) });
            showToast(r.success ? '库存已设为公开' : '设置失败', r.success ? 'success' : 'error');
            break;
          }
          case 'confirm-all': {
            const wc = acc.web_cookies || '';
            if (!wc) { openReloginForAction(accounts.indexOf(acc), 'confirm-all'); break; }
            const r = await window.electronAPI.confirmAllAndClose({ steamId: getSteamId(acc), webCookies: wc });
            showToast(r.success ? (r.message || '已完成') : '操作失败', r.success ? 'success' : 'error');
            break;
          }
          case 'refresh-mafile': {
            if (!acc.access_token) { showToast('缺少 access_token', 'error'); break; }
            const r = await window.electronAPI.refreshMafile({ accessToken: acc.access_token, steamId: getSteamId(acc) });
            if (r.success) { await loadAccounts(); showToast(r.message, 'success'); }
            break;
          }
          case 'relogin': {
            const idx = accounts.indexOf(acc);
            if (idx >= 0) openReloginModal(idx);
            break;
          }
          case 'delete-account': {
            const sid = getSteamId(acc);
            const name = acc.account_name || sid || '未知';
            if (!sid) { showToast('无法获取 SteamID', 'error'); break; }
            if (!confirm(`确定要删除账号「${name}」吗？`)) break;
            const r = await window.electronAPI.deleteAccount(sid);
            if (r.success) { showToast(`已删除「${name}」`, 'success'); await loadAccounts(); }
            else showToast('删除失败', 'error');
            break;
          }
        }
      });
    });

    // Bind complete event
    window.electronAPI.onBindComplete(async () => {
      accountNamesFetched = false;
      accountNamesFetchRetries = 0;
      await loadAccounts();
      showToast('新账号已绑定，列表已刷新', 'success');
    });

  } catch (e) {
    console.error('[setupEvents] 事件绑定失败:', e.message);
  }
}

init();
