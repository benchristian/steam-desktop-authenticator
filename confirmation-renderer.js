/**
 * Confirmation Window - 独立交易确认窗口渲染进程
 */

// ============ Theme ============
let themeInitialized = false;
function applyTheme(theme) {
  const actual = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', actual);
  if (!themeInitialized) {
    themeInitialized = true;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('no-transition');
    });
  }
}

// 从主进程接收主题变更
if (window.electronAPI && window.electronAPI.onThemeChange) {
  window.electronAPI.onThemeChange((theme) => {
    applyTheme(theme || 'system');
  });
}
// 初始主题已在 HTML 内联脚本中设置，这里再确认一次
applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

// ============ State ============
let accountData = null;
let confirmations = [];
let isLoading = false;

// ============ DOM ============
const mainContent = document.getElementById('mainContent');
const refreshBtn = document.getElementById('refreshBtn');
const refreshIcon = document.getElementById('refreshIcon');

// ============ Init ============
async function init() {
  // 立即显示 loading 状态，避免白屏
  renderEmpty('loading', '正在加载交易确认', '正在获取 Steam 账号数据...');

  // 从主窗口接收账号数据
  if (window.electronAPI && window.electronAPI.onConfirmationData) {
    window.electronAPI.onConfirmationData((data) => {
      accountData = data;
      loadConfirmations();
    });
  }

  // 重新登录完成后，确认窗口收到通知
  // 优先使用事件中携带的 accountData，没有则等 confirmation-data 事件
  if (window.electronAPI && window.electronAPI.onReloginDoneRefresh) {
    window.electronAPI.onReloginDoneRefresh((data) => {
      const accountName = (accountData && accountData.accountName) || (data && data.accountName) || '';
      const steamId = (accountData && accountData.steamId) || (data && data.steamId) || '';
      if (accountName) {
        renderEmpty('loading', '凭证已刷新', '正在重新加载交易确认列表...', accountName, (accountName[0] || '?').toUpperCase());
        if (steamId) loadAccountAvatar(steamId, (accountName[0] || '?').toUpperCase());
      }
      // 如果事件中携带了最新的账号数据，直接使用（避免等待 IPC 时序）
      if (data && data.accountData && data.accountData.webCookies) {
        accountData = data.accountData;
        loadConfirmations();
      } else {
        // 兜底：1.5 秒后如果还没收到 confirmation-data，再主动请求一次
        setTimeout(() => {
          if (window.electronAPI && window.electronAPI.requestConfirmationData) {
            window.electronAPI.requestConfirmationData();
          }
        }, 1500);
      }
    });
  }

  // 刷新按钮
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (!isLoading) loadConfirmations();
    });
  }

  // 请求初始数据
  if (window.electronAPI && window.electronAPI.requestConfirmationData) {
    window.electronAPI.requestConfirmationData();
  }
}

// ============ Data Loading ============
async function loadConfirmations() {
  if (!accountData) {
    renderEmpty('loading', '账号数据未加载', '请关闭窗口重试');
    return;
  }

  const accountName = accountData.accountName || accountData.steamId || '未知账号';
  const avatar = (accountName[0] || '?').toUpperCase();
  const steamId = accountData.steamId || '';

  if (!accountData.identitySecret) {
    renderEmpty('warn', '缺少密钥', '该账号缺少 identity_secret，无法获取交易确认', accountName, avatar);
    if (steamId) loadAccountAvatar(steamId, avatar);
    return;
  }

  isLoading = true;
  refreshBtn.classList.add('spinning');

  try {
    const result = await window.electronAPI.getConfirmations({
      steamId: accountData.steamId,
      identitySecret: accountData.identitySecret,
      deviceId: accountData.deviceId || '',
      webCookies: accountData.webCookies || ''
    });

    if (!result.success) {
      const isNeedAuth = result.error && result.error.includes('登录凭证已过期');
      renderEmpty(isNeedAuth ? 'error' : 'warn',
        isNeedAuth ? '凭证已过期' : '加载失败',
        result.error || '未知错误',
        accountName, avatar,
        isNeedAuth ? 'relogin' : null
      );
      if (steamId) loadAccountAvatar(steamId, avatar);
      return;
    }

    confirmations = result.confirmations || [];

    if (confirmations.length === 0) {
      renderEmpty('success', '没有待确认的交易', '所有交易已确认，无需操作。新交易将自动出现在此列表中。', accountName, avatar);
    } else {
      renderPending(accountName, avatar);
    }

    // 加载真实头像
    if (steamId) {
      loadAccountAvatar(steamId, avatar);
    }
  } catch (err) {
    renderEmpty('warn', '加载失败', err.message, accountName, avatar);
    if (steamId) loadAccountAvatar(steamId, avatar);
  } finally {
    isLoading = false;
    refreshBtn.classList.remove('spinning');
  }
}

