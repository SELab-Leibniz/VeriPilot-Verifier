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
if ($Phase -eq 'build') {
  devecocli build --modules entry
} elseif ($Phase -eq 'install') {
  & (Join-Path $nodeDir 'node.exe') (Join-Path $toolPath 'ohpm/bin/pm-cli.js') install
} else {
  # devecocli has no Local Test command. Use the specified CLT native wrapper.
  & (Join-Path $toolPath 'bin/hvigorw.bat') test -p module=entry -p coverage=false --no-daemon
}
exit $LASTEXITCODE
