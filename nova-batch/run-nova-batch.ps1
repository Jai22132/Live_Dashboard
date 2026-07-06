# =============================================================
# Task Scheduler wrapper for the Nova batch processor.
# index.mjs writes its own detailed log to logs\nova-batch-*.log;
# this wrapper additionally captures anything the script itself
# can't log (node missing, syntax error, crash on startup) into
# logs\wrapper-*.log, and passes the exit code back to the
# scheduler so failures show up in "Last Run Result".
# =============================================================
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('wrapper-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')

$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) {
    $node = 'C:\Program Files\nodejs\node.exe'
}
if (-not $node) {
    "$(Get-Date -Format o) ERROR node.exe not found on PATH or in C:\Program Files\nodejs" |
        Out-File -FilePath $log -Append -Encoding utf8
    exit 1
}

"$(Get-Date -Format o) starting (node: $node)" | Out-File -FilePath $log -Append -Encoding utf8
& $node (Join-Path $PSScriptRoot 'index.mjs') 2>&1 |
    ForEach-Object { $_.ToString() } |
    Out-File -FilePath $log -Append -Encoding utf8
$code = $LASTEXITCODE
"$(Get-Date -Format o) finished with exit code $code" | Out-File -FilePath $log -Append -Encoding utf8
exit $code
