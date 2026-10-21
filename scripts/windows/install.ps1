[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AgentWorkbench'),
    [string]$NodeVersion = '24.22.0',
    [string]$WindowsTerminalVersion = '1.25.2733.0',
    [switch]$SkipNodeDownload,
    [switch]$SkipWindowsTerminalDownload,
    [switch]$SkipNpmInstall,
    [switch]$SkipBuild,
    [switch]$SkipEnvironmentRegistration
)

$ErrorActionPreference = 'Stop'
if (-not ($IsWindows -or [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)) {
    throw 'Agent Workbench Windows installer must run on Windows.'
}

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeRoot = Join-Path $InstallRoot 'runtime'
$toolsRoot = Join-Path $InstallRoot 'tools'
$nodeDir = Join-Path $runtimeRoot "node-v$NodeVersion-win-x64"
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCmd = Join-Path $nodeDir 'npm.cmd'
$terminalDir = Join-Path $toolsRoot "WindowsTerminal-$WindowsTerminalVersion"
$terminalExe = Join-Path (Join-Path $terminalDir "terminal-$WindowsTerminalVersion") 'wt.exe'

New-Item -ItemType Directory -Force -Path $runtimeRoot, $toolsRoot | Out-Null

function Get-Download([string]$Url, [string]$Destination) {
    Write-Host "Downloading $Url"
    & curl.exe -L --fail --retry 3 --output $Destination $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed: $Url"
    }
}

if (-not $SkipNodeDownload -and -not (Test-Path $nodeExe)) {
    $archive = Join-Path $env:TEMP "agent-workbench-node-v$NodeVersion.zip"
    Get-Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
    Remove-Item -LiteralPath $archive -Force
}
if (-not (Test-Path $nodeExe)) {
    throw "Portable Node.js was not found at $nodeExe. Re-run without -SkipNodeDownload."
}

if (-not $SkipWindowsTerminalDownload -and -not (Test-Path $terminalExe)) {
    $archive = Join-Path $env:TEMP "agent-workbench-wt-$WindowsTerminalVersion.zip"
    Get-Download "https://github.com/microsoft/terminal/releases/download/v$WindowsTerminalVersion/Microsoft.WindowsTerminal_$($WindowsTerminalVersion)_x64.zip" $archive
    if (Test-Path $terminalDir) { Remove-Item -LiteralPath $terminalDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $terminalDir | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $terminalDir -Force
    Remove-Item -LiteralPath $archive -Force
}
if (-not (Test-Path $terminalExe)) {
    throw "Windows Terminal portable runtime was not found at $terminalExe. Re-run without -SkipWindowsTerminalDownload."
}

$env:PATH = "$nodeDir;$env:PATH"
if (-not $SkipNpmInstall) {
    Push-Location $sourceRoot
    try {
        $npmInstallCommand = if (Test-Path (Join-Path $sourceRoot 'package-lock.json')) { 'ci' } else { 'install' }
        Write-Host "Installing npm dependencies with npm $npmInstallCommand"
        & $npmCmd $npmInstallCommand
        if ($LASTEXITCODE -ne 0) { throw "npm $npmInstallCommand failed." }
    } finally { Pop-Location }
}
if (-not $SkipBuild) {
    Push-Location $sourceRoot
    try {
        & $npmCmd run build
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
    } finally { Pop-Location }
}

if (-not $SkipEnvironmentRegistration) {
    [Environment]::SetEnvironmentVariable('AGENT_WORKBENCH_NODE', $nodeDir, 'User')
    [Environment]::SetEnvironmentVariable('AGENT_WORKBENCH_WINDOWS_TERMINAL', $terminalExe, 'User')
}

$launcher = Join-Path $InstallRoot 'agent-workbench.ps1'
@"
`$ErrorActionPreference = 'Stop'
`$nodeDir = '$($nodeDir.Replace("'", "''"))'
`$sourceRoot = '$($sourceRoot.Replace("'", "''"))'
`$env:PATH = "`$nodeDir;`$env:PATH"
& (Join-Path `$nodeDir 'node.exe') (Join-Path `$sourceRoot 'apps\cli\dist\main.js') @args
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $launcher -Encoding utf8

Write-Host ''
Write-Host 'Agent Workbench installation completed.'
Write-Host "Launcher: $launcher"
Write-Host "Initialize: powershell -ExecutionPolicy Bypass -File `"$launcher`" init"
Write-Host "Start:      powershell -ExecutionPolicy Bypass -File `"$launcher`" start"
Write-Host "Status:   powershell -ExecutionPolicy Bypass -File `"$launcher`" status"
Write-Host 'No model execution was performed by this installer.'