// ============ Render Empty ============
function renderEmpty(type, title, desc, accountName, avatar, extraAction) {
  const iconMap = {
    loading: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
    success: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    warn: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    error: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
  };

  const iconClass = type === 'warn' ? ' warn' : '';

  // ── 凭证过期：使用全新的 error-state 布局 ──
  if (type === 'error' && extraAction === 'relogin') {
    let accountBarHTML = '';
    if (accountName) {
      accountBarHTML = `
        <div class="account-bar is-error" role="region" aria-label="当前账号">
          <div class="account-left">
            <div class="account-avatar is-error">${escHtml(avatar || '?')}</div>
            <div>
              <div class="account-name">${escHtml(accountName)}</div>
              <div class="account-hint">${escHtml((accountData && accountData.steamId) || '')} · <span style="color:var(--danger)">令牌凭证已过期</span></div>
            </div>
          </div>
        </div>`;
    }

    mainContent.innerHTML = `
      ${accountBarHTML}
      <div class="error-state" role="alert" aria-live="assertive">
        <div class="error-icon-wrap">
          <div class="error-ring"></div>
          <div class="error-icon">
            ${iconMap.error}
          </div>
        </div>
        <div class="error-title">${escHtml(title)}</div>
        <div class="error-desc">${desc}</div>
        <div class="error-actions">
          <button type="button" class="btn-relogin" id="emptyReloginBtn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            重新登录获取凭证
          </button>
          <span class="error-hint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            需要重新输入密码验证身份
          </span>
        </div>
      </div>`;

    // 绑定重新登录按钮
    setTimeout(() => {
      const btn = document.getElementById('emptyReloginBtn');
      if (btn && window.electronAPI && window.electronAPI.requestRelogin) {
        btn.addEventListener('click', () => {
          window.electronAPI.requestRelogin(accountData);
        });
      }
    }, 100);
    return;
  }

  // ── 空状态（success） ──
  if (type === 'success') {
    let accountBarHTML = '';
    if (accountName) {
      accountBarHTML = `
        <div class="account-bar" role="region" aria-label="当前账号">
          <div class="account-left">
            <div class="account-avatar">${escHtml(avatar || '?')}</div>
            <div>
              <div class="account-name">${escHtml(accountName)}</div>
              <div class="account-hint">${escHtml((accountData && accountData.steamId) || '')}</div>
            </div>
          </div>
        </div>`;
    }

    mainContent.innerHTML = `
      ${accountBarHTML}
      <div class="empty-state" role="status">
        <div class="empty-particles">
          <div class="particle"></div>
          <div class="particle"></div>
          <div class="particle"></div>
          <div class="particle"></div>
          <div class="particle"></div>
          <div class="particle"></div>
        </div>

        <button class="empty-check-trigger" id="emptyConfirmBtn" aria-label="确认所有交易">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>

        <div class="empty-title">${escHtml(title)}</div>
        <div class="empty-desc">${desc}</div>
        <div class="empty-meta">
          <span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            上次检查：刚刚
          </span>
        </div>
      </div>`;

    // 绑定确认按钮：点击 ripple + scanning → 刷新
    setTimeout(() => {
      const btn = document.getElementById('emptyConfirmBtn');
      if (btn) {
        btn.addEventListener('click', () => {
          // Ripple effect
          btn.classList.remove('ripple');
          void btn.offsetWidth;
          btn.classList.add('ripple');

          // Scanning state
          btn.classList.add('scanning');
          btn.innerHTML = '';

          setTimeout(() => {
            btn.classList.remove('scanning');
            btn.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            // 触发刷新
            if (!isLoading) loadConfirmations();
          }, 1100);
        });
      }
    }, 100);
    return;
  }

  // ── Loading 状态：使用专用 loading UI ──
  if (type === 'loading') {
    let accountBarHTML = '';
    if (accountName) {
      accountBarHTML = `
        <div class="account-bar" role="region" aria-label="当前账号">
          <div class="account-left">
            <div class="account-avatar">${escHtml(avatar || '?')}</div>
            <div>
              <div class="account-name">${escHtml(accountName)}</div>
              <div class="account-hint">${escHtml((accountData && accountData.steamId) || '')}</div>
            </div>
          </div>
        </div>`;
    }

    mainContent.innerHTML = `
      ${accountBarHTML}
      <div class="loading-body" role="status" aria-live="polite">
        <div class="load-particle lp1"></div>
        <div class="load-particle lp2"></div>
        <div class="load-particle lp3"></div>
        <div class="load-particle lp4"></div>

        <div class="loader-ring">
          <div class="ripple"></div>
          <div class="loading-27"></div>
        </div>

        <div class="load-text">
          <div class="load-title">${escHtml(title)}</div>
        </div>

        <div class="load-sub">${desc}
          <span class="typing-dots">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </span>
        </div>

        <div class="progress-area">
          <div class="progress-track">
            <div class="progress-fill"></div>
          </div>
        </div>

      </div>`;
    return;
  }

  // ── 通用 empty-state（warn / success 等） ──
  let accountBarHTML = '';
  if (accountName) {
    accountBarHTML = `
      <div class="account-bar" role="region" aria-label="当前账号">
        <div class="account-left">
          <div class="account-avatar">${escHtml(avatar || '?')}</div>
          <div>
            <div class="account-name">${escHtml(accountName)}</div>
            <div class="account-hint">${escHtml((accountData && accountData.steamId) || '')}</div>
          </div>
        </div>
      </div>`;
  }

  // 操作按钮
  let actionHTML = '';
  if (extraAction === 'relogin') {
    actionHTML = `
      <button class="btn btn-primary empty-action-btn" id="emptyReloginBtn" style="margin-top:16px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        重新登录获取凭证
      </button>`;
  }

  mainContent.innerHTML = `
    ${accountBarHTML}
    <div class="empty-state" role="status">
      <div class="empty-icon${iconClass}">
        ${iconMap[type] || iconMap.loading}
      </div>
      <div class="empty-title">${escHtml(title)}</div>
      <div class="empty-desc">${desc}</div>
      ${actionHTML}
    </div>`;

  // 绑定重新登录按钮
  if (extraAction === 'relogin') {
    setTimeout(() => {
      const btn = document.getElementById('emptyReloginBtn');
      if (btn && window.electronAPI && window.electronAPI.requestRelogin) {
        btn.addEventListener('click', () => {
          window.electronAPI.requestRelogin(accountData);
        });
      }
    }, 100);
  }
}

