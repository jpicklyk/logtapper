# Builds scripts/fake-adb/adb.exe — a native launcher for fake-adb.mjs.
#
# Why: the backend spawns `Command::new("adb")`, and Windows' CreateProcess only
# resolves `adb.exe`, never `adb.cmd`. Without a real .exe first on PATH the app
# silently reaches the real platform-tools adb (or nothing). Requires Windows
# PowerShell 5.1 (.NET Framework csc) — run this from pwsh or cmd; it re-invokes
# powershell.exe itself. Output is gitignored.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = @'
using System;
using System.Diagnostics;
using System.IO;
class Launcher {
  static int Main(string[] args) {
    string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    string script = Path.Combine(here, "fake-adb.mjs");
    var sb = new System.Text.StringBuilder();
    sb.Append('"').Append(script).Append('"');
    foreach (var a in args) sb.Append(" \"").Append(a.Replace("\"", "\\\"")).Append('"');
    var psi = new ProcessStartInfo("node", sb.ToString());
    psi.UseShellExecute = false;               // inherit stdout/stderr pipes from the caller
    using (var p = Process.Start(psi)) {
      Console.CancelKeyPress += (s, e) => { try { p.Kill(); } catch {} };
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}
'@
$out = Join-Path $dir "adb.exe"
$tmp = Join-Path $env:TEMP "fake-adb-launcher.cs"
Set-Content -Path $tmp -Value $src -Encoding UTF8
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Add-Type -Path '$tmp' -OutputAssembly '$out' -OutputType ConsoleApplication"
if (Test-Path $out) { Write-Host "built $out" } else { Write-Error "build failed" }
