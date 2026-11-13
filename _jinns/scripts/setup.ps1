# Jinns setup for Windows. Start it with setup.cmd in the Jinns folder.
# Checks and installs what Jinns needs, then turns on <app>.jinns addresses.
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Tld = 'jinns'

function Step($m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Ask($q) { $a = Read-Host "  $q [Y/n]"; return ($a -eq '' -or $a -match '^[Yy]') }
function Has($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:USERPROFILE\.local\bin"
}
function Winget-Install($id) {
  if (-not (Has winget)) { Warn "winget is not available. Install $id yourself, then run setup again."; return }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
# Must match slug() in _jinns/platform.mjs.
function Slug($name) {
  $s = ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  if ($s -eq '') { return 'app' } else { return $s }
}

Write-Host ''
Write-Host 'Jinns setup' -ForegroundColor White
Write-Host "Folder: $Root"

Step '1. Node.js (runs Jinns)'
$nodeOk = $false
if (Has node) {
  node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
  $nodeOk = ($LASTEXITCODE -eq 0)
}
if (-not $nodeOk) {
  Warn 'Node.js 20 or newer is needed.'
  if (Ask 'Install Node.js LTS now?') { Winget-Install 'OpenJS.NodeJS.LTS' }
  if (-not (Has node)) { Warn 'Node.js is still missing. Get it from https://nodejs.org and run setup again.'; exit 1 }
}
Ok "Node.js $(node -v)"

Step '2. Git for Windows (lets Claude use Bash; optional)'
if (Has git) { Ok (git --version) }
elseif (Ask 'Install Git for Windows now? (recommended)') { Winget-Install 'Git.Git' }
else { Warn 'Skipped. Claude will use PowerShell instead of Bash.' }

Step '3. Claude Code'
if (-not (Has claude)) {
  if (Ask 'Install Claude Code now?') {
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Refresh-Path
  }
}
if (Has claude) {
  Ok "Claude Code $(claude --version)"
  Write-Host '      If you have never signed in, open a terminal, run "claude" once and follow the browser sign-in.'
} else { Warn 'Claude Code is missing. The Claude tab in Jinns will not work until it is installed.' }

Step '4. Google Chrome (the browser Claude drives through Playwright)'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($chrome) { Ok 'Chrome found' }
elseif (Ask 'Install Google Chrome now?') { Winget-Install 'Google.Chrome' }
else { Warn 'Without Chrome, Claude cannot open your apps in a browser.' }

Step '5. Playwright for Claude'
npx -y '@playwright/mcp@latest' --version | Out-Null
if ($LASTEXITCODE -eq 0) { Ok 'Playwright MCP downloaded' } else { Warn 'Could not download @playwright/mcp. Jinns will try again on first use.' }

Step "6. .$Tld addresses"
$busy = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'node' }
if ($busy) {
  $owner = (Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
  Warn "Port 80 is used by '$owner', so .$Tld addresses cannot work. Apps still open at <app>.localhost:4747."
} else {
  $names = @('home') + (Get-ChildItem -Path $Root -Directory |
    Where-Object { $_.Name -notmatch '^[._]' -and $_.Name -ne 'node_modules' } |
    ForEach-Object { Slug $_.Name })
  $list = ($names | Select-Object -Unique) -join ','
  Write-Host "  Windows will ask for admin once, to add these to the hosts file:"
  Write-Host "  $(($list -split ',' | ForEach-Object { "$_.$Tld" }) -join ', ')"
  $script = Join-Path $PSScriptRoot 'hosts.ps1'
  try {
    Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"", '-Names', $list, '-Tld', $Tld)
    Ok "home.$Tld and your apps are ready"
  } catch { Warn 'Admin was declined. Jinns shows a button to try again.' }
}

Step 'Done'
Write-Host "  Start Jinns any time with jinns.cmd. Add an app by putting its folder in $Root."
if (Ask 'Open Jinns now?') { Start-Process -FilePath (Join-Path $Root 'jinns.cmd') -WorkingDirectory $Root }
