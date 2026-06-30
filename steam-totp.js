/**
 * Steam TOTP (Time-based One-Time Password) 核心算法实现
 * 
 * Steam Guard 移动验证器使用标准的 TOTP 算法 (RFC 6238)，
 * 但使用自定义的字符集映射。
 * 
 * 参考: https://github.com/SteamTimeIdler/stidler/wiki/Getting-your-%27shared_secret%27-code-for-use-with-Auto-Restarter-on-Mobile-Authentication
 */

const CryptoJS = require('crypto-js');

// Steam 验证码字符集 (与 Google Authenticator 不同)
const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

/**
 * 将 hex 字符串转换为 Uint8Array
 */
function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

/**
 * 生成 Steam Guard 验证码
 * @param {string} sharedSecret - Base64 编码的 shared_secret
 * @returns {object} { code: string, timeRemaining: number, period: number }
 */
function generateSteamGuardCode(sharedSecret) {
  if (!sharedSecret || sharedSecret.length === 0) {
    throw new Error('shared_secret 不能为空');
  }

  // 计算当前时间步 (30秒为一个周期)
  const period = 30;
  const currentTime = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(currentTime / period);
  
  // 剩余秒数
  const timeRemaining = period - (currentTime % period);

  // 生成 HMAC-SHA1
  const timeBytes = new Uint8Array(8);
  let t = timeStep;
  for (let i = 7; i >= 0; i--) {
    timeBytes[i] = t & 0xff;
    t = t >> 8;
  }

  // Base64 解码 shared_secret
  const secretBytes = CryptoJS.enc.Base64.parse(sharedSecret);
  const secretWordArray = CryptoJS.lib.WordArray.create(secretBytes.words, secretBytes.sigBytes);
  const timeWordArray = CryptoJS.lib.WordArray.create(timeBytes);

  // HMAC-SHA1
  const hmac = CryptoJS.HmacSHA1(timeWordArray, secretWordArray);
  const hmacBytes = hexToBytes(hmac.toString());

  // 动态截断 (Dynamic Truncation)
  const offset = hmacBytes[19] & 0x0f;
  const binary =
    ((hmacBytes[offset] & 0x7f) << 24) |
    ((hmacBytes[offset + 1] & 0xff) << 16) |
    ((hmacBytes[offset + 2] & 0xff) << 8) |
    (hmacBytes[offset + 3] & 0xff);

  // Steam 特殊编码: 使用自定义字符集
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += STEAM_CHARS.charAt(binary % STEAM_CHARS.length);
    // 注意：Steam 使用整数除法，不是每次都取模
    // 实际上每个字符对应不同的除数
  }

  // 正确的 Steam 编码方式
  let fullCode = '';
  let remaining = binary;
  for (let i = 0; i < 5; i++) {
    fullCode = STEAM_CHARS.charAt(remaining % STEAM_CHARS.length) + fullCode;
    remaining = Math.floor(remaining / STEAM_CHARS.length);
  }

  return {
    code: fullCode,
    timeRemaining: timeRemaining,
    period: period
  };
}

/**
 * 生成确认码 (Confirmation Key)
 * 用于确认交易
 * @param {string} identitySecret - Base64 编码的 identity_secret
 * @param {number} time - Unix 时间戳 (可选，默认当前时间)
 * @returns {string} 确认码
 */
function generateConfirmationKey(identitySecret, time) {
  if (!time) {
    time = Math.floor(Date.now() / 1000);
  }
  return generateConfirmationKeyForTime(identitySecret, time, 'conf');
}

/**
 * 生成设备 ID
 * @param {string} steamId - Steam 64位 ID
 * @returns {string} 设备 ID
 */
function generateDeviceId(steamId) {
  const hash = CryptoJS.SHA256(steamId.toString());
  const hex = hash.toString();
  
  // Steam 设备 ID 格式: android:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuid = [
    'android:' + hex.substr(0, 8),
    hex.substr(8, 4),
    hex.substr(12, 4),
    hex.substr(16, 4),
    hex.substr(20, 12)
  ].join('-');

  return uuid;
}

/**
 * 为特定时间生成确认密钥
 */
function generateConfirmationKeyForTime(identitySecret, time, tag) {
  if (!identitySecret || identitySecret.length === 0) {
    throw new Error('identity_secret 不能为空');
  }

  const timeBytes = new Uint8Array(8);
  let t = Math.floor(time / 30); // 30秒周期（确认密钥可能使用不同周期，这里以常见实现为准）
  for (let i = 7; i >= 0; i--) {
    timeBytes[i] = t & 0xff;
    t = t >> 8;
  }

  // 尝试多种周期（不同实现可能不同）
  const dataToSign = tag 
    ? new TextEncoder().encode(tag) 
    : new Uint8Array(0);

  // 合并时间字节和数据
  const combined = new Uint8Array(timeBytes.length + dataToSign.length);
  combined.set(timeBytes);
  combined.set(dataToSign, timeBytes.length);

  const secretBytes = CryptoJS.enc.Base64.parse(identitySecret);
  const secretWordArray = CryptoJS.lib.WordArray.create(secretBytes.words, secretBytes.sigBytes);
  const combinedWordArray = CryptoJS.lib.WordArray.create(combined);

  const hmac = CryptoJS.HmacSHA1(combinedWordArray, secretWordArray);
  return CryptoJS.enc.Base64.stringify(hmac);
}

/**
 * 验证 shared_secret 格式是否有效
 * @param {string} secret - Base64 编码的密钥
 * @returns {boolean}
 */
function isValidSecret(secret) {
  if (!secret || typeof secret !== 'string') return false;
  // Base64 正则
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(secret)) return false;
  try {
    const bytes = CryptoJS.enc.Base64.parse(secret);
    return bytes.sigBytes > 0;
  } catch {
    return false;
  }
}

/**
 * 批量生成多个验证码 (用于管理多个账号)
 * @param {Array<{name: string, sharedSecret: string}>} accounts
 * @returns {Array<{name: string, code: string, timeRemaining: number}>}
 */
function generateMultipleCodes(accounts) {
  return accounts.map(account => {
    try {
      const result = generateSteamGuardCode(account.sharedSecret);
      return {
        name: account.name,
        code: result.code,
        timeRemaining: result.timeRemaining,
        error: null
      };
    } catch (err) {
      return {
        name: account.name,
        code: 'ERROR',
        timeRemaining: 0,
        error: err.message
      };
    }
  });
}

module.exports = {
  generateSteamGuardCode,
  generateConfirmationKey,
  generateDeviceId,
  isValidSecret,
  generateMultipleCodes,
  STEAM_CHARS
};
