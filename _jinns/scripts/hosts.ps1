# Writes the <name>.jinns lines Jinns needs into the Windows hosts file.
# Needs admin. Jinns and setup.ps1 start it with the Windows admin prompt.
# Only touches the block between the two marker lines, so the rest of the file is left alone.
#   hosts.ps1 -Names home,bitsim -Tld jinns
#   hosts.ps1 -Remove
param(
  [string]$Names = '',
  [string]$Tld = 'jinns',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
if ($Tld -notmatch '^[a-z0-9-]+$') { throw "Bad TLD: $Tld" }

$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$begin = '# >>> jinns (managed, do not edit)'
$end = '# <<< jinns'
# Markers from earlier names, so an old block is replaced instead of kept.
$oldBegins = @('# >>> tooyool (managed, do not edit)', '# >>> tooyool door (managed, do not edit)')
$oldEnds = @('# <<< tooyool', '# <<< tooyool door')

$kept = New-Object System.Collections.Generic.List[string]
$inside = $false
if (Test-Path $hostsPath) {
  foreach ($line in (Get-Content -Path $hostsPath)) {
    if ($line -eq $begin -or $oldBegins -contains $line) { $inside = $true; continue }
    if ($line -eq $end -or $oldEnds -contains $line) { $inside = $false; continue }
    if (-not $inside) { $kept.Add($line) }
  }
}

if (-not $Remove) {
  $kept.Add($begin)
  foreach ($name in ($Names -split ',')) {
    $n = $name.Trim()
    if ($n -match '^[a-z0-9-]+$') { $kept.Add("127.0.0.1`t$n.$Tld") }
  }
  $kept.Add($end)
}

Set-Content -Path $hostsPath -Value $kept -Encoding ASCII
ipconfig /flushdns | Out-Null
Write-Host "Updated $hostsPath"
