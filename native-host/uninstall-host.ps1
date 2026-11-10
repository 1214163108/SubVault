$ErrorActionPreference = 'Stop'
$RemoveData = $args -contains '-RemoveData'
$keys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.subvault.sync'
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.subvault.sync'
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.subvault.sync'
    'HKCU:\Software\Chromium\NativeMessagingHosts\com.subvault.sync'
)

foreach ($key in $keys) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force
        Write-Output "removed registry: $key"
    } else {
        Write-Output "not present: $key"
    }
}

if ($RemoveData) {
    $dirs = @(
        (Join-Path $PSScriptRoot 'data')
        (Join-Path $env:LOCALAPPDATA 'SubVaultSync')
    )
    foreach ($dir in $dirs) {
        if (Test-Path $dir) {
            $resolved = (Resolve-Path $dir).Path
            Remove-Item -LiteralPath $resolved -Recurse -Force
            Write-Output "removed data: $resolved"
        }
    }
}

if (-not $RemoveData) {
    Write-Output 'sync data kept; rerun with -RemoveData to delete it.'
}

Write-Output 'Native Messaging host unregistered.'
Write-Output 'To delete the host folder, run this outside the folder:'
Write-Output '  Remove-Item -LiteralPath "<host folder>" -Recurse -Force'
Write-Output 'Remove the browser extension from chrome://extensions.'
