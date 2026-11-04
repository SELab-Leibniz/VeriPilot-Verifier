param(
  [Parameter(Mandatory=$true)][string]$Project,
  [Parameter(Mandatory=$true)][string]$ToolRoot,
  [Parameter(Mandatory=$true)][ValidateSet('install','test','build')][string]$Phase
)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $Project).Path
$toolPath = (Resolve-Path -LiteralPath $ToolRoot).Path
$nodeDir = Join-Path $toolPath 'tool/node'
$env:DEVECO_SDK_HOME = Join-Path $toolPath 'sdk'
$env:DEVECO_NODE_HOME = $nodeDir
$env:NODE_HOME = $nodeDir
$env:PATH = "$nodeDir;$(Join-Path $toolPath 'bin');$env:PATH"
Set-Location -LiteralPath $projectPath
$mutex = [Threading.Mutex]::new($false, 'Global\RuntimeCorrector.ArkTS.Hvigor')
$wait = [Diagnostics.Stopwatch]::StartNew()
$held = $false
try {
  try { $held = $mutex.WaitOne() }
  catch [Threading.AbandonedMutexException] { $held = $true }
  $wait.Stop()
  Write-Output ('[RC_ARKTS_LOCK] ' + (@{ phase = $Phase; waitMs = $wait.ElapsedMilliseconds; acquiredAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
  if ($Phase -eq 'build') {
    & (Join-Path $toolPath 'bin/hvigorw.bat') --mode module -p module=entry@default -p product=default -p buildMode=debug assembleHap --no-daemon
  } elseif ($Phase -eq 'install') {
    & (Join-Path $nodeDir 'node.exe') (Join-Path $toolPath 'ohpm/bin/pm-cli.js') install
  } else {
    & (Join-Path $toolPath 'bin/hvigorw.bat') test -p module=entry -p coverage=false --no-daemon
  }
  $code = $LASTEXITCODE
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $code
