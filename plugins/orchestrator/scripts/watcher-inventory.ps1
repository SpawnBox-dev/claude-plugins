# Enumerates every orchestrator MCP watcher with the two facts that matter:
# the VERSION DIRECTORY it was launched from, and the claude.exe session that
# OWNS it. Kept as a file rather than an inline -Command string because the
# version regex contains backslashes, and every layer between JS, Git Bash and
# PowerShell rewrites those silently rather than failing.
#
# Emits: pid|startedUtcIso|version|rootClaudePid   (rootClaudePid = NONE if the
# ancestor chain dies before reaching a claude.exe - that is an ABANDONED
# watcher, the strongest orphan signal there is.)
$ws = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" |
  Where-Object { $_.CommandLine -like '*orchestrator*server.js*' }
foreach ($w in $ws) {
  $v = 'unknown'
  if ($w.CommandLine -match 'orchestrator[\\/]([0-9]+\.[0-9]+\.[0-9]+)[\\/]') { $v = $Matches[1] }
  $cur = $w
  $root = 'NONE'
  for ($i = 0; $i -lt 8; $i++) {
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $par) { break }
    if ($par.Name -eq 'claude.exe') { $root = $par.ProcessId; break }
    $cur = $par
  }
  '{0}|{1}|{2}|{3}' -f $w.ProcessId, $w.CreationDate.ToUniversalTime().ToString('o'), $v, $root
}
