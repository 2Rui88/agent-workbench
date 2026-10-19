Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class AgentWorkbenchJobApi {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

$jobs = @{}
$jobHandles = @{}

function Fail([string]$id, [string]$message) {
  @{ id = $id; ok = $false; error = $message } | ConvertTo-Json -Compress
}

function Ok([string]$id, $result) {
  @{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress
}

function New-Job([string]$id) {
  $job = [AgentWorkbenchJobApi]::CreateJobObject([IntPtr]::Zero, "AgentWorkbench-$id-$PID")
  if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
  $flags = 0x2000
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 16, $flags)
    if (-not [AgentWorkbenchJobApi]::SetInformationJobObject($job, 9, $buffer, 144)) { throw "SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  $jobHandles[$id] = $job
  return $job
}

try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    if (-not $line.Trim()) { continue }
    try {
      $request = $line | ConvertFrom-Json
      $id = [string]$request.id
      switch ([string]$request.method) {
        'assign' {
          $job = if ($jobHandles.ContainsKey([string]$request.jobId)) { $jobHandles[[string]$request.jobId] } else { New-Job ([string]$request.jobId) }
          $process = [AgentWorkbenchJobApi]::OpenProcess(0x1F0FFF, $false, [uint32]$request.pid)
          if ($process -eq [IntPtr]::Zero) { throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
          try { if (-not [AgentWorkbenchJobApi]::AssignProcessToJobObject($job, $process)) { throw "AssignProcessToJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" } }
          finally { [AgentWorkbenchJobApi]::CloseHandle($process) | Out-Null }
          Ok $id @{ jobId = [string]$request.jobId }
        }
        'terminate' {
          $jobId = [string]$request.jobId
          if ($jobHandles.ContainsKey($jobId)) { [AgentWorkbenchJobApi]::TerminateJobObject($jobHandles[$jobId], 1) | Out-Null; [AgentWorkbenchJobApi]::CloseHandle($jobHandles[$jobId]) | Out-Null; $jobHandles.Remove($jobId) }
          Ok $id @{ jobId = $jobId }
        }
        'close' {
          foreach ($handle in @($jobHandles.Values)) { [AgentWorkbenchJobApi]::CloseHandle($handle) | Out-Null }
          $jobHandles.Clear(); Ok $id @{ closed = $true }; break
        }
        default { throw "Unknown method: $($request.method)" }
      }
    } catch { Fail ([string]$request.id) $_.Exception.Message }
    [Console]::Out.Flush()
  }
} finally {
  foreach ($handle in @($jobHandles.Values)) { [AgentWorkbenchJobApi]::CloseHandle($handle) | Out-Null }
}
