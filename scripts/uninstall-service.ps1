#Requires -Version 5.1
<#
.SYNOPSIS
    停止并删除由 install-service.ps1 注册的 Windows 计划任务。

.PARAMETER TaskName
    任务名,默认 'WorkBuddy Proxy'。

.PARAMETER Purge
    同时删除生成的 service.cmd / service.vbs / proxy.log(不动登录凭据).

.EXAMPLE
    pwsh -File scripts/uninstall-service.ps1
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'WorkBuddy Proxy',
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        Start-Sleep -Milliseconds 800
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✅ 已删除计划任务:$TaskName"
} else {
    Write-Host "未找到计划任务:$TaskName"
}

if ($Purge) {
    $stateDir = if ($env:WORKBUDDY_PROXY_HOME) { $env:WORKBUDDY_PROXY_HOME } else { Join-Path $HOME '.workbuddy-proxy' }
    foreach ($file in 'service.cmd', 'service.vbs', 'proxy.log') {
        $path = Join-Path $stateDir $file
        if (Test-Path $path) {
            Remove-Item -Path $path -Force
            Write-Host "   已删除 $path"
        }
    }
    Write-Host '   注意:登录凭据(session.json)保留,如需清除请运行 workbuddy-proxy logout --all'
}
