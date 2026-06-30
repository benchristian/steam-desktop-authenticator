// ========== State ==========
const state = {
  step: 1,
  account: '',
  theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  revocationCode: '',
  guardType: '', // 'email' | 'device' | null
  emailDomain: '', // 邮箱域名（如 gmail.com），用于提示用户
  accessToken: '',
  steamId: '',
  sharedSecret: '',
  identitySecret: '',
  secret1: '',
  webCookies: '',
};

// ========== DOM refs ==========
const panels = document.querySelectorAll('.step-panel');
const steps = document.querySelectorAll('.step');
const body = document.body;
const toast = document.getElementById('toast');
const toastMsg = document.getElementById('toast-message');

// ========== Stepper ==========
function updateStepper(step) {
  steps.forEach(s => {
    const sNum = parseInt(s.dataset.step);
    s.classList.remove('active', 'completed');
    if (sNum < step) {
      s.classList.add('completed');
      s.querySelector('.step-dot').textContent = '\u2713';
    } else if (sNum === step) {
      s.classList.add('active');
      s.querySelector('.step-dot').textContent = sNum;
    } else {
      s.querySelector('.step-dot').textContent = sNum;
    }
    s.setAttribute('aria-selected', sNum === step ? 'true' : 'false');
  });
}

function goToStep(step) {
  state.step = step;
  panels.forEach(p => p.classList.remove('active'));
  const panel = document.querySelector(`.step-panel[data-step="${step}"]`);
  if (panel) panel.classList.add('active');
  updateStepper(step);

  // 进入 Step 2 时自动发送邮箱验证码
  if (step === 2) {
    if (!state.accessToken) {
      console.error('[goToStep] accessToken 为空，无法进入 Step 2');
      smsStatusText.innerHTML = '登录信息丢失，请<a href="#" id="back-to-login-link" style="color: #4a9eff; text-decoration: underline;">返回上一步重新登录</a>';
      document.getElementById('back-to-login-link').addEventListener('click', (e) => {
        e.preventDefault();
        goToStep(1);
        smsStatus.classList.remove('show');
      });
      smsStatus.classList.add('show');
      return;
    }
    autoSendEmailCode();
  }

  // Focus heading for accessibility
  const heading = panel ? panel.querySelector('h2') : null;
  if (heading) heading.focus({ preventScroll: true });

  // 根据当前步骤的内容高度自适应调整窗口大小
  adjustWindowHeight();
}

// ========== 窗口高度自适应 ==========
// 策略：直接测量 .window 元素（含 titlebar + content）的 scrollHeight
// .window 有 min-height:100%，但当内容减少时 scrollHeight 也会同步缩小
// 因为 overflow 为 visible，scrollHeight 始终等于内容实际高度
function adjustWindowHeight() {
  // 使用 setTimeout 0 替代 rAF，让当前微任务/宏任务中的 DOM 变更先完成
  setTimeout(() => {
    const windowEl = document.querySelector('.window');
    if (!windowEl) return;

    // 临时移除 min-height 限制，确保测量的是内容真实高度
    const prevMinHeight = windowEl.style.minHeight;
    windowEl.style.minHeight = '0';
    void windowEl.offsetHeight;

    const totalHeight = windowEl.scrollHeight;

    windowEl.style.minHeight = prevMinHeight;

    if (totalHeight > 0 && window.electronAPI && window.electronAPI.setWindowHeight) {
      // 直接传整个 .window 的高度给主进程，主进程不需要再加 titlebar
      window.electronAPI.setWindowHeight(totalHeight);
    }
  }, 0);
}

