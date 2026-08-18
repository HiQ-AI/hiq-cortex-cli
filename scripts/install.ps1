<#
.SYNOPSIS
  hiq-cortex installer — Windows

.EXAMPLE
  irm https://raw.githubusercontent.com/HiQ-AI/hiq-cortex-cli/main/scripts/install.ps1 | iex

.NOTES
  Env: HIQ_CORTEX_VERSION (default: latest) · HIQ_CORTEX_INSTALL (default:
  %LOCALAPPDATA%\Programs\hiq-cortex) · HIQ_CORTEX_BASE_URL (default: GitHub Releases)
#>
$ErrorActionPreference = 'Stop'

$Repo = 'HiQ-AI/hiq-cortex-cli'
$InstallDir = if ($env:HIQ_CORTEX_INSTALL) { $env:HIQ_CORTEX_INSTALL } else { "$env:LOCALAPPDATA\Programs\hiq-cortex" }

if ([Environment]::Is64BitOperatingSystem -eq $false) { throw '需要 64 位 Windows' }

$version = $env:HIQ_CORTEX_VERSION
if (-not $version) {
  Write-Host '查询最新版本…'
  $version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
}
$version = $version -replace '^v', ''

$base = if ($env:HIQ_CORTEX_BASE_URL) { $env:HIQ_CORTEX_BASE_URL } else { "https://github.com/$Repo/releases/download/v$version" }
$archive = "hiq-cortex-$version-windows-x64.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host "下载 hiq-cortex $version (windows-x64)…"
  Invoke-WebRequest "$base/$archive" -OutFile "$tmp\$archive" -UseBasicParsing

  # Checksum verification is best-effort — a missing checksums file must not
  # block the install, a mismatching one must.
  try {
    Invoke-WebRequest "$base/hiq-cortex-$version-checksums.txt" -OutFile "$tmp\sums.txt" -UseBasicParsing
    $sha = (Get-FileHash "$tmp\$archive" -Algorithm SHA256).Hash.ToLower()
    if (-not (Select-String -Path "$tmp\sums.txt" -Pattern $sha -Quiet)) { throw '校验和不匹配,已中止安装' }
    Write-Host '校验和 OK'
  } catch [System.Net.WebException] { }

  Expand-Archive "$tmp\$archive" -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Move-Item "$tmp\hiq-cortex.exe" "$InstallDir\hiq-cortex.exe" -Force

  # Persist on PATH for future shells, and set it in this one so the next
  # command in a piped install works without reopening the terminal.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$userPath", 'User')
    Write-Host "已把 $InstallDir 加入 PATH(新开的终端生效)"
  }
  $env:Path = "$InstallDir;$env:Path"

  Write-Host ''
  Write-Host "已安装: $InstallDir\hiq-cortex.exe"
  Write-Host '下一步: hiq-cortex login'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
