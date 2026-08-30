# Reads one environment variable from a same-user process (PEB).
# Prints only the value. Used by the Devin language-server CSRF lookup.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Name
)

if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { exit 2 }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CamProcEnv {
  const uint Q = 0x0400, R = 0x0010;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool b, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr a, Peb, b, c, d, e; }
  static IntPtr ReadPtr(IntPtr h, IntPtr addr) {
    var buf = new byte[8]; IntPtr n;
    ReadProcessMemory(h, addr, buf, (IntPtr)8, out n);
    return (IntPtr)BitConverter.ToInt64(buf, 0);
  }
  public static string Get(int pid, string name) {
    var h = OpenProcess(Q|R, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new PBI(); int ret;
      NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret);
      IntPtr env = ReadPtr(h, ReadPtr(h, pbi.Peb + 0x20) + 0x80);
      var raw = new byte[65536]; IntPtr nread;
      ReadProcessMemory(h, env, raw, (IntPtr)raw.Length, out nread);
      foreach (var part in Encoding.Unicode.GetString(raw, 0, (int)nread).Split('\0')) {
        int eq = part.IndexOf('=');
        if (eq > 0 && part.Substring(0, eq).Equals(name, StringComparison.OrdinalIgnoreCase))
          return part.Substring(eq + 1);
      }
      return null;
    } finally { CloseHandle(h); }
  }
}
"@

$v = [CamProcEnv]::Get($ProcessId, $Name)
if ($null -ne $v) { [Console]::Out.Write($v) }
