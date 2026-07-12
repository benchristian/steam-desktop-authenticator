# Steam Desktop Authenticator for macOS

基于 Electron 的 Steam 桌面令牌验证器，在 macOS 上生成 Steam Guard 验证码，并支持通过 Steam 账号直接登录绑定验证器。

## 功能

- Steam Guard TOTP 验证码，30 秒自动刷新，一键复制
- 多账号管理，账号数据以本地 `.maFile` 文件存储（位于用户数据目录，不上传）
- 通过 Steam 账号密码 + 手机令牌直接绑定验证器（自动获取 shared_secret，无需手动提取密钥）
- 右键菜单快捷操作：设置库存公开、批量确认交易、修改昵称、随机更换头像、刷新令牌数据
- 重新登录时从 CSV 文件自动匹配并填入账号密码

## 安装与运行

```bash
cd steam-desktop-authenticator
npm install
npm start
```

> 若 Electron 二进制下载失败，可设置网络代理后重试 `npm install electron --no-save`。

打包为 macOS 应用：

```bash
npm run build:dmg   # 生成 DMG 安装包
npm run build:zip   # 生成 ZIP 包
```

打包产物输出在 `dist/` 目录。

## 随机头像

右键菜单「随机头像」会从程序目录下的 `custom-avatars/` 文件夹随机选取一张图片，并上传为 Steam 个人资料头像。使用前请在该文件夹放入 `.png/.jpg/.jpeg/.gif/.webp/.bmp` 格式的图片。

## CSV 密码自动填充

将账号密码保存到 CSV 文件，格式为：

```csv
steam账户,steam密码
your_account,password123
```

重新登录时，应用会根据账号名（大小写不敏感）匹配并自动填入对应密码，无需手动输入。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd + N` | 添加新账号 |
| `Cmd + C` | 复制第一个账号的验证码 |
| `Esc` | 关闭弹窗 / 隐藏窗口 |

## 技术栈

- Electron
- steam-session / steam-totp / steamcommunity
- jsqr、chrome-remote-interface、ws（辅助依赖）

## 许可证

MIT