// 使用 MutationObserver 监听当前活动面板的内容变化，自动调整高度
let heightObserver = null;
function observeActivePanel() {
  if (heightObserver) heightObserver.disconnect();
  const contentEl = document.querySelector('.content');
  if (!contentEl) return;
  heightObserver = new MutationObserver(() => {
    adjustWindowHeight();
  });
  heightObserver.observe(contentEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
}

// 页面加载后启动监听
observeActivePanel();

// 初始加载时立即调整一次窗口高度
// 用多次延迟确保 DOM 完全渲染后再测量
adjustWindowHeight();
setTimeout(() => adjustWindowHeight(), 100);

// ========== Toast ==========
let toastTimer;
function showToast(message, type) {
  clearTimeout(toastTimer);
  toast.className = 'toast ' + (type || 'success');
  toastMsg.textContent = message;
  toast.style.display = 'block';
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// ========== Theme ==========
// Theme toggle button removed from bind window — theme follows main window

// ========== Step 1: Login ==========
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('btn-steam-login');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('loginError');
const loginErrorText = document.getElementById('loginErrorText');
const loginStatus = document.getElementById('login-status');
const loginStatusText = document.getElementById('login-status-text');
const guardCodeGroup = document.getElementById('guard-code-group');
const guardCodeInput = document.getElementById('login-guard-code');
const guardHint = document.getElementById('guard-hint');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const account = loginUsername.value.trim();
  const password = loginPassword.value.trim();

  // Clear previous errors
  loginUsername.classList.remove('error');
  loginPassword.classList.remove('error');
  loginError.style.display = 'none';

  let hasError = false;
  if (!account) {
    loginUsername.classList.add('error');
    loginErrorText.textContent = '请输入 Steam 账号';
    loginError.style.display = 'flex';
    hasError = true;
  }
  if (!password) {
    loginPassword.classList.add('error');
    if (!hasError) {
      loginErrorText.textContent = '请输入 Steam 密码';
      loginError.style.display = 'flex';
    }
    hasError = true;
  }
  if (hasError) return;

  // If guard code is visible, submit with guard code
  const guardCode = guardCodeInput ? guardCodeInput.value.trim() : '';

  // Show loading
  loginBtn.classList.add('loading');
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner"></span>登录中...';
  loginStatus.classList.add('show');
  loginStatusText.textContent = guardCode ? '正在验证...' : '正在登录...';

  try {
    const result = await window.electronAPI.steamLogin({
      account,
      password,
      guardCode: guardCode || undefined,
    });

    if (result.success && result.needGuard) {
      // 需要 Steam Guard 验证码（needGuard 为 true 时 success 也为 true）
      state.guardType = result.guardType || 'email';
      state.emailDomain = result.emailDomain || '';
      guardCodeGroup.style.display = 'block';
      adjustWindowHeight();
      if (result.guardType === 'device') {
        guardHint.textContent = '请打开手机 Steam App 查看验证码。';
      } else {
        const domainHint = result.emailDomain
          ? `（邮箱域名: @${result.emailDomain}）`
          : '';
        guardHint.innerHTML = `验证码已发送至您的注册邮箱${domainHint}。如未收到，请检查垃圾邮件或点击<a href="#" id="resend-guard-link" style="color: #4a9eff; text-decoration: underline; margin-left: 4px;">重新发送</a>。`;
        // 绑定重发事件
        setTimeout(() => {
          const resendLink = document.getElementById('resend-guard-link');
          if (resendLink) {
            resendLink.addEventListener('click', async (ev) => {
              ev.preventDefault();
              resendLink.textContent = '正在重新发送...';
              resendLink.style.pointerEvents = 'none';
              try {
                // 重新走第一阶段登录，Steam 会重新发送验证码邮件
                const resendResult = await window.electronAPI.steamLogin({
                  account,
                  password,
                });
                if (resendResult.success && resendResult.needGuard) {
                  state.guardType = resendResult.guardType || 'email';
                  state.emailDomain = resendResult.emailDomain || '';
                  const newDomainHint = resendResult.emailDomain
                    ? `（邮箱域名: @${resendResult.emailDomain}）`
                    : '';
                  guardHint.innerHTML = `验证码已重新发送至您的注册邮箱${newDomainHint}。如未收到，请检查垃圾邮件或<a href="#" id="resend-guard-link" style="color: #4a9eff; text-decoration: underline; margin-left: 4px;">重新发送</a>。`;
                  // 重新绑定事件
                  const newLink = document.getElementById('resend-guard-link');
                  if (newLink) newLink.addEventListener('click', arguments.callee);
                  showToast('验证码已重新发送', 'success');
                } else {
                  showToast('重新发送失败，请稍后重试', 'error');
                }
              } catch (err) {
                showToast('重新发送失败: ' + (err.message || '网络错误'), 'error');
              } finally {
                resendLink.textContent = '重新发送';
                resendLink.style.pointerEvents = 'auto';
              }
            });
          }
        }, 100);
      }
      loginStatusText.textContent = '需要 Steam Guard 验证码';
      loginStatus.classList.remove('show');
      loginBtn.innerHTML = '验证并登录';
    } else if (result.success) {
      state.account = account;
      // 保存登录返回的关键数据
      state.accessToken = result.accessToken || '';
      state.steamId = result.steamId || '';
      state.webCookies = result.webCookies || '';
      // 关键检查：accessToken 为空则无法进行后续操作
      if (!state.accessToken) {
        loginStatus.classList.remove('show');
        loginErrorText.textContent = '登录成功但未获取到 accessToken，可能是代理或网络问题，请重试';
        loginError.style.display = 'flex';
        return;
      }
      // 登录成功，进入 Step 2 开始真正的令牌绑定流程
      // 无论是否提交过 guardCode，都需要走 AddAuthenticator → FinalizeAddAuthenticator 流程
      goToStep(2);
    } else if (result.needGuard) {
      // Need Steam Guard code（此分支理论不会到达，保留作防御）
      state.guardType = result.guardType || 'email';
      state.emailDomain = result.emailDomain || '';
      guardCodeGroup.style.display = 'block';
      adjustWindowHeight();
      guardHint.textContent = result.guardType === 'device'
        ? '请打开手机 Steam App 查看验证码。'
        : '请查收注册邮箱中的验证码。';
      loginStatusText.textContent = '需要 Steam Guard 验证码';
      loginStatus.classList.remove('show');
      loginBtn.innerHTML = '验证并登录';
    } else {
      loginStatus.classList.remove('show');
      loginErrorText.textContent = result.message || '账号或密码错误';
      loginError.style.display = 'flex';
    }
  } catch (err) {
    loginStatus.classList.remove('show');
    loginErrorText.textContent = err.message || '登录失败，请检查网络连接';
    loginError.style.display = 'flex';
  } finally {
    loginBtn.classList.remove('loading');
    loginBtn.disabled = false;
    loginBtn.innerHTML = guardCode ? '验证并登录' : '登录 Steam';
  }
});

