param(
    [switch]$Install,
    [string]$DeploymentDirectory = (Get-Location).Path,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$taskName = 'Agent2API Windows CodeArts Web'
$proxy = Join-Path $PSScriptRoot 'windows-codearts-callback.mjs'
$deployment = (Resolve-Path -LiteralPath $DeploymentDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $deployment '.env') -PathType Leaf)) {
    throw "The Docker deployment directory must contain .env."
}
if (-not $NodePath) {
    $NodePath = (Get-Command node.exe -CommandType Application).Source
}

if ($Install) {
    $version = & $NodePath -p 'Number(process.versions.node.split(".")[0])'
    if ($LASTEXITCODE -ne 0 -or [int]$version -lt 22) {
        throw 'Node.js 22 or newer is required.'
    }
    $userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $powerShell = (Get-Command powershell.exe -CommandType Application).Source
    $arguments = '-NoProfile -WindowStyle Hidden -File "{0}" -DeploymentDirectory "{1}" -NodePath "{2}"' -f `
        $PSCommandPath, $deployment, $NodePath
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $deployment
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $userName
    $recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    if ((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State -eq 'Running') {
        Stop-ScheduledTask -TaskName $taskName
    }
    # A detached Node process can outlive the task's PowerShell launcher.
    $listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 18080 `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        $quotedProxy = '"{0}"' -f $proxy
        if ($owner.Name -ne 'node.exe' -or -not $owner.CommandLine -or -not $owner.CommandLine.Contains($quotedProxy)) {
            throw 'Port 18080 is already in use. Free that port before installing the bridge.'
        }
        Stop-Process -Id $listener.OwningProcess
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $recovery) `
        -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output 'Agent2API Windows CodeArts Web scheduled. Open http://127.0.0.1:18080/.'
    return
}

$logDirectory = Join-Path $env:LOCALAPPDATA 'Agent2API/windows-codearts-web'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$process = Start-Process -FilePath $NodePath -ArgumentList ('"{0}"' -f $proxy) `
    -WorkingDirectory $deployment -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDirectory 'stdout.log') `
    -RedirectStandardError (Join-Path $logDirectory 'stderr.log')
$process.WaitForExit()
exit $process.ExitCode