// ============ Render Pending ============
function renderPending(accountName, avatar) {
  const steamId = (accountData && accountData.steamId) || '';
  const typeLabelMap = { 1: '交易报价', 2: '市场购买', 3: '其他确认' };

  const tradeCards = confirmations.map((conf, i) => {
    // 类型判断：以 typeName/headline 文本内容为主，因为 API 的 type 数值并不可靠
    const confType = Number(conf.type) || 0;
    console.log('[renderPending]', i, 'type=', conf.type, 'confType=', confType, 'typeName=', conf.typeName, 'headline=', conf.headline, 'creator=', conf.creator, 'sending=', conf.sending, 'receiving=', conf.receiving, 'summary=', JSON.stringify(conf.summary));

    // 综合 typeName + headline 来判断类型
    const tn = ((conf.typeName || '') + ' ' + (conf.headline || '') + ' ' + (conf.title || '')).toLowerCase();
    let isTrade = false;
    let isMarket = false;

    if (tn.includes('trade offer') || tn.includes('交易报价') || tn.includes('trade') || tn.includes('交易')) {
      isTrade = true;
    } else if (tn.includes('market') || tn.includes('listing') || tn.includes('市场') || tn.includes('购买')) {
      isMarket = true;
    } else if (confType === 1) {
      isTrade = true;
    } else if (confType === 2) {
      isMarket = true;
    }

    const typeName = conf.typeName || typeLabelMap[confType] || `确认类型 ${confType || '?'}`;
    const time = conf.time
      ? new Date(conf.time * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';

    // ── 交易报价：提取对方信息 + 物品流向 ──
    let partnerName = '';
    let partnerAvatarUrl = '';
    let itemsHTML = '';

    if (isTrade) {
      // 对方名称：优先从 headline "Trade Offer - xxx" 提取，否则直接用 headline
      const headline = conf.headline || conf.title || '';
      const tradeMatch = headline.match(/Trade Offer\s*[-:]\s*(.+)/i);
      if (tradeMatch) {
        partnerName = tradeMatch[1].trim();
      } else if (headline && headline.trim()) {
        partnerName = headline.trim();
      } else {
        partnerName = conf.creator || '';
      }

      // 头像：优先用 API 返回的 icon URL，否则用名字首字母
      partnerAvatarUrl = conf.icon || '';

      // 物品区域：发出 + 收到
      const sending = conf.sending || '';
      const receiving = conf.receiving || '';

      if (sending || receiving) {
        let rows = '';
        if (sending) {
          const sendName = cleanItemText(sending);
          rows += `
            <div class="trade-item-row">
              <div class="trade-item-dot outgoing"></div>
              <span class="trade-item-name">${escHtml(sendName)}</span>
              <span class="trade-item-dir outgoing-dir">你将发出</span>
            </div>`;
        }
        if (receiving) {
          const recvName = cleanItemText(receiving);
          rows += `
            <div class="trade-item-row">
              <div class="trade-item-dot incoming"></div>
              <span class="trade-item-name">${escHtml(recvName)}</span>
              <span class="trade-item-dir incoming-dir">你将收到</span>
            </div>`;
        }
        itemsHTML = `<div class="trade-items">${rows}</div>`;
      }
    } else if (isMarket) {
      // 市场购买确认：没有交易对象，只有确认说明
      partnerName = '';
      const headline = conf.headline || conf.sending || conf.title || '';
      const desc = cleanItemText(headline);

      itemsHTML = `
        <div class="trade-items market-items">
          <div class="trade-item-row">
            <span class="trade-item-name">${escHtml(desc || '确认市场购买')} : Purchase confirmation needed</span>
          </div>
        </div>`;
    } else {
      // 其他类型兜底
      const headline = conf.headline || conf.sending || conf.title || '';
      partnerName = conf.creator || '';
      itemsHTML = headline ? `
        <div class="trade-items">
          <div class="trade-item-row">
            <div class="trade-item-dot"></div>
            <span class="trade-item-name">${escHtml(cleanItemText(headline))}</span>
          </div>
        </div>` : '';
    }

    // ── 顶部区域：根据类型展示不同内容 ──
    let topHTML = '';
    if (isTrade && partnerName) {
      // 交易报价：显示对方头像 + 类型 + 对方名称
      const initial = partnerName[0].toUpperCase();
      topHTML = `
        <div class="trade-top">
          <div class="trade-partner">
            ${partnerAvatarUrl
              ? `<img class="trade-avatar-img" src="${escHtml(partnerAvatarUrl)}" alt="${escHtml(partnerName)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><div class="trade-avatar trade-avatar-fallback" style="display:none">${escHtml(initial)}</div>`
              : `<div class="trade-avatar">${escHtml(initial)}</div>`
            }
            <div class="trade-partner-info">
              <div class="trade-label">${escHtml(typeName)}</div>
              <div class="trade-partner-name">${escHtml(partnerName)}</div>
            </div>
          </div>
          ${time ? `<span class="trade-time-badge">${time}</span>` : ''}
        </div>`;
    } else if (isMarket) {
      // 市场购买：橙色购物车图标
      topHTML = `
        <div class="trade-top">
          <div class="trade-partner">
            <div class="trade-avatar market-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
            </div>
            <div class="trade-partner-info">
              <div class="trade-label">市场购买确认</div>
              <div class="trade-partner-name">Steam 社区市场</div>
            </div>
          </div>
          ${time ? `<span class="trade-time-badge">${time}</span>` : ''}
        </div>`;
    } else {
      // 其他：通用兜底
      const initial = (partnerName || typeName || '?')[0].toUpperCase();
      topHTML = `
        <div class="trade-top">
          <div class="trade-partner">
            <div class="trade-avatar">${escHtml(initial)}</div>
            <div class="trade-partner-info">
              <div class="trade-label">${escHtml(typeName)}</div>
              <div class="trade-partner-name">${escHtml(partnerName || '未知')}</div>
            </div>
          </div>
          ${time ? `<span class="trade-time-badge">${time}</span>` : ''}
        </div>`;
    }

    return `
      <div class="trade-card" data-id="${escHtml(String(conf.id))}" data-key="${escHtml(conf.key || '')}">
        ${topHTML}
        ${itemsHTML}
        <div class="trade-actions">
          <button class="btn btn-reject btn-cancel" data-id="${escHtml(String(conf.id))}" data-key="${escHtml(conf.key || '')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            撤销
          </button>
          <button class="btn btn-confirm" data-id="${escHtml(String(conf.id))}" data-key="${escHtml(conf.key || '')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            确认交易
          </button>
        </div>
      </div>`;
  }).join('');

  mainContent.innerHTML = `
    <div class="account-bar" role="region" aria-label="当前账号">
      <div class="account-left">
        <div class="account-avatar">${escHtml(avatar)}</div>
        <div>
          <div class="account-name">${escHtml(accountName)}</div>
          <div class="account-hint">${escHtml(steamId)} · 将为此账号进行交易报价确认</div>
        </div>
      </div>
    </div>

    <div class="trade-list-header">
      <div class="trade-count">待处理：<strong>${confirmations.length}</strong> 笔交易</div>
    </div>

    <div class="trade-list" role="list" aria-label="待确认交易列表">
      ${tradeCards}
    </div>
  `;

  // 绑定确认/撤销按钮事件
  mainContent.querySelectorAll('.btn-confirm').forEach(btn => {
    btn.addEventListener('click', () => handleConfirm(btn.dataset.id, btn.dataset.key, 'allow'));
  });
  mainContent.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', () => handleConfirm(btn.dataset.id, btn.dataset.key, 'cancel'));
  });


}

// ============ Actions ============
async function handleConfirm(confirmationId, confirmationKey, action) {
  if (!accountData) return;

  const card = mainContent.querySelector(`[data-id="${CSS.escape(confirmationId)}"]`);
  if (!card) return;

  // ── 撤销操作（cancel）：直接发送，无需二次确认 ──
  if (action === 'cancel') {
    card.classList.add('trade-confirming');
    card.querySelectorAll('button').forEach(b => b.disabled = true);

    try {
      const result = await window.electronAPI.confirmTrade({
        accessToken: accountData.accessToken || '',
        steamId: accountData.steamId,
        identitySecret: accountData.identitySecret,
        deviceId: accountData.deviceId || '',
        webCookies: accountData.webCookies || '',
        confirmationId: confirmationId,
        confirmationKey: confirmationKey,
        action: action
      });

      if (result.success) {
        const cancelBtn = card.querySelector('.btn-cancel');
        if (cancelBtn) {
          cancelBtn.innerHTML = '已撤销';
          cancelBtn.style.borderColor = 'var(--border-error)';
          cancelBtn.style.color = 'var(--text-tertiary)';
        }
        const confirmBtn = card.querySelector('.btn-confirm');
        if (confirmBtn) confirmBtn.style.display = 'none';
        card.style.opacity = '0.45';
        card.style.pointerEvents = 'none';

        setTimeout(() => {
          if (accountData) loadConfirmations();
        }, 1500);
      } else {
        card.classList.remove('trade-confirming');
        card.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    } catch (err) {
      card.classList.remove('trade-confirming');
      card.querySelectorAll('button').forEach(b => b.disabled = false);
    }
    return;
  }

  // ── 确认操作（allow）：二次点击确认 ──
  const confirmBtn = card.querySelector('.btn-confirm');
  if (!confirmBtn) return;

  // 防止在确认中或退出中再次点击
  if (card.classList.contains('trade-confirming') || card.classList.contains('card-exiting')) return;

  // 第一次点击：进入 double-check 模式
  if (!confirmBtn.classList.contains('btn-double-check')) {
    confirmBtn.classList.add('btn-double-check');
    confirmBtn.innerHTML = '再次点击确认';
    // 2.5秒后自动取消 double-check
    confirmBtn._doubleCheckTimer = setTimeout(() => {
      confirmBtn.classList.remove('btn-double-check');
      confirmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 确认交易';
    }, 2500);
    return;
  }

  // 第二次点击：真正执行确认
  clearTimeout(confirmBtn._doubleCheckTimer);
  confirmBtn.classList.remove('btn-double-check');
  card.classList.add('trade-confirming');
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  confirmBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> 确认中...';

  try {
    const result = await window.electronAPI.confirmTrade({
      accessToken: accountData.accessToken || '',
      steamId: accountData.steamId,
      identitySecret: accountData.identitySecret,
      deviceId: accountData.deviceId || '',
      webCookies: accountData.webCookies || '',
      confirmationId: confirmationId,
      confirmationKey: confirmationKey,
      action: action
    });

    if (result.success) {
      // 先移除确认中状态
      card.classList.remove('trade-confirming');
      // 添加成功样式 + 退出动画
      confirmBtn.classList.add('btn-success');
      confirmBtn.innerHTML = '✓ 已确认';
      confirmBtn.disabled = true;

      const cancelBtn = card.querySelector('.btn-cancel');
      if (cancelBtn) cancelBtn.style.display = 'none';

      // 卡片退出动画
      card.classList.add('card-exiting');
      card.addEventListener('animationend', () => {
        card.classList.add('card-exited');
        updateTradeCount();
      }, { once: true });
    } else {
      card.classList.remove('trade-confirming');
      card.querySelectorAll('button').forEach(b => b.disabled = false);
      confirmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 确认交易';
    }
  } catch (err) {
    card.classList.remove('trade-confirming');
    card.querySelectorAll('button').forEach(b => b.disabled = false);
    confirmBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 确认交易';
  }
}

// 确认/撤销后更新交易数量
function updateTradeCount() {
  const remaining = mainContent.querySelectorAll('.trade-card:not(.card-exited)').length;
  const countEl = mainContent.querySelector('.trade-count strong');
  const hintEl = mainContent.querySelector('.account-hint');
  if (countEl) {
    // Bounce animation on count change
    countEl.style.transform = 'scale(1.35)';
    countEl.style.color = remaining > 0 ? 'var(--warning)' : 'var(--accent)';
    setTimeout(() => { countEl.style.transform = 'scale(1)'; }, 220);
    countEl.textContent = remaining;
  }
  if (hintEl) hintEl.textContent = remaining + ' 笔待确认交易';
  // 如果没有交易了，1秒后自动刷新到空状态
  if (remaining === 0) {
    setTimeout(() => {
      if (accountData) loadConfirmations();
    }, 800);
  }
}

// ============ Helpers ============
function escHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

/**
 * 加载账号头像：在所有渲染完成后，将 account-avatar 中的首字母替换为真实头像
 */
async function loadAccountAvatar(steamId, fallbackInitial) {
  if (!steamId) return;
  // 检查是否已经加载过该 steamId 的头像
  const existing = mainContent.querySelector('.account-avatar img');
  if (existing && existing.dataset.steamId === steamId) return;

  try {
    const result = await window.electronAPI.getSteamAvatar(steamId);
    if (result && result.success && result.url) {
      const img = new Image();
      img.dataset.steamId = steamId;
      img.onload = () => {
        // 替换所有 .account-avatar 元素中的内容
        const avatars = mainContent.querySelectorAll('.account-avatar');
        avatars.forEach(el => {
          if (!el.querySelector('img')) {
            el.innerHTML = '';
            el.appendChild(img.cloneNode(true));
          }
        });
      };
      img.onerror = () => {};
      img.src = result.url;
    }
  } catch (e) {
    // 加载失败，保持首字母显示
  }
}

/**
 * 清理物品文本：去掉 "You will give up your" / "You will receive" 等前缀
 */
function cleanItemText(text) {
  if (!text) return '';
  return text
    .replace(/^You will (give up|receive|send|get|trade)\s*(your\s*)?/i, '')
    .replace(/^You'll (give up|receive|send|get|trade)\s*(your\s*)?/i, '')
    .trim() || text.trim();
}



// ============ 窗口高度自适应 ============
function adjustWindowHeight() {
  setTimeout(() => {
    const windowEl = document.querySelector('.window');
    if (!windowEl) return;

    const prevMinHeight = windowEl.style.minHeight;
    windowEl.style.minHeight = '0';
    void windowEl.offsetHeight;
    const totalHeight = windowEl.scrollHeight;
    windowEl.style.minHeight = prevMinHeight;

    if (totalHeight > 0 && window.electronAPI && window.electronAPI.setWindowHeight) {
      window.electronAPI.setWindowHeight(totalHeight);
    }
  }, 0);
}

// 监听内容变化，自动调整高度
const confirmObserver = new MutationObserver(() => adjustWindowHeight());
if (mainContent) {
  confirmObserver.observe(mainContent, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class']
  });
}

// 初始加载时调整一次（等待数据渲染）
setTimeout(() => adjustWindowHeight(), 200);

// ============ Start ============
init();
