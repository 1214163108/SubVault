SubVault 本机同步宿主
====================

适用：Windows 10/11、macOS 12+、Linux（x64 / arm64），
浏览器：Chrome / Edge / Brave / Chromium。

Windows 使用 SubVaultSync.exe（.NET Framework 4.8）；
macOS / Linux 使用 subvault-sync-<平台>-<架构>（Go 单文件，无需运行时）。

安装（Windows）：
1. 将本目录解压到固定位置（不要放在临时目录）。
2. 以 PowerShell 运行：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-host.ps1
3. 重新加载扩展。设置页出现“检测到本机已有 SubVault 密码库”即表示连接成功。

安装（macOS / Linux）：
1. 解压本目录到固定位置（不要放在临时目录）。
2. 运行：./install-host.sh
   脚本会按 uname 选择对应二进制，并写入
   ~/Library/Application Support/...（macOS）
   或 ~/.config/...（Linux）下的 NativeMessagingHosts。
3. 重启浏览器并重新加载扩展。

自行构建（需要 Go 1.21+）：
   cd go && go build -trimpath -ldflags "-s -w" -o ../subvault-sync-$(go env GOOS)-$(go env GOARCH) .
   或运行 ./build-host.sh

安装脚本会写入：
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.subvault.sync
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.subvault.sync
HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.subvault.sync
HKCU\Software\Chromium\NativeMessagingHosts\com.subvault.sync

数据位置：
优先：宿主可执行文件同目录下的 data/
      默认库 state.json，其他库 vault-<id>.json
回退：Windows %LOCALAPPDATA%\SubVaultSync\
      macOS ~/Library/Application Support/SubVaultSync/
      Linux ${XDG_CONFIG_HOME:-~/.config}/SubVaultSync/

设备快速解锁（仅 Windows）：
启用后，扩展先通过 WebAuthn 平台认证器（Windows Hello）创建凭据，Windows
宿主再用当前用户的 DPAPI 保护一份仅限本机的 VaultKey 副本，保存为
data/device.json（默认库）或 data/device-<id>.json，并记录 credentialId。
解锁时先做 Windows Hello 验证，再解保护；没有平台认证器时无法启用设备快速解锁。旧版本创建且缺少 credentialId 的绑定会被拒绝，需在主密码解锁后重新启用，不能绕过 PIN。
扩展不保存主密码，宿主不会以明文保存 VaultKey；绑定不参与同步。主密码
始终可回退。移除绑定、删除密码库、回滚格式或清空扩展时，宿主会删除对应
文件。macOS / Linux 宿主明确返回不支持。

WebDAV 独立备份（可选）：
WebDAV 只做备份/恢复，不参与本机实时同步。在扩展设置页「同步与备份」
单独配置后，宿主会代理访问 <WebDAV 地址>/subvault/state.json（默认库）或
/subvault/<id>/state.json（其他库），执行 GET / PUT / MKCOL，扩展自身仍然
不直接联网。地址必须为 HTTPS；本机测试允许 http://127.0.0.1 和
http://localhost。用户名/密码随每条命令临时传入，不写入磁盘；WebDAV 凭据
只保存在扩展的加密密码库中。恢复时以 WebDAV 备份为准，覆盖当前库并要求
重新解锁。

说明：
- 宿主只保存加密后的密码库密文和同步设置，无法解密主密码。
- 不监听网络端口，只通过浏览器 Native Messaging 与本扩展固定 ID 通信；
  仅在启用 WebDAV 时向用户配置的服务器发起 HTTPS 请求。
- Windows 版需要 .NET Framework 4.8；Windows 10/11 通常已自带。
- macOS / Linux 版是静态 Go 二进制，无外部依赖。

卸载：
1. 注销宿主（保留同步数据）：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-host.ps1

2. 注销宿主并删除同步数据：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-host.ps1 -RemoveData
   macOS / Linux: ./uninstall-host.sh --remove-data

3. 删除程序文件（在宿主目录外执行）：
   Remove-Item -LiteralPath "D:\SubVaultSyncHost" -Recurse -Force

4. 删除扩展：
   chrome://extensions -> SubVault -> 移除
   Edge: edge://extensions
   Brave: brave://extensions

注意：
- 删除扩展会删除该浏览器里的本地密码库；请先在设置页导出加密备份。
- -RemoveData 会删除宿主目录下的 data 和 %LOCALAPPDATA%\SubVaultSync。
- 卸载宿主不会自动删除各浏览器扩展自己的本地密码库。

