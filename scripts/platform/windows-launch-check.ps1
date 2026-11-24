# Launch check for a Windows TalkQTE build. Starts the given executable,
# waits for its main window titled "TalkQTE", checks the process is still
# running, then stops it and its WebView2 children. It proves the app starts
# and creates its window on this runner; it does not exercise the interface,
# audio, keys or a meeting. Nothing is captured, stored or sent.
#
#   pwsh scripts/platform/windows-launch-check.ps1 -App C:\path\TalkQTE.exe
param(
  [Parameter(Mandatory = $true)][string]$App,
  [int]$WaitSeconds = 60
)
$ErrorActionPreference = 'Stop'

$process = Start-Process -FilePath $App -PassThru
try {
  for ($i = 0; $i -lt $WaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    $process.Refresh()
    if ($process.HasExited) {
      throw "TalkQTE exited with code $($process.ExitCode) before its window appeared."
    }
    if ($process.MainWindowTitle -eq 'TalkQTE') {
      Start-Sleep -Seconds 3
      $process.Refresh()
      if ($process.HasExited) {
        throw "TalkQTE exited right after its window appeared."
      }
      $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" |
        Select-Object -ExpandProperty Name
      Write-Output "TalkQTE window found (process $($process.Id)); still running after 3 s."
      Write-Output "Child processes: $($children -join ', ')"
      exit 0
    }
  }
  throw "No TalkQTE window after $WaitSeconds s."
}
finally {
  if (-not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
  }
}
