# Manage the MCP gateway as a Windows scheduled task that starts at logon (hidden, no console window).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\gateway-task.ps1 <install|uninstall|start|stop|restart|status>
param(
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'mcp-gateway'
$Root = Split-Path -Parent $PSScriptRoot
$Gateway = Join-Path $Root 'gateway.js'
$HealthUrl = 'http://127.0.0.1:3800/health'

function Get-GatewayProcess {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$Gateway*" }
}

function Stop-Gateway {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-GatewayProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "Task:    $(if ($task) { $task.State } else { 'not installed' })"
  $procs = @(Get-GatewayProcess)
  Write-Host "Process: $(if ($procs.Count) { ($procs | ForEach-Object ProcessId) -join ', ' } else { 'not running' })"
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
    Write-Host "Health:  ok, $($health.instances.Count) instances, $($health.sessions) sessions, uptime $($health.uptimeSec)s"
  } catch {
    Write-Host "Health:  unreachable ($HealthUrl)"
  }
}

switch ($Action) {
  'install' {
    $node = (Get-Command node -ErrorAction Stop).Source
    # conhost --headless runs node without a visible console window and exits with it.
    $taskAction = New-ScheduledTaskAction `
      -Execute "$env:WINDIR\System32\conhost.exe" `
      -Argument "--headless `"$node`" `"$Gateway`"" `
      -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
      -Principal $principal -Description 'Shared MCP gateway (mcp-demo-server/gateway.js)' -Force | Out-Null

    Stop-Gateway
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
  }
  'uninstall' {
    Stop-Gateway
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed task $TaskName"
  }
  'start' {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
  }
  'stop' {
    Stop-Gateway
    Show-Status
  }
  'restart' {
    Stop-Gateway
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
  }
  'status' { Show-Status }
}
