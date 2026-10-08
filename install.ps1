# One-click install of the Muse relay on Windows (no VPS, permanent Cloudflare URL).
#   .\install.ps1                  from a clone (or double-click install.cmd)
#   irm https://raw.githubusercontent.com/sionex-code/muse-terminal/master/install.ps1 | iex
# Extra setup flags: .\install.ps1 --hostname muse.example.com    or    --quick
$ErrorActionPreference = 'Stop'

function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

if (-not (Have node)) {
  if (Have winget) {
    Write-Host 'Installing Node.js LTS with winget...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  }
  if (-not (Have node)) { throw 'Node 20+ is required. Install it from https://nodejs.org, open a new terminal and run this again.' }
}
if ([int](node -p "process.versions.node.split('.')[0]") -lt 20) { throw "Node 20+ is required, found $(node -v)." }

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { '' }
if (-not $dir -or -not (Test-Path (Join-Path $dir 'relay\package.json'))) {
  $dir = Join-Path $HOME 'muse-terminal'
  if (-not (Test-Path $dir)) {
    Write-Host "Downloading muse-terminal to $dir"
    $zip = Join-Path $env:TEMP 'muse-terminal.zip'
    Invoke-WebRequest 'https://github.com/sionex-code/muse-terminal/archive/refs/heads/master.zip' -OutFile $zip
    Expand-Archive $zip -DestinationPath $env:TEMP -Force
    Move-Item (Join-Path $env:TEMP 'muse-terminal-master') $dir
    Remove-Item $zip
  }
}

Set-Location (Join-Path $dir 'relay')
npm install --omit=dev --no-audit --no-fund
node scripts/tunnel.mjs setup @args