// Clear error on input
loginUsername.addEventListener('input', () => {
  loginUsername.classList.remove('error');
  loginError.style.display = 'none';
});
loginPassword.addEventListener('input', () => {
  loginPassword.classList.remove('error');
  loginError.style.display = 'none';
});

// Password visibility toggle
document.getElementById('togglePassword').addEventListener('click', () => {
  const icon = document.getElementById('eyeIcon');
  if (loginPassword.type === 'password') {
    loginPassword.type = 'text';
    icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
    document.getElementById('togglePassword').setAttribute('aria-label', '隐藏密码');
  } else {
    loginPassword.type = 'password';
    icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
    document.getElementById('togglePassword').setAttribute('aria-label', '显示密码');
  }
});

// Cancel button
document.getElementById('cancelBtn').addEventListener('click', () => {
  if (state.step <= 1) {
    if (confirm('确定要取消绑定吗？')) {
      window.close();
    }
  } else {
    if (confirm('确定要取消绑定吗？当前进度将丢失。')) {
      window.close();
    }
  }
});

// ========== Step 2: Email Verification ==========
const smsCodeInput = document.getElementById('sms-code');
const smsStatus = document.getElementById('sms-status');
const smsStatusText = document.getElementById('sms-status-text');
const emailCodeSection = document.getElementById('email-code-section');

// 自动发送邮箱验证码
let emailCodeSent = false;
async function autoSendEmailCode() {
  if (emailCodeSent) return;
  smsStatus.classList.add('show');
  smsStatusText.textContent = '正在发送验证码到邮箱...';

  try {
    const result = await window.electronAPI.sendEmailCode({
      accessToken: state.accessToken,
      steamId: state.steamId,
    });
    if (result.success) {
      emailCodeSent = true;
      // 保存 addAuthenticator 返回的 sharedSecret 等数据
      state.sharedSecret = result.sharedSecret || '';
      state.identitySecret = result.identitySecret || '';
      state.secret1 = result.secret1 || '';
      state.revocationCode = result.revocationCode || '';
      smsStatusText.textContent = '验证码已发送，请查收邮件';
      smsCodeInput.focus();
    } else {
      // 检查是否实际上验证码已发送（Steam 有时返回非标准状态码但邮件已触发）
      if (result.status && result.sharedSecret) {
        emailCodeSent = true;
        state.sharedSecret = result.sharedSecret || '';
        state.identitySecret = result.identitySecret || '';
        state.secret1 = result.secret1 || '';
        state.revocationCode = result.revocationCode || '';
        smsStatusText.textContent = '验证码已发送，请查收邮件';
        smsCodeInput.focus();
        return;
      }
      // 如果是登录信息丢失，给用户提供返回上一步的选项
      if (result.needRelogin) {
        smsStatusText.innerHTML = '登录信息丢失，请<a href="#" id="back-to-login-link" style="color: #4a9eff; text-decoration: underline;">返回上一步重新登录</a>';
        document.getElementById('back-to-login-link').addEventListener('click', (e) => {
          e.preventDefault();
          goToStep(1);
          smsStatus.classList.remove('show');
        });
        return;
      }
      smsStatusText.textContent = result.error || result.message || '发送失败，请重试';
    }
  } catch (err) {
    smsStatusText.textContent = err.message || '发送失败，请检查网络';
  } finally {
    setTimeout(() => {
      if (smsStatusText.textContent.includes('已发送')) {
        smsStatus.classList.remove('show');
      }
    }, 3000);
  }
}

