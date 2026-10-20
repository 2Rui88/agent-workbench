[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'dist\windows'),
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
if (-not ($IsWindows -or [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)) { throw 'Windows package generation must run on Windows.' }
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stage = Join-Path $env:TEMP "agent-workbench-package-$([guid]::NewGuid().ToString('N'))"
$packageRoot = Join-Path $stage 'agent-workbench'
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

$nodeDir = Join-Path $env:LOCALAPPDATA 'AgentWorkbench\runtime\node-v24.22.0-win-x64'
if (-not $SkipBuild) {
    $env:PATH = "$nodeDir;$env:PATH"
    & (Join-Path $nodeDir 'npm.cmd') run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}

$exclude = @('.git', 'node_modules', '.tmp-cli', 'dist\windows')
Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object {
    $exclude -notcontains $_.Name
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $packageRoot $_.Name) -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$archive = Join-Path $OutputDirectory 'agent-workbench-windows.zip'
if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -LiteralPath (Join-Path $stage 'agent-workbench') -DestinationPath $archive -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host "Package created: $archive"
