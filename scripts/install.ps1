<#
.SYNOPSIS
  lca-background-data installer — Windows

.EXAMPLE
  irm https://raw.githubusercontent.com/HiQ-AI/hiq-cortex-cli/main/scripts/install.ps1 | iex

.NOTES
  Env: LCA_BACKGROUND_DATA_VERSION (default: latest) · LCA_BACKGROUND_DATA_INSTALL (default:
  %LOCALAPPDATA%\Programs\lca-background-data) · LCA_BACKGROUND_DATA_BASE_URL (default: GitHub Releases)
#>
$ErrorActionPreference = 'Stop'

$Repo = 'HiQ-AI/hiq-cortex-cli'
$InstallDir = if ($env:LCA_BACKGROUND_DATA_INSTALL) { $env:LCA_BACKGROUND_DATA_INSTALL } else { "$env:LOCALAPPDATA\Programs\lca-background-data" }

if ([Environment]::Is64BitOperatingSystem -eq $false) { throw '需要 64 位 Windows' }

# No version lookup: GitHub resolves `releases/latest/download/<asset>` itself,
# which keeps a first install off the anonymous API and its 60-req/hour limit.
$version = $env:LCA_BACKGROUND_DATA_VERSION -replace '^v', ''
$base =
  if ($env:LCA_BACKGROUND_DATA_BASE_URL) { $env:LCA_BACKGROUND_DATA_BASE_URL }
  elseif ($version) { "https://github.com/$Repo/releases/download/v$version" }
  else { "https://github.com/$Repo/releases/latest/download" }

$archive = 'lca-background-data-windows-x64.zip'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host "下载 lca-background-data $(if ($version) { $version } else { 'latest' }) (windows-x64)…"
  Invoke-WebRequest "$base/$archive" -OutFile "$tmp\$archive" -UseBasicParsing

  Invoke-WebRequest "$base/checksums.txt" -OutFile "$tmp\sums.txt" -UseBasicParsing
  $sha = (Get-FileHash "$tmp\$archive" -Algorithm SHA256).Hash.ToLower()
  $pattern = '^([a-f0-9]{64})\s+(?:\./)?' + [regex]::Escape($archive) + '$'
  $entries = @(Select-String -Path "$tmp\sums.txt" -Pattern $pattern)
  if ($entries.Count -ne 1 -or $entries[0].Matches[0].Groups[1].Value -ne $sha) { throw '校验和不匹配或条目不唯一,已中止安装' }
  Write-Host '校验和 OK'

  Expand-Archive "$tmp\$archive" -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Move-Item "$tmp\lca-background-data.exe" "$InstallDir\lca-background-data.exe" -Force

  # Persist on PATH for future shells, and set it in this one so the next
  # command in a piped install works without reopening the terminal.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$userPath", 'User')
    Write-Host "已把 $InstallDir 加入 PATH(新开的终端生效)"
  }
  $env:Path = "$InstallDir;$env:Path"

  Write-Host ''
  Write-Host "已安装: $InstallDir\lca-background-data.exe"
  Write-Host '下一步: lca-background-data login'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
