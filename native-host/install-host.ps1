$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$hostPath = Join-Path $root 'SubVaultSync.exe'
$manifestPath = Join-Path $root 'com.subvault.sync.json'
$extensionId = (Get-Content (Join-Path $root 'extension-id.txt') -Raw).Trim()

$manifest = [ordered]@{
  name = 'com.subvault.sync'
  description = 'SubVault local encrypted vault sync host'
  path = $hostPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$keys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.subvault.sync',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.subvault.sync',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.subvault.sync',
  'HKCU:\Software\Chromium\NativeMessagingHosts\com.subvault.sync'
)
foreach ($key in $keys) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}
Write-Output "host: $hostPath"
Write-Output "extension: $extensionId"
Write-Output "manifest: $manifestPath"
