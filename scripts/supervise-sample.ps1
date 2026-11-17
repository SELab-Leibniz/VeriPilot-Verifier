param([Parameter(Mandatory=$true)][string]$RunDir)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath($RunDir)
function Write-SampleJson([string]$Name, $Value) {
  $target = Join-Path $taskRoot "rc-status/$Name"
  $temporary = "$target.$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $target -Force
}
$sampleJob = $null
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-sample-job.cs')
  $scope = Get-Content -LiteralPath (Join-Path $taskRoot 'runtime/process-scope.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($scope.runDir -ne $taskRoot -or -not $scope.jobName.StartsWith('Local\RCExperiment-')) { throw 'Invalid sample scope identity' }
  $readyFile = Join-Path $taskRoot 'rc-status/process-scope-ready.json'
  $recovering = Test-Path -LiteralPath $readyFile
  $sampleJob = [RcSampleJob]::new($scope.jobName, [int]$scope.root.pid, [string]$scope.root.startedAt, $recovering)
  Write-SampleJson 'process-scope-ready.json' @{status='READY';guardianPid=$PID;jobName=$scope.jobName;root=$scope.root;deadlineAt=$scope.deadlineAt;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
  for (;;) {
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-SampleJson 'process-scope-heartbeat.json' @{guardianPid=$PID;jobName=$scope.jobName;at=$nowMs}
    $reason = $null
    if ($nowMs -ge [long]$scope.deadlineAt) { $reason = 'EXPERIMENT_DEADLINE_EXPIRED' }
    else {
      $normalFile = Join-Path $taskRoot 'rc-status/normal-stop-request.json'
      if (Test-Path -LiteralPath $normalFile) {
        $normal = Get-Content -LiteralPath $normalFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($normal.jobName -eq $scope.jobName -and -not [RcSampleJob]::OriginalAlive([int]$scope.root.pid,[string]$scope.root.startedAt)) { $reason = 'NORMAL_CLEANUP' }
      }
    }
    if ($reason) {
      $before = $sampleJob.Query()
      $sampleJob.Terminate()
      $drainDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 30000
      do {
        $after = $sampleJob.Query()
        if ($after.ActiveProcesses -eq 0) { break }
        Start-Sleep -Milliseconds 50
      } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $drainDeadline)
      Write-SampleJson 'sample-stop-receipt.json' @{reason=$reason;jobName=$scope.jobName;root=$scope.root;deadlineAt=$scope.deadlineAt;
        requestedAt=$nowMs;confirmedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();activeProcesses=$after.ActiveProcesses;
        totalProcesses=$after.TotalProcesses;processesBeforeStop=$before.ActiveProcesses;guardianPid=$PID}
      if ($after.ActiveProcesses -ne 0) { throw 'Sample Job did not drain; cleanup is not confirmed' }
      break
    }
    Start-Sleep -Milliseconds ([Math]::Max(1,[Math]::Min(500,[long]$scope.deadlineAt-$nowMs)))
  }
} catch {
  Write-SampleJson 'process-scope-error.json' @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();guardianPid=$PID;message=$_.Exception.Message}
  exit 2
} finally {
  if ($sampleJob) { $sampleJob.Dispose() }
}
