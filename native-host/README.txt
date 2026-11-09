SubVault 本机同步宿主
====================

适用：Windows 10/11，Chrome / Edge / Brave / Chromium。

安装：
1. 将本目录解压到固定位置（不要放在临时目录）。
2. 以 PowerShell 运行：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-host.ps1
3. 重新加载扩展。设置页出现“检测到本机已有 SubVault 密码库”即表示连接成功。

安装脚本会写入：
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.subvault.sync
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.subvault.sync
HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.subvault.sync
HKCU\Software\Chromium\NativeMessagingHosts\com.subvault.sync

数据位置：
优先：宿主 exe 同目录下的 data\state.json
回退：%LOCALAPPDATA%\SubVaultSync\state.json

说明：
- 宿主只保存加密后的密码库密文和同步设置，无法解密主密码。
- 不开放网络端口，只通过浏览器 Native Messaging 与本扩展固定 ID 通信。
- 本程序需要 .NET Framework 4.8；Windows 10/11 通常已自带。

卸载：
1. 注销宿主（保留同步数据）：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-host.ps1

2. 注销宿主并删除同步数据：
   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-host.ps1 -RemoveData

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

