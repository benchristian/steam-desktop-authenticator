# Steam Desktop Authenticator for macOS

🔐 Steam 桌面令牌验证器 - macOS 原生应用

一个基于 Electron 的 macOS Steam Guard 验证器，让你在 Mac 上也能生成 Steam 登录验证码，无需每次拿出手机。

## ✨ 功能特性

- 🎯 **Steam Guard TOTP 算法** - 完全兼容 Steam 移动验证器
- 🔄 **30秒自动刷新** - 实时显示验证码和倒计时
- 📋 **一键复制** - 点击或快捷键复制验证码到剪贴板
- 👥 **多账号管理** - 支持同时管理多个 Steam 账号
- 💾 **本地存储** - 数据加密保存在本地，安全可靠
- 📥 **导入/导出** - 支持账号数据备份和迁移
- 🖥️ **系统托盘** - 最小化到托盘，随时调出
- 🎨 **深色/浅色主题** - 自动适配系统主题
- ⌨️ **快捷键** - `Cmd+N` 添加账号，`Cmd+C` 复制验证码

## 📦 安装与运行

### 方式一：直接运行（开发模式）

```bash
# 进入项目目录
cd steam-authenticator

# 安装依赖
npm install

# 启动应用
npm start
```

### 方式二：打包为 macOS 应用

```bash
# 打包为 DMG 安装包
npm run build:dmg

# 打包为 ZIP
npm run build:zip
```

打包后的文件在 `dist/` 目录中。

## 🔑 如何获取 shared_secret？

Steam 验证器需要 `shared_secret` 密钥才能生成验证码。有以下几种方式获取：

### 方法 1：从 Android 手机提取（推荐）

1. Android 手机需要已 Root
2. 从 `/data/data/com.valvesoftware.android.steam.community/files/Steamguard-*` 文件中提取
3. 文件内容为 JSON 格式，其中包含 `shared_secret` 字段

### 方法 2：使用 Steam Desktop Authenticator (SDA)

1. 下载 [Steam Desktop Authenticator](https://github.com/Jessecar96/SteamDesktopAuthenticator)
2. 使用 SDA 登录 Steam 账号
3. SDA 会生成 `maFiles` 目录，其中包含加密的账号文件
4. 解密后获取 `shared_secret`

### 方法 3：从 iOS 备份提取

1. 备份 iPhone/iPad 到电脑
2. 使用 iBackupBot 等工具查看备份文件
3. 从 Steam App 的数据中提取

> ⚠️ **安全提醒**：`shared_secret` 是你 Steam 账号安全的关键，请妥善保管，不要分享给他人！

## 🖥️ 界面预览

```
┌─────────────────────────────────┐
│  🔐 Steam Authenticator         │
├─────────────────────────────────┤
│  [+ 添加]           [导入][导出] │
├─────────────────────────────────┤
│  🎮 主账号                  ⋮   │
│  ┌─────────────────────────┐   │
│  │  A B C D E        [📋]  │   │
│  └─────────────────────────┘   │
│  ████████████░░░░░░░░  20s    │
├─────────────────────────────────┤
│  🎮 小号                   ⋮   │
│  ┌─────────────────────────┐   │
│  │  X Y Z 1 2        [📋]  │   │
│  └─────────────────────────┘   │
│  ██████░░░░░░░░░░░░░░  10s    │
└─────────────────────────────────┘
```

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd + N` | 添加新账号 |
| `Cmd + C` | 复制第一个账号的验证码 |
| `Esc` | 关闭弹窗 / 隐藏窗口 |

## 🔒 安全性

- 所有数据保存在本地 `userData` 目录
- 不会向任何服务器发送数据
- 使用 Electron 的安全实践（contextIsolation、sandbox）
- 建议配合 macOS 的 FileVault 全盘加密使用

## 🛠️ 技术栈

- **Electron** - 跨平台桌面应用框架
- **CryptoJS** - 加密算法库（HMAC-SHA1）
- **原生 JavaScript** - 无额外框架依赖

## 📄 许可证

MIT License