// Verify email code
document.getElementById('btn-verify-sms').addEventListener('click', async () => {
  const code = smsCodeInput.value.trim();
  const errorEl = document.getElementById('codeError');
  const errorText = document.getElementById('codeErrorText');

  smsCodeInput.classList.remove('error');
  errorEl.style.display = 'none';

  if (!code) {
    smsCodeInput.classList.add('error');
    errorText.textContent = '请输入邮箱验证码';
    errorEl.style.display = 'flex';
    return;
  }

  const btn = document.getElementById('btn-verify-sms');
  btn.classList.add('loading');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>验证中...';

  try {
    const result = await window.electronAPI.verifyEmailCode({
      code,
      accessToken: state.accessToken,
      steamId: state.steamId,
      sharedSecret: state.sharedSecret,
      identitySecret: state.identitySecret,
      secret1: state.secret1,
      accountName: state.account,
      webCookies: state.webCookies,
    });
    if (result.success) {
      // revocationCode 在 AddAuthenticator 阶段就已返回，这里更新（如果 Finalize 也返回了的话）
      state.revocationCode = result.revocationCode || state.revocationCode || '';
      document.getElementById('revocation-code').textContent = state.revocationCode;
      goToStep(3);
    } else {
      smsCodeInput.classList.add('error');
      errorText.textContent = result.error || result.message || '验证码无效';
      errorEl.style.display = 'flex';
    }
  } catch (err) {
    smsCodeInput.classList.add('error');
    errorText.textContent = err.message || '验证失败';
    errorEl.style.display = 'flex';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.innerHTML = '验证并绑定';
  }
});

smsCodeInput.addEventListener('input', () => {
  smsCodeInput.classList.remove('error');
  document.getElementById('codeError').style.display = 'none';
});

document.getElementById('backToLoginBtn').addEventListener('click', () => goToStep(1));

// ========== Step 3: Save ==========
document.getElementById('btn-confirm-revocation').addEventListener('click', async () => {
  const btn = document.getElementById('btn-confirm-revocation');
  btn.classList.add('loading');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>保存中...';

  try {
    const result = await window.electronAPI.saveCredentials({
      account: state.account,
      steamId: state.steamId,
      accessToken: state.accessToken,
      webCookies: state.webCookies,
      sharedSecret: state.sharedSecret,
      identitySecret: state.identitySecret,
      secret1: state.secret1,
      revocationCode: state.revocationCode,
    });
    if (result.success) {
      goToStep(4);
    } else {
      showToast(result.message || '保存失败', 'error');
    }
  } catch (err) {
    showToast(err.message || '保存失败', 'error');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.innerHTML = '保存令牌';
  }
});

// Copy revocation code
document.getElementById('btn-copy-revocation').addEventListener('click', async () => {
  const btn = document.getElementById('btn-copy-revocation');
  const code = document.getElementById('revocation-code').textContent;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    const originalText = btn.textContent;
    btn.textContent = '复制成功 ✓';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  } catch {
    showToast('复制失败，请手动复制', 'error');
  }
});

document.getElementById('backToCodeBtn').addEventListener('click', () => goToStep(2));

// ========== Step 4: Done ==========
document.getElementById('btn-finish-bind').addEventListener('click', () => {
  window.close();
});


// Listen for theme changes from main process (initial sync + subsequent changes)
// Register early so we don't miss the initial theme-changed event
if (window.electronAPI && window.electronAPI.onThemeChange) {
  window.electronAPI.onThemeChange((theme) => {
    state.theme = theme;
    applyTheme(theme);
  });
}
// Immediately sync body theme with state
applyTheme(state.theme);

let themeInitialized = false;
function applyTheme(theme) {
  // Convert 'system' to actual color scheme, since CSS only supports 'dark' and 'light'
  const actual = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  body.setAttribute('data-theme', actual);
  // 首次主题应用完成后，移除 no-transition 恢复过渡动画
  if (!themeInitialized) {
    themeInitialized = true;
    // 延迟一帧确保样式已应用，再恢复过渡
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('no-transition');
    });
  }
}
