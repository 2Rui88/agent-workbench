[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments = @('start')
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodeDir = if ($env:AGENT_WORKBENCH_NODE) { $env:AGENT_WORKBENCH_NODE } else { Join-Path $env:LOCALAPPDATA 'AgentWorkbench\runtime\node-v24.22.0-win-x64' }
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path $nodeExe)) { throw "Portable Node.js not found at $nodeExe. Run scripts\windows\install.ps1 first." }
$env:PATH = "$nodeDir;$env:PATH"
& $nodeExe (Join-Path $sourceRoot 'apps\cli\dist\main.js') @Arguments
exit $LASTEXITCODE
