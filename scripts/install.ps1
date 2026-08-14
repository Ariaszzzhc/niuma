# niuma install script (Windows) — https://github.com/Ariaszzzhc/niuma
#
# Usage:
#   irm https://raw.githubusercontent.com/Ariaszzzhc/niuma/main/scripts/install.ps1 | iex
#   $env:NIUMA_VERSION = "0.1.0"            # pin a version (default: latest)
#   $env:NIUMA_INSTALL = "D:\tools\niuma"    # install-root override
#
# Downloads niuma-windows-amd64.exe.zip from GitHub Releases, verifies it
# against the release's SHA256SUMS, installs niuma.exe to
# $NIUMA_INSTALL\bin (default ~\.niuma\bin), and adds that directory to the
# user PATH when missing. PowerShell 5.1+.

$ErrorActionPreference = "Stop"

$Repo = "Ariaszzzhc/niuma"
$Asset = "niuma-windows-amd64.exe.zip"

$Version = $env:NIUMA_VERSION
if (-not $Version) {
  $latest = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $latest.tag_name
}
if (-not $Version.StartsWith("v")) { $Version = "v$Version" }

$Base = "https://github.com/$Repo/releases/download/$Version"
$Tmp = New-Item -ItemType Directory -Force (
  Join-Path $env:TEMP ("niuma-install-" + [Guid]::NewGuid().ToString("N"))
)

try {
  Write-Host "niuma install: downloading $Asset ($Version)"
  Invoke-WebRequest "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset)
  Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS")

  $line = Get-Content (Join-Path $Tmp "SHA256SUMS") |
    Where-Object { $_ -match ("  " + [regex]::Escape($Asset) + "$") } |
    Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS has no entry for $Asset" }
  $expected = ($line -split "\s+")[0].ToLower()
  $actual = (Get-FileHash (Join-Path $Tmp $Asset) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { throw "checksum mismatch for $Asset" }

  $Root = $env:NIUMA_INSTALL
  if (-not $Root) { $Root = Join-Path $HOME ".niuma" }
  $BinDir = Join-Path $Root "bin"
  New-Item -ItemType Directory -Force $BinDir | Out-Null
  Expand-Archive (Join-Path $Tmp $Asset) -DestinationPath $BinDir -Force

  $Niuma = Join-Path $BinDir "niuma.exe"
  Write-Host "niuma install: installed niuma $(& $Niuma --version) to $Niuma"

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($UserPath -split ";") -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable(
      "Path", "$UserPath;$BinDir", "User")
    Write-Host "niuma install: added $BinDir to the user PATH (open a new terminal)"
  }
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
