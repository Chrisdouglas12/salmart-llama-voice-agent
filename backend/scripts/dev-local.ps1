# scripts/dev-local.ps1
#
# Run the Salmart backend for LAN testing from a phone.
#
#   npm run dev:local
#   npm run dev:local -- -Port 4000
#
# What it does that `node app.js` does not:
#   * forces NODE_ENV=development (the checked-in .env says production, which
#     would turn on secure-only session cookies and the Render OAuth callback,
#     both wrong over plain http on a LAN);
#   * publishes APP_BASE_URL/BASE_URL as this PC's LAN origin so the Google
#     hand-off URL the AI builds points at this machine, not Render;
#   * adds a private-profile firewall rule for the port (needs an elevated
#     shell once; without it Windows blocks the phone silently);
#   * prints the exact origins to use for Metro and on the phone.
#
# The server already binds every interface (server.listen(PORT) with no host).

param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-LanAddress {
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.IPAddress -notlike '172.1[7-9].*' -and
      $_.IPAddress -notlike '172.2[0-9].*' -and
      $_.IPAddress -notlike '172.3[0-1].*' -and
      $_.IPAddress -notlike '192.168.56.*'
    } |
    Sort-Object -Property @{ Expression = { if ($_.InterfaceAlias -match 'Wi-?Fi|WLAN') { 0 } else { 1 } } }, InterfaceIndex
  if ($candidates) { return ($candidates | Select-Object -First 1).IPAddress }
  return '127.0.0.1'
}

$lan = Get-LanAddress
$origin = "http://${lan}:${Port}"

# --- firewall (best effort; only private networks) -------------------------
try {
  $ruleName = "Salmart dev $Port"
  $existing = netsh advfirewall firewall show rule name="$ruleName" 2>$null
  if (-not $existing -or $LASTEXITCODE -ne 0) {
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$Port profile=private 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[dev] firewall rule added for TCP $Port (private networks)" -ForegroundColor DarkGray
    } else {
      Write-Host "[dev] could not add a firewall rule (needs an elevated shell once)." -ForegroundColor Yellow
      Write-Host "      If the phone cannot connect, run in an admin PowerShell:" -ForegroundColor Yellow
      Write-Host "      netsh advfirewall firewall add rule name=""$ruleName"" dir=in action=allow protocol=TCP localport=$Port profile=private" -ForegroundColor Yellow
    }
  }
} catch {
  Write-Host "[dev] firewall check skipped: $($_.Exception.Message)" -ForegroundColor DarkGray
}

# --- environment -----------------------------------------------------------
# Set before requiring anything that reads .env; dotenv never overrides an
# existing process variable, so these win over the file.
$env:NODE_ENV = 'development'
$env:PORT = "$Port"
$env:APP_BASE_URL = $origin
$env:BASE_URL = $origin

Write-Host ""
Write-Host "  Salmart backend - local dev" -ForegroundColor Green
Write-Host "  ---------------------------" -ForegroundColor DarkGray
Write-Host "  API       $origin"
Write-Host "  Health    $origin/ (should say: Salmart API is running on port $Port)"
Write-Host "  NODE_ENV  development"
Write-Host "  Phone     same Wi-Fi as this PC, then:  npx expo start --lan" -ForegroundColor Cyan
Write-Host "  App       no env needed - the app reads this PC's IP from Metro (port $Port)"
Write-Host "  Google    native picker works; the browser fallback needs an https callback,"
Write-Host "            so use the app's Google button (native path) on a LAN."
Write-Host ""

node app.js
