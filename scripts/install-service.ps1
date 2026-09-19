#Requires -Version 5.1
<#
.SYNOPSIS
    把 workbuddy-proxy 注册为 Windows 计划任务:登录时自动启动,隐藏窗口后台常驻。

.DESCRIPTION
    生成的产物(都在 WORKBUDDY_PROXY_HOME,默认 ~/.workbuddy-proxy):
        service.cmd   实际启动命令(带日志重定向)
        service.vbs   以隐藏窗口方式拉起 service.cmd
        proxy.log     stdout / stderr 日志

    计划任务本身:
        名称      WorkBuddy Proxy(可用 -TaskName 改)
        触发器    当前用户登录时
        动作      wscript.exe <service.vbs>
        设置      允用电池、不限执行时长、失败后重启 3 次(每分钟)
        运行身份  当前用户(交互式,无需管理员)

.PARAMETER Port
    监听端口,默认 8788。

.PARAMETER BindHost
    绑定地址,默认 127.0.0.1(仅本机)。对外暴露时请同时设置 -LocalToken。

.PARAMETER LocalToken
    可选。设置后客户端必须带 Authorization: Bearer <token>。

.PARAMETER HeartbeatSeconds
    可选。SSE 心跳间隔秒数,默认 0(关闭)。

.PARAMETER DetectTruncation
    可选。开启断流检测(默认关闭)。

.PARAMETER StartNow
    注册完立刻启动任务。

.PARAMETER NodePath
    可选。显式指定 node.exe 路径(用于 mise/nvm 等 PATH 里没有 node 的场景)。

.EXAMPLE
    pwsh -File scripts/install-service.ps1 -StartNow

.EXAMPLE
    pwsh -File scripts/install-service.ps1 -Port 9000 -HeartbeatSeconds 15 -DetectTruncation -StartNow
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'WorkBuddy Proxy',
    [int]$Port = 8788,
    [string]$BindHost = '127.0.0.1',
    [string]$LocalToken = '',
    [string]$LocalTokenFile = '',
    [switch]$GenerateApiKey,
    [int]$HeartbeatSeconds = 0,
    [switch]$DetectTruncation,
    [switch]$StartNow,
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-NodePath {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "指定的 node 不存在:$Explicit" }
        return (Resolve-Path $Explicit).Path
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    throw 'PATH 里找不到 node.exe。请安装 Node.js >= 22,或用 -NodePath 指定完整路径。'
}

# ── 定位项目与 node ────────────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$entry = Join-Path $projectRoot 'bin\workbuddy-proxy.js'
if (-not (Test-Path $entry)) {
    throw "找不到入口文件:$entry(请从仓库里的 scripts/ 目录运行本脚本)"
}

$node = Resolve-NodePath -Explicit $NodePath

$stateDir = if ($env:WORKBUDDY_PROXY_HOME) { $env:WORKBUDDY_PROXY_HOME } else { Join-Path $HOME '.workbuddy-proxy' }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$logFile = Join-Path $stateDir 'proxy.log'
$cmdFile = Join-Path $stateDir 'service.cmd'
$vbsFile = Join-Path $stateDir 'service.vbs'

# ── 组装 serve 参数 ───────────────────────────────────────────────
# API Key 三选一,优先级:显式 -LocalToken > -GenerateApiKey(自动生成并落盘) > -LocalTokenFile。
# 用文件而不是命令行参数,Key 就不会出现在任务定义和进程命令行里。
if ($GenerateApiKey) {
    $LocalTokenFile = Join-Path $stateDir 'api-key.txt'
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $newKey = 'sk-wb-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    Set-Content -Path $LocalTokenFile -Value $newKey -Encoding ascii -NoNewline
    # 只有当前用户可读
    & icacls.exe "$LocalTokenFile" /inheritance:r /grant:r "$($env:USERNAME):(R)" 2>&1 | Out-Null
    Write-Host "🔑 已生成 API Key:$newKey"
    Write-Host "   保存在 $LocalTokenFile(仅当前用户可读)"
}

$serveArgs = @('serve', '--port', "$Port", '--host', $BindHost)
if ($LocalToken) { $serveArgs += @('--token', $LocalToken) }
elseif ($LocalTokenFile) { $serveArgs += @('--token-file', $LocalTokenFile) }
if ($HeartbeatSeconds -gt 0) { $serveArgs += @('--heartbeat', "$HeartbeatSeconds") }
if ($DetectTruncation) { $serveArgs += '--detect-truncation' }

# ── 生成 service.cmd(带日志重定向)──────────────────────────────
$cmdBody = @"
@echo off
rem 由 scripts/install-service.ps1 生成。改参数请重新运行该脚本,不要手改这里。
"$node" "$entry" $($serveArgs -join ' ') >> "$logFile" 2>&1
"@
Set-Content -Path $cmdFile -Value $cmdBody -Encoding OEM

# ── 生成 service.vbs(隐藏窗口)─────────────────────────────────
$vbsBody = @'
' 由 scripts/install-service.ps1 生成 —— 以隐藏窗口方式启动 workbuddy-proxy。
' 计划任务直接跑 .cmd 会在桌面留一个控制台窗口,Run(..., 0, ...) 可以隐藏它。
' 最后一个参数用 True(等待子进程结束):这样服务进程退出时任务才算结束,
' 计划任务里的"失败后重启"才会真正生效。
' 用 Chr(34) 拼引号:VBScript 的 "" 转义在拼接路径时非常容易写错。
Dim shell, q
q = Chr(34)
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c " & q & WScript.Arguments(0) & q, 0, True
'@
Set-Content -Path $vbsFile -Value $vbsBody -Encoding OEM

# ── 注册计划任务 ─────────────────────────────────────────────────
# 先停掉已有任务与仍占着端口的实例 —— 否则新实例会因端口被占而静默启动失败
# (计划任务里会记成 2147946720 / 0x800700E0)。
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 600
    }
    Write-Host "已停止旧任务:$TaskName"
}

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    foreach ($conn in $busy) {
        Write-Warning "端口 $Port 被 PID $($conn.OwningProcess) 占用,正在结束该进程"
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 900
}

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" `
    -Argument "`"$vbsFile`" `"$cmdFile`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
}

Write-Host "✅ 计划任务已注册:$TaskName"
Write-Host "   入口       $entry"
Write-Host "   node       $node"
Write-Host "   服务命令   node bin/workbuddy-proxy.js $($serveArgs -join ' ')"
Write-Host "   日志       $logFile"
Write-Host "   触发器     用户 $env:USERNAME 登录时"
if ($StartNow) { Write-Host '   状态       已尝试启动' }
Write-Host ''
Write-Host '   查看状态:  Get-ScheduledTask -TaskName ''WorkBuddy Proxy'' | Get-ScheduledTaskInfo'
Write-Host '   启动/停止: Start-ScheduledTask -TaskName ''WorkBuddy Proxy'' / Stop-ScheduledTask ...'
Write-Host '   卸载:      pwsh -File scripts/uninstall-service.ps1'
