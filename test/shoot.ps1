# Screenshot watcher for the integration smoke test.
# Waits for "<n>-<name>.ready" marker files in $ShotDir, captures the VS Code test window
# (PrintWindow, which works even while the workstation is locked) to "<n>-<name>.png",
# then writes "<n>-<name>.done" so the test can continue. Falls back to a full-screen grab.
param(
  [Parameter(Mandatory)] [string] $ShotDir,
  [string] $ExeDirHint = 'vsc-test',   # substring of the test VS Code executable path
  [int] $TimeoutSec = 300
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public class Info { public IntPtr H; public uint Pid; public string Title; public int W; public int Hh; }
  public static List<Info> Windows() {
    var list = new List<Info>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      list.Add(new Info { H = h, Pid = pid, Title = sb.ToString(), W = r.R - r.L, Hh = r.B - r.T });
      return true; }, IntPtr.Zero);
    return list;
  }
}
"@
New-Item -ItemType Directory -Force -Path $ShotDir | Out-Null

function Find-TestWindow {
  $procs = @{}
  foreach ($p in Get-Process -Name Code -ErrorAction SilentlyContinue) { try { if ($p.Path -like "*$ExeDirHint*") { $procs[[uint32]$p.Id] = $true } } catch {} }
  $cands = [Win]::Windows() | Where-Object { $_.Title -match 'Visual Studio Code' -and $_.W -gt 400 -and $_.Hh -gt 300 }
  $mine = $cands | Where-Object { $procs.ContainsKey($_.Pid) }
  if ($mine) { return ($mine | Sort-Object { $_.W * $_.Hh } -Descending | Select-Object -First 1) }
  return ($cands | Sort-Object { $_.W * $_.Hh } -Descending | Select-Object -First 1)
}

function Capture-Window($info, $path) {
  $bmp = New-Object System.Drawing.Bitmap $info.W, $info.Hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [Win]::PrintWindow($info.H, $hdc, 2)   # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return $ok
}

function Capture-Screen($path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$seen = @{}
Write-Output "watching $ShotDir"
while ((Get-Date) -lt $deadline) {
  if (Test-Path (Join-Path $ShotDir 'STOP')) { break }
  foreach ($f in Get-ChildItem -Path $ShotDir -Filter '*.ready' -ErrorAction SilentlyContinue) {
    if ($seen.ContainsKey($f.Name)) { continue }
    $seen[$f.Name] = $true
    Start-Sleep -Milliseconds 500
    $base = $f.FullName.Substring(0, $f.FullName.Length - 6)
    try {
      $w = Find-TestWindow
      if ($w) { $ok = Capture-Window $w "$base.png"; Write-Output "captured window '$($w.Title)' $($w.W)x$($w.Hh) pid $($w.Pid) ok=$ok -> $base.png" }
      else { Capture-Screen "$base.png"; Write-Output "no VS Code window found; captured screen -> $base.png" }
    } catch { Write-Output "capture failed: $_" }
    Set-Content -Path "$base.done" -Value 'ok'
  }
  Start-Sleep -Milliseconds 250
}
Write-Output 'shoot.ps1 finished'
