# Steam 桌面令牌验证器 — 项目文档

> **版本**: v2.0.0
> **平台**: macOS（仅打包 macOS 应用）
> **技术栈**: Electron + Node.js + HTML/CSS/JS

---

## 一、项目概述

一个基于 Electron 的 **Steam 桌面令牌验证器**，运行在 macOS 上。核心能力是通过 `steam-session` 模拟 Steam 手机 App 登录，直接绑定验证器并自动获取 `shared_secret`，无需手动提取密钥。同时支持 TOTP 验证码生成、交易确认、多账号管理与一系列右键菜单快捷操作。

---

## 二、项目结构

```
steam-desktop-authenticator/
├── main.js                  # Electron 主进程（窗口管理、IPC、Steam API、网页自动化）
├── renderer.js              # 主窗口渲染进程（UI 逻辑）
├── preload.js               # 安全上下文桥接 API
├── index.html               # 主界面
├── styles.css               # 样式表（深色/浅色主题）
├── steam-totp.js            # Steam TOTP 算法封装
├── bind.html / bind-renderer.js        # 绑定令牌窗口
├── confirmation.html / confirmation-renderer.js  # 交易确认窗口
├── steam-relogin.html       # 重新登录窗口
├── custom-avatars/          # 随机头像功能使用的本地图片库
├── icon.icns / icon.png     # 应用图标
├── package.json             # 项目配置与依赖
├── README.md                # 使用说明
├── PROJECT.md               # 本文档
└── dist/                    # 打包产物（DMG / .app）
```

---

## 三、技术架构

### 3.1 进程模型

```
┌─────────────────────────────────────────────┐
│                  Electron                    │
│  ┌──────────────┐    IPC     ┌────────────┐ │
│  │   main.js    │◄──────────►│ renderer.js│ │
│  │  (主进程)     │  preload   │ (渲染进程)  │ │
│  │ • 窗口管理    │            │ • UI 渲染   │ │
│  │ • 托盘图标    │            │ • 验证码显示 │ │
│  │ • 文件存储    │            │ • 搜索筛选   │ │
│  │ • Steam API  │            │ • 右键菜单   │ │
│  │ • 网页自动化  │            │ • 绑定流程   │ │
│  └──────────────┘            └────────────┘ │
└─────────────────────────────────────────────┘
```

### 3.2 核心依赖

| 依赖 | 用途 |
|------|------|
| `steam-session` | 模拟 Steam 手机 App 登录，获取访问令牌 |
| `steam-totp` | Steam Guard TOTP 验证码生成 |
| `steamcommunity` | Steam 社区 API 交互 |
| `jsqr` / `chrome-remote-interface` / `ws` | 辅助依赖（屏幕截图与浏览器调试相关能力） |

---

## 四、主要功能模块

### 4.1 验证码生成与显示

- **TOTP 算法**：与 Steam 手机 App 兼容的 5 位验证码
- **30 秒自动刷新**：带倒计时进度条
- **一键复制**：点击复制按钮或 `Cmd + C` 复制验证码

### 4.2 一键绑定令牌

通过 `steam-session` 模拟手机 App 登录完成绑定：

1. **Steam 登录** — 输入用户名密码，支持 Steam Guard 验证码
2. **邮箱验证码** — 发送验证码到注册邮箱并提交
3. **撤销代码** — 显示 revocation_code，提示用户保存
4. **完成** — 自动保存 `.maFile` 文件（含 shared_secret）

### 4.3 交易确认

- 查看待确认的 Steam 交易列表
- 支持单个确认/取消，以及一键全部确认
- 自动使用当前选中的账号

### 4.4 多账号管理

- 账号数据以本地 `.maFile` JSON 文件存储，不上传
- 搜索筛选：实时过滤账号名与 SteamID
- 右键菜单：复制信息、导出文件、设置库存公开、批量确认交易、修改昵称、随机头像、刷新令牌等
- 导入导出：支持 maFile JSON 格式

### 4.5 右键菜单快捷操作

在主窗口账号列表项上右键可执行：

| 操作 | 说明 |
|------|------|
| 设置库存公开 | 调用 Steam 隐私设置接口，将库存设为公开 |
| 批量确认交易 | 一次性确认该账号所有待处理交易 |
| 修改昵称 | 修改 Steam 个人资料名称 |
| 随机头像 | 从 `custom-avatars/` 随机选图并上传为头像 |
| 刷新令牌数据 | 重新拉取账号验证器状态 |

### 4.6 系统集成

- **系统托盘**：关闭窗口后最小化到托盘，托盘菜单可快速复制验证码
- **macOS 原生风格**：隐藏标题栏，支持系统浅色/深色模式自动切换
- **CSV 密码自动填充**：重新登录时按账号名从 CSV 匹配填入密码

---

## 五、数据存储

- **位置**：`app.getPath('userData')/maFiles/`（每个账号一个 `.maFile`）
- **关键字段**：`account_name`、`SteamID`、`shared_secret`、`identity_secret`、`access_token`、`revocation_code`、`web_cookies`
- 该目录已被 `.gitignore` 忽略，不会进入版本库

---

## 六、安全设计

- **上下文隔离**：`contextIsolation: true`，`nodeIntegration: false`
- **preload 桥接**：通过 `contextBridge` 暴露安全 API
- **本地存储**：所有账号数据保存在本地，不上传任何服务器

---

## 七、开发与构建

### 启动开发

```bash
cd steam-desktop-authenticator
npm install
npm start
```

### 构建打包

```bash
npm run build:dmg   # 打包为 macOS DMG
npm run build:zip   # 打包为 ZIP
npm run build       # 等价于 build:dmg（默认 mac target）
```

---

## 八、许可证

MIT License
