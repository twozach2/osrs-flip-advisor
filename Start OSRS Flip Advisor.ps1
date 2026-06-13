$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if ($nodeCommand) {
    $node = $nodeCommand.Source
} else {
    $node = Join-Path $HOME ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

if (-not (Test-Path -LiteralPath $node)) {
    throw "Node.js 20 or newer is required. Install Node.js, then run this script again."
}

Set-Location -LiteralPath $projectRoot
Write-Host "Starting OSRS Flip Advisor at http://127.0.0.1:4173"
& $node "server.mjs"
