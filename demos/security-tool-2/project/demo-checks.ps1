param([Parameter(Mandatory=$true)][ValidateSet('doctor','install','test','build','docs')][string]$Phase)
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
Set-Location -LiteralPath $PSScriptRoot
function Require-File([string]$Value, [string]$Label) {
  if (-not $Value -or -not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw "Missing $Label; configure machine.yaml: $Value" }
  return (Resolve-Path -LiteralPath $Value).Path
}
if (-not $env:HVIGOR_HOME -or -not $env:OHPM_HOME -or -not $env:JAVA_HOME -or -not $env:DEVECO_SDK_HOME) {
  throw 'Configure harmony.hvigor, harmony.ohpm, harmony.java and harmony.sdk in machine.yaml first.'
}
if (-not $env:DEVECOSTUDIO_HOME -and $env:DEVECO_HOME) { $env:DEVECOSTUDIO_HOME = $env:DEVECO_HOME }
$hvigor = Require-File (Join-Path $env:HVIGOR_HOME 'bin/hvigorw.js') 'Hvigor'
$ohpm = Require-File (Join-Path $env:OHPM_HOME 'bin/pm-cli.js') 'OHPM'
$java = Require-File (Join-Path $env:JAVA_HOME 'bin/java.exe') 'Java'
if (-not $env:DEVECO_NODE_HOME) {
  foreach ($candidate in @((Join-Path (Split-Path -Parent $env:HVIGOR_HOME) 'tool/node'), (Join-Path (Split-Path -Parent $env:HVIGOR_HOME) 'node'))) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'node.exe') -PathType Leaf) { $env:DEVECO_NODE_HOME = $candidate; break }
  }
}
$node = Require-File $(if ($env:DEVECO_NODE_HOME) { Join-Path $env:DEVECO_NODE_HOME 'node.exe' } else { '' }) 'Harmony tool Node (env.DEVECO_NODE_HOME)'
$env:NODE_HOME = $env:DEVECO_NODE_HOME
$env:PATH = "$($env:DEVECO_NODE_HOME);$(Join-Path $env:JAVA_HOME 'bin');$env:PATH"
if ($Phase -eq 'doctor') {
  @{ hvigor=$hvigor; ohpm=$ohpm; java=$java; toolNode=$node; sdk=$env:DEVECO_SDK_HOME; note='Paths only. Run install/test/build/docs to validate execution.' } | ConvertTo-Json
  exit 0
}
$executable = $node
switch ($Phase) {
  'install' { $arguments = @($ohpm, 'install') }
  'test' { $arguments = @($hvigor, 'test', '--mode', 'module', '-p', 'product=default', '-p', 'module=entry@default', '-p', 'coverage=false', '--no-daemon') }
  'build' { $arguments = @($hvigor, '--mode', 'module', '-p', 'module=entry@default', '-p', 'product=default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon') }
  'docs' {
    $executable = if ($env:PYTHON) { Require-File $env:PYTHON 'Python' } else { (Get-Command python -ErrorAction Stop).Source }
    $arguments = @('scripts/check_docs_consistency.py')
  }
}
$output = Join-Path $PSScriptRoot 'demo-output'
[void][IO.Directory]::CreateDirectory($output)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$log = Join-Path $output "$Phase.log"
$writer = New-Object System.IO.StreamWriter($log, $false, $utf8)
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$savedPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  & $executable @arguments 2>&1 | ForEach-Object { $line = "$_"; $writer.WriteLine($line); [Console]::WriteLine($line) }
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 1 }
} finally { $writer.Dispose(); $ErrorActionPreference = $savedPreference }
$receipt = @{ phase=$Phase; startedAt=$startedAt; finishedAt=[DateTimeOffset]::UtcNow.ToString('o'); exitCode=$code; log="demo-output/$Phase.log" }
if ($Phase -eq 'test') {
  $report = Join-Path $PSScriptRoot 'entry/.test/default/intermediates/test/coverage_data/coverage.log'
  $fresh = (Test-Path -LiteralPath $report -PathType Leaf) -and ((Get-Item -LiteralPath $report).LastWriteTimeUtc -ge ([DateTimeOffset]::Parse($startedAt).UtcDateTime.AddSeconds(-2)))
  $raw = if ($fresh) { [IO.File]::ReadAllText($report, $utf8) } else { '' }
  $matches = [regex]::Matches($raw, '\[Hypium\]total cases:(\d+);failure (\d+),error (\d+),pass (\d+)')
  $summary = if ($matches.Count) { $matches[$matches.Count - 1] } else { $null }
  $tests = @{ freshReport=[bool]$fresh; finished=$raw.Contains('[Hypium][end] run suites end'); reportedTotal=0; reportedPassed=0; reportedFailures=0; reportedErrors=0 }
  if ($summary) {
    $tests.reportedTotal = [int]$summary.Groups[1].Value; $tests.reportedFailures = [int]$summary.Groups[2].Value
    $tests.reportedErrors = [int]$summary.Groups[3].Value; $tests.reportedPassed = [int]$summary.Groups[4].Value
  }
  if ($fresh) { [IO.File]::WriteAllText((Join-Path $output 'test.coverage.log'), $raw, $utf8) }
  if ($code -eq 0 -and (-not $fresh -or -not $tests.finished -or $tests.reportedTotal -le 0 -or $tests.reportedFailures -gt 0 -or $tests.reportedErrors -gt 0 -or $tests.reportedPassed -ne $tests.reportedTotal)) { $code = 1 }
  $receipt.localTests = $tests; $receipt.exitCode = $code
  Write-Output ('DEMO_PUBLIC_TESTS=' + ($tests | ConvertTo-Json -Compress))
}
$line = ($receipt | ConvertTo-Json -Compress)
[IO.File]::AppendAllText((Join-Path $output 'checks.jsonl'), $line + "`n", $utf8)
[IO.File]::WriteAllText((Join-Path $output "$Phase.json"), ($receipt | ConvertTo-Json) + "`n", $utf8)
Write-Output "DEMO_CHECK_EXIT_CODE=$code"
exit $code
