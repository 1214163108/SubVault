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

数据位置（固定在用户目录，不随宿主安装位置变化）：
优先：Windows %LOCALAPPDATA%\SubVaultSync\
      macOS ~/Library/Application Support/SubVaultSync/
      Linux ${XDG_CONFIG_HOME:-~/.config}/SubVaultSync/
      默认库 state.json，其他库 vault-<id>.json
回退：宿主可执行文件同目录下的 data/
      仅当用户目录不可写时使用（例如受限配置或沙箱环境）
迁移：旧版本把数据放在宿主目录的 data/ 里，升级后首次启动会自动把其中的
      *.json 复制到用户目录（目标已存在则保留现有文件，不覆盖）。

为什么要固定目录：如果数据跟着宿主可执行文件走，重装、换目录或换一份宿主
二进制都会让另一端看到一个「空的远端」，然后把自己的库推上去，覆盖掉真正
的密码库。固定目录后，宿主升级/重装不会影响已有数据。

设备快速解锁（仅 Windows）：
启用后，扩展先通过 WebAuthn 平台认证器（Windows Hello）创建凭据，Windows
宿主再用当前用户的 DPAPI 保护一份仅限本机的 VaultKey 副本，保存为
<数据目录>/device.json（默认库）或 device-<id>.json，并记录 credentialId。
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
只保存在扩展的加密密码库中。首次备份会自动创建缺失的 /subvault 目录
（兼容坚果云等返回 409 AncestorsNotFound 的服务器）。每次备份成功后，除覆盖
state.json 外还会在同一目录写入一份带时间的密文副本
subvault-YYYYMMDD-HHmmss.json（If-None-Match: *，不覆盖既有副本），扩展设置页
会显示上次备份的文件名。恢复时以 WebDAV 备份为准，覆盖当前库并要求重新解锁。

WebDAV 定时自动备份与历史副本清理：
扩展可以按小时（1–168）定时触发备份，每次备份后按规则清理远端历史副本：
保留最近 N 份（0–200）与删除超过 N 天（0–3650）可同时使用；两者都为 0 时不删除
任何副本。清理由宿主通过 PROPFIND（Depth: 1）列出目录、只匹配
subvault-YYYYMMDD-HHmmss.json 的文件名，再逐条 DELETE；服务器不支持 PROPFIND
（405/501）时视为无历史副本，不影响正常备份。首次安装时可在解锁界面直接填写
WebDAV 地址与备份的主密码，从远端恢复并解锁，无需先创建空库。

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
- -RemoveData 会删除 %LOCALAPPDATA%\SubVaultSync 和宿主目录下的 data。
- 卸载宿主不会自动删除各浏览器扩展自己的本地密码库。

