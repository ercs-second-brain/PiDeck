#
# agentsKISS — Windows bootstrap (WSL path).
#
# Windows is not supported natively. This script installs WSL if missing,
# enables systemd inside the distro, then runs the standard Linux installer
# inside it — so the service is a systemd user unit and the webapp is
# reachable from the Windows host at the WSL address.
#
# Usage (PowerShell):
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\agentskiss-setup.ps1                          # default distro: Ubuntu
#   .\agentskiss-setup.ps1 -Distro Ubuntu-24.04
#   .\agentskiss-setup.ps1 -SkipOnboarding          # pass --no-onboard
#   .\agentskiss-setup.ps1 -NoAutoStart             # skip logon autostart task
#   .\agentskiss-setup.ps1 -Ref v0.1.0              # install a specific ref
#
# NOTE: untested path — see install/README.md ("Tested matrix") before
# relying on it; fixes welcome.

param(
    [string]$Distro = "Ubuntu",
    [string]$Repo = "https://github.com/ercs-second-brain/agentsKISS",
    [string]$Ref = "main",
    [string]$Port = "8321",
    [switch]$SkipOnboarding,
    [switch]$NoAutoStart
)

$ErrorActionPreference = "Stop"

function Info($msg)  { Write-Host "==> $msg" }
function Step($msg)  { Write-Host "--> $msg" }
function Die($msg)   { Write-Error $msg; exit 1 }

# ---------------------------------------------------------------------------
# 1. WSL present? If not, install it (requires elevation + typically a reboot)
# ---------------------------------------------------------------------------
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$wslOk = $false
if ($wsl) {
    try {
        wsl.exe --status 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $wslOk = $true }
    } catch { $wslOk = $false }
}

if (-not $wslOk) {
    Step "WSL not found - installing it (this needs an elevated PowerShell and usually a reboot)"
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Info "re-launching elevated to run 'wsl --install'..."
        $argList = "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Distro $Distro -Repo `"$Repo`" -Ref $Ref -Port $Port"
        if ($SkipOnboarding) { $argList += " -SkipOnboarding" }
        if ($NoAutoStart)    { $argList += " -NoAutoStart" }
        Start-Process PowerShell -Verb RunAs -ArgumentList $argList
        exit 0
    }
    wsl.exe --install -d $Distro
    if ($LASTEXITCODE -ne 0) { Die "wsl --install failed (exit $LASTEXITCODE)" }
    Write-Host ""
    Die "WSL was installed and a REBOOT is required. After rebooting, re-run this script."
}

# ---------------------------------------------------------------------------
# 2. Distro registered?
# ---------------------------------------------------------------------------
Step "checking distro '$Distro'"
$distros = (wsl.exe --list --quiet) 2>$null
$distroList = ($distros | ForEach-Object { $_.Trim() -replace "`0", "" }) | Where-Object { $_ }
$distroNames = @($distroList | ForEach-Object { ($_ -split ' ')[0] })
if ($distroNames -notcontains $Distro) {
    Step "installing distro '$Distro' (first launch takes a few minutes)"
    wsl.exe --install -d $Distro --no-launch
    if ($LASTEXITCODE -ne 0) { Die "installing distro '$Distro' failed" }
}

# ---------------------------------------------------------------------------
# 3. systemd inside the distro (required for the agentskiss user service)
# ---------------------------------------------------------------------------
Step "enabling systemd in $Distro (/etc/wsl.conf)"
wsl.exe -d $Distro -u root -- sh -c 'mkdir -p /etc && if ! grep -q "^\[boot\]" /etc/wsl.conf 2>/dev/null; then printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf; fi; if ! grep -q "^systemd=true" /etc/wsl.conf 2>/dev/null; then printf "systemd=true\n" >> /etc/wsl.conf; fi; cat /etc/wsl.conf'
if ($LASTEXITCODE -ne 0) { Die "writing /etc/wsl.conf failed" }

Step "restarting $Distro so systemd takes effect"
wsl.exe --terminate $Distro
wsl.exe -d $Distro -e true
Start-Sleep -Seconds 5

$hasSystemd = wsl.exe -d $Distro -- sh -c 'pidof systemd >/dev/null 2>&1 && echo yes || echo no'
if (($hasSystemd | ForEach-Object { $_.Trim() }) -notcontains "yes") {
    Write-Warning "systemd does not appear to be running inside $Distro."
    Write-Warning "agentskiss will still install, but the service needs systemd:"
    Write-Warning "  wsl --update   (WSL2 + recent Windows required)"
    Write-Warning "then re-run this script."
}

# ---------------------------------------------------------------------------
# 4. Run the Linux installer inside the distro
# ---------------------------------------------------------------------------
Step "running the agentskiss Linux installer inside $Distro"
$onboardFlag = ""
if ($SkipOnboarding) { $onboardFlag = "--no-onboard" }
$bootstrapUrl = "https://raw.githubusercontent.com/ercs-second-brain/agentsKISS/$Ref/install/bootstrap.sh"
wsl.exe -d $Distro -- sh -lc "curl -fsSL '$bootstrapUrl' | sh -s -- --repo '$Repo' --ref '$Ref' --port $Port $onboardFlag"
if ($LASTEXITCODE -ne 0) { Die "installer inside WSL failed (exit $LASTEXITCODE)" }

# ---------------------------------------------------------------------------
# 5. Optional: start the service on Windows logon (WSL auto-starts on demand)
# ---------------------------------------------------------------------------
if (-not $NoAutoStart) {
    Step "registering logon task to start the agentskiss service in $Distro"
    $task = "agentskiss-service"
    $tr = "wsl.exe -d $Distro -e sh -lc 'systemctl --user start agentskiss.service'"
    schtasks.exe /Create /F /TN $task /SC ONLOGON /TR $tr | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Info "logon task '$task' created (remove with: schtasks /Delete /TN $task /F)"
    } else {
        Write-Warning "could not create logon task; the service still starts whenever WSL is running"
    }
}

# ---------------------------------------------------------------------------
# 6. Where is the webapp?
# ---------------------------------------------------------------------------
Step "finishing up"
$webUrl = wsl.exe -d $Distro -- sh -lc '"$HOME/.local/bin/agentskiss" addr' 2>$null
Info "webapp address (from the Windows host): $webUrl"
Info "done. open the address above in your browser once onboarding is complete."
