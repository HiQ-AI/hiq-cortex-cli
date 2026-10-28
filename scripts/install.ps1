<# Querying LCA Datasets installer; defaults are rendered for one CDN release. #>
$ErrorActionPreference = 'Stop'
$DefaultVersion = ''
$DefaultBase = ''
$Tool = 'querying-lca-datasets'
$InstallDir = if ($env:QUERYING_LCA_DATASETS_INSTALL) { $env:QUERYING_LCA_DATASETS_INSTALL } else { "$env:LOCALAPPDATA\Programs\$Tool" }
$version = if ($env:QUERYING_LCA_DATASETS_VERSION) { $env:QUERYING_LCA_DATASETS_VERSION -replace '^v', '' } else { $DefaultVersion }
$base =
  if ($env:QUERYING_LCA_DATASETS_BASE_URL) { $env:QUERYING_LCA_DATASETS_BASE_URL }
  elseif ($env:QUERYING_LCA_DATASETS_VERSION) { "https://download.hiq.earth/cli/$Tool/releases/v$version" }
  else { $DefaultBase }
if (-not $base) { throw 'Use a versioned CDN installer, or set QUERYING_LCA_DATASETS_BASE_URL' }
if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'Windows tar is required' }

$archive = "$Tool-win32-x64.tar.gz"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading Querying LCA Datasets $version (win32-x64)"
  Invoke-WebRequest "$base/$archive" -OutFile "$tmp\$archive" -UseBasicParsing
  Invoke-WebRequest "$base/checksums.txt" -OutFile "$tmp\sums.txt" -UseBasicParsing
  $sha = (Get-FileHash "$tmp\$archive" -Algorithm SHA256).Hash.ToLower()
  $pattern = '^([a-f0-9]{64})\s+(?:\./)?' + [regex]::Escape($archive) + '$'
  $entries = @(Select-String -Path "$tmp\sums.txt" -Pattern $pattern)
  if ($entries.Count -ne 1 -or $entries[0].Matches[0].Groups[1].Value -ne $sha) { throw 'Checksum mismatch or duplicate record' }
  $unpacked = Join-Path $tmp 'unpacked'
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  & tar xzf "$tmp\$archive" -C $unpacked --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw 'Extraction failed' }
  $binary = Join-Path $unpacked "bin\$Tool.exe"
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Missing native executable' }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Move-Item $binary "$InstallDir\$Tool.exe" -Force
  Write-Host "Installed: $InstallDir\$Tool.exe"
  Write-Host "Next: & `"$InstallDir\$Tool.exe`" login (or add the install directory to PATH)"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
