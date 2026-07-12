# Steam Desktop Authenticator for macOS

基于 Electron 的 Steam 桌面令牌验证器，在 macOS 上生成 Steam Guard 验证码，并支持通过 Steam 账号直接登录绑定验证器。

## 功能

- Steam Guard TOTP 验证码，30 秒自动刷新
- 多账号管理，本地存储
- 通过 Steam 账号密码 + 手机令牌直接绑定验证器（自动获取 shared_secret，无需手动提取）
- 二维码扫码登录
- 右键菜单快捷操作：设置库存公开、批量确认交易、修改昵称、随机头像、刷新令牌数据
- 重新登录时从 CSV 文件自动填充账号密码

## 安装与运行

```bash
cd steam-desktop-authenticator
npm install
npm start
```

打包为 macOS 应用：

```bash
npm run build:dmg   # 生成 DMG
npm run build:zip   # 生成 ZIP
```

打包产物在 `dist/` 目录。

## CSV 密码自动填充

将账号密码保存到 CSV 文件，格式为：

```csv
steam账户,steam密码
your_account,password123
```

重新登录时，应用会根据账号名自动匹配并填入对应密码，无需手动输入。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd + N` | 添加新账号 |
| `Cmd + C` | 复制第一个账号的验证码 |
| `Esc` | 关闭弹窗 / 隐藏窗口 |

## 技术栈

- Electron
- steam-session / steam-totp / steamcommunity

## 许可证

MIT
