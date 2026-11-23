# SubVault 隐私政策 / Privacy Policy

最后更新：2026-11-16

SubVault（以下简称“本扩展”）是一个**完全本地**的密码管理器。我们不收集、不传输、不出售、不共享任何个人数据。

## 1. 我们不收集什么

- 没有账号系统，没有注册，没有云端服务。
- 不收集使用统计、崩溃报告、设备标识、IP 地址、浏览记录或页面内容。
- 没有 `fetch` / `XMLHttpRequest` / `WebSocket`；扩展页 CSP 为 `connect-src 'none'`，即使代码意外发起请求也会被浏览器拦截。
- 不加载任何远程脚本、远程样式、远程字体或远程图片。

## 2. 数据保存在哪里

| 位置 | 内容 | 生命周期 |
| --- | --- | --- |
| `chrome.storage.local` | AES-256-GCM 加密后的密码库（账号、非登录资料、设置、子域规则、站点例外）；最多 20 套，按 `vault` / `vault:<id>` 分开保存 | 直到卸载或重置 |
| `chrome.storage.local`（迁移备份） | 升级到 v4 格式前的旧密文 `vaultBackup:<id>`；回滚或修改主密码/密钥文件后删除 | 直到卸载、重置、回滚或重新包装 |
| `chrome.storage.local`（明文索引） | 密码库 id、显示名称、创建时间、是否启用密钥文件；不含账号或密码 | 直到卸载或重置 |
| `chrome.storage.session` | 解锁期间的派生密钥（JWK）、待保存候选 | 浏览器关闭或锁定后清除 |
| 用户主动导出 | 明文 CSV（兼容格式）或 `.svbak` 私有二进制容器中的加密备份/同步快照/恢复说明 | 由用户自行保管 |
| 本机同步宿主（可选） | 加密密码库密文、同步修订号 | 直到卸载宿主或删除数据 |
| 本机同步宿主（可选，设备快速解锁） | 用当前 Windows 用户 DPAPI 保护的 VaultKey 副本与平台认证器凭据 ID（`device.json` / `device-<id>.json`），不含主密码或明文 VaultKey | 直到移除绑定、删除密码库、回滚格式、清空扩展或卸载宿主 |

主密码不会被保存，也不会离开设备。v4 格式中，主密码只用于派生 KEK 并解包随机的 VaultKey；VaultKey 和 KEK 只在解锁期间存在于内存与 `chrome.storage.session`。迁移备份是旧密码库的密文，同样不参与同步或上传，回滚后即删除。内容脚本只能按当前站点向后台请求少量账号记录，拿不到完整密码库。设备快速解锁的 VaultKey 副本由 Windows DPAPI 绑定到当前用户与设备，只在本机固定的用户数据目录（Windows 为 `%LOCALAPPDATA%\SubVaultSync`）中，不参与同步，也不会离开设备。

## 3. 权限用途

- `storage`：保存加密密码库和设置。
- `alarms`：精确调度自动锁定。
- `idle`：可选的系统锁屏/空闲锁定。
- `activeTab`：popup 作用于当前标签页。
- `privacy`：仅在用户主动开启时关闭 Chrome 自带的“保存密码”提示。
- `nativeMessaging`：可选的本机跨浏览器同步，不联网。
- `clipboardWrite`：用户点击复制时写入剪贴板。
- `clipboardRead`（可选）：用户授权后校验剪贴板再自动清除。
- `http://*/*`、`https://*/*`：在登录表单旁显示填充入口。

## 4. 可选的本机同步

本机同步通过 Native Messaging 在本机浏览器之间传递**加密密文**；宿主程序不监听网络端口，只接受固定扩展 ID 的连接。是否使用完全由用户决定。全部密码库在固定的用户数据目录（Windows 为 `%LOCALAPPDATA%\SubVaultSync`，macOS/Linux 为对应配置目录）中分别保存为 `state.json` / `vault-<id>.json`；该目录不随宿主安装位置变化。

可选的 WebDAV 独立备份由宿主代理，扩展自身仍然零网络；每次备份会在远端目录留下主备份 `state.json` 和带时间戳的密文副本 `subvault-YYYYMMDD-HHmmss.json`，两者都是同一份加密密文；可选的“定时自动备份”会按用户设定的保留份数与过期天数自动清理旧副本（默认关闭，两个规则都为 0 时不删除任何副本），也可在设置页手动按规则清理；凭据只保存在加密密码库内，不写入宿主磁盘。备份有效期与分享有效期都参与密钥派生，过期文件无法用原口令解密。Passkey 记录只保存凭据 ID/RP ID/账号/备注，不含 Passkey 私钥。随包 `companion/index.html` 是纯本地单文件页面，不发起网络请求、不存储数据，解密只在浏览器内存中完成。

## 5. 数据删除

- 在设置页“危险操作”中重置/清除密码库。
- 卸载扩展会删除 `chrome.storage` 中的数据。
- 删除本机同步宿主数据：`native-host\uninstall-host.ps1 -RemoveData`。
- 可选的 `.svkey` 密钥文件只有 40 字节，不含密码或账号数据，仅作为解密备份/分享文件的第二因素；建议与备份文件分开存放，并和备份文件一起自行删除。
- 已导出的 CSV/`.svbak` 备份文件需要用户自行删除。`.svbak` 是私有二进制容器（`SVBAK` 魔数 + gzip），只存放已加密的密文或恢复说明文本，不含主密码或明文账号；恢复说明可在设置页弹窗内直接查看，无需外部工具。

## 6. 儿童隐私

本扩展不面向儿童，也不收集任何年龄或身份信息。

## 7. 政策变更

若未来版本改变数据处理方式，会在本文件和发布说明中明确说明；在获得用户同意前不会改变“纯本地、零收集”的现状。

## 8. 联系方式

通过 GitHub Issues 联系：<https://github.com/1214163108/SubVault/issues>

---

# Privacy Policy (English summary)

SubVault is a local-only password manager. It collects, transmits, sells and
shares **no** personal data. It has no account system and no servers. The
encrypted vault lives in `chrome.storage.local`; the derived key lives in
`chrome.storage.session` and is cleared on lock/browser exit. The master
password is never stored. There is no network code and the extension CSP sets
`connect-src 'none'`. The optional Native Messaging host exchanges only the
encrypted vault with a fixed extension ID on the same machine and opens no
network ports. Users can delete all data by wiping the vault, uninstalling the
extension, or running `native-host\uninstall-host.ps1 -RemoveData`.

## 回收站、动态码提示与 50 MB 预算

- 回收站是加密密码库数据的一部分（`trash`），只保存在本机；清空或恢复都不会上传。
- 网页动态码提示在本地计算并显示，不向任何服务器发送验证码或站点信息。
- 设置页的 50 MB 是存储预算提示，不是云端配额；申请 `unlimitedStorage` 不代表数据离开本机。
