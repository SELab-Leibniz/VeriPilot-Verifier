param(
  [Parameter(Mandatory=$true)][string]$Project,
  [Parameter(Mandatory=$true)][string]$ToolRoot,
  [Parameter(Mandatory=$true)][ValidateSet('install','test','build','java')][string]$Phase,
  [string]$JavaHome = ''
)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $Project).Path
$toolPath = (Resolve-Path -LiteralPath $ToolRoot).Path
$nodeDir = Join-Path $toolPath 'tool/node'
$env:DEVECO_SDK_HOME = Join-Path $toolPath 'sdk'
$env:DEVECO_NODE_HOME = $nodeDir
$env:NODE_HOME = $nodeDir
$env:PATH = "$nodeDir;$(Join-Path $toolPath 'bin');$env:PATH"
# PackageHap needs a JDK. Explicit choices must be valid; an unusable inherited
# JAVA_HOME falls through to the DevEco runtime, so resolution is reproducible.
$java = $null
foreach ($candidate in @(@('parameter', $JavaHome, $true), @('RC_JAVA_HOME', $env:RC_JAVA_HOME, $true), @('JAVA_HOME', $env:JAVA_HOME, $false), @('deveco', 'C:\Program Files\Huawei\DevEco Studio\jbr', $false))) {
  if (-not $candidate[1]) { continue }
  if (Test-Path -LiteralPath (Join-Path $candidate[1] 'bin\java.exe') -PathType Leaf) { $java = @{ javaHome = (Resolve-Path -LiteralPath $candidate[1]).Path; source = $candidate[0] }; break }
  if ($candidate[2]) { Write-Output ('[RC_ARKTS_JAVA] ' + (@{ javaHome = $null; source = $candidate[0]; error = 'bin\java.exe missing' } | ConvertTo-Json -Compress)); exit 3 }
}
if ($java) {
  $env:JAVA_HOME = $java.javaHome
  $env:RC_JAVA_HOME = $java.javaHome
  $env:PATH = "$(Join-Path $java.javaHome 'bin');$env:PATH"
}
Write-Output ('[RC_ARKTS_JAVA] ' + (@{ javaHome = $java.javaHome; source = $java.source } | ConvertTo-Json -Compress))
if (-not $java -and ($Phase -eq 'build' -or $Phase -eq 'java')) { exit 3 }
if ($Phase -eq 'java') {
  & cmd.exe /d /c 'java -version 2>&1'
  exit $LASTEXITCODE
}
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
