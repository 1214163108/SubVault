# SubVault · 子域名密码库

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

纯本地的 Chromium 密码管理器扩展（Manifest V3，Chrome / Edge / Brave，需 Chromium 111+）。数据只保存在本机：Argon2id + AES-256-GCM 加密，无云端、无账号、无网络请求。

当前版本：**v2.6.5**（本机同步宿主 **v1.5.5**）。

## 主要功能

- **域名规则**：默认同一主域下所有子域共享账号；可把主域加入“独立主域名”按子域隔离，也可按端口隔离。
- **自动填充**：账号框旁悬浮按钮选择账号，一次填入用户名 + 密码；支持分步登录、iframe、SPA 与动态码输入框；`Ctrl+Shift+L` 填充、`Ctrl+Shift+K` 锁定、`Ctrl+Shift+U` 打开面板。
- **保存提示**：登录/注册提交后提示保存新账号或更新密码。
- **导入**：Chrome / Edge / Firefox / Bitwarden / LastPass / 1Password 的 CSV，Bitwarden JSON、1Password 1PUX、KeePass KDBX；导入前预演，同站点同账号按最新时间合并。
- **密码库管理**：搜索筛选、健康度检查（弱密码/重复/超龄/HTTP）、收藏/文件夹/标签、密码历史、回收站 + 删除撤销、多密码库（最多 20 套）。
- **动态码**：TOTP / HOTP / Steam Guard，支持二维码离线导入；填充时自动填写验证码。
- **生成器**：8–128 位强密码、PIN、易读模式；注册页一键生成。
- **备份与分享**：加密备份（`.svbak`，可设独立密码与有效期）、一次性分享（`.svshare`）、可选 `.svkey` 密钥文件双因素、KDBX 互操作。
- **跨浏览器同步（可选）**：安装 Native Messaging 宿主后 Chrome / Edge / Brave 共用同一加密库；另支持 WebDAV 独立加密备份与定时自动备份。
- **安全**：自动锁定、Windows Hello 设备快速解锁（仅 Windows）、失焦隐私遮罩、旅行模式、中英双语界面。

## 安装

1. 从 [Releases](https://github.com/1214163108/SubVault/releases) 下载 `subvault-2.6.5.zip` 并解压（或直接使用本源码目录）。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择解压后的目录。
4. 点击工具栏 SubVault 图标，创建主密码。已打开的网页需刷新一次。

## 基本使用

- **填充**：点击账号输入框旁的 SubVault 按钮，选择账号即填入用户名和密码。
- **保存**：提交登录表单后按提示保存；也可在设置页手动添加。
- **导入浏览器密码**：浏览器密码管理器 → 导出 CSV → SubVault 设置页“导入与导出”选择文件，确认预演后导入，随后删除明文 CSV。
- **备份**：设置页“导入与导出”→ 导出加密备份，妥善保管 `.svbak`（及可选 `.svkey`）；主密码丢失无法恢复。

## 跨浏览器同步（可选）

1. 下载并解压 `subvault-sync-host-1.5.5.zip`。
2. Windows 运行 `install-host.ps1`（PowerShell）；macOS / Linux 运行 `install-host.sh`。
3. 浏览器 A 创建密码库后，浏览器 B 首次打开会提示“导入已有密码库”，输入 A 的主密码即可，无需新建。
4. 同步数据保存在本机用户目录（Windows：`%LOCALAPPDATA%\SubVaultSync`），不经过网络。

## 开发与测试

```bash
node --test tests/*.test.js   # 单元测试（逐个文件执行亦可）
node tools/verify-manifest.mjs && node tools/check-dom.mjs && node tools/check-i18n.mjs
node tools/test-<name>-e2e.mjs  # Playwright E2E（需先安装 Chromium）
python tools/package.py         # 确定性打包 dist/subvault-<version>.zip
```

安全模型见 [SECURITY.md](SECURITY.md)，隐私政策见 [PRIVACY.md](PRIVACY.md)。本项目未经独立第三方安全审计。

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。