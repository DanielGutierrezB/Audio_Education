#requires -Version 5.0
# Fetches the Windows x64 binaries that AudioPro bundles (ffmpeg, ffprobe).
# The bin/ directory is gitignored, so this script is what populates it
# after a fresh clone, before `npm run build:win`.
#
# Source:
#   - BtbN/FFmpeg-Builds GitHub releases (static GPL builds, ffmpeg + ffprobe)
#
# Usage (from project root):
#   npm run setup:bin:win
# Or directly:
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-bin.ps1

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root      = Split-Path -Parent $ScriptDir
$Bin       = Join-Path $Root 'bin'

# Always fetches the latest BtbN auto-build. If that URL ever 404s, pin to a
# specific release tag from https://github.com/BtbN/FFmpeg-Builds/releases
$FfmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

Write-Host ''
Write-Host '════════════════════════════════════════'
Write-Host '  AudioPro · fetching Windows binaries'
Write-Host '════════════════════════════════════════'
Write-Host ''
Write-Host "Target: $Bin"

if (-not (Test-Path $Bin)) {
  New-Item -ItemType Directory -Path $Bin | Out-Null
}

# Build a unique temp directory under $env:TEMP.
$Tmp = Join-Path $env:TEMP "audiopro-bin-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Tmp | Out-Null

$Zip       = Join-Path $Tmp 'ffmpeg.zip'
$Extracted = Join-Path $Tmp 'extracted'

try {
  Write-Host '→ Downloading ffmpeg/ffprobe…'
  # UseBasicParsing avoids dependence on Internet Explorer's COM engine
  # (which is no longer present on Windows 11 + Server 2025).
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $FfmpegUrl -OutFile $Zip -UseBasicParsing
  $ProgressPreference = 'Continue'

  Write-Host '→ Extracting…'
  Expand-Archive -Path $Zip -DestinationPath $Extracted -Force

  # The ZIP contains a single top-level folder; locate ffmpeg.exe and
  # ffprobe.exe regardless of the folder name (it changes between builds).
  $ffmpegExe  = Get-ChildItem -Path $Extracted -Recurse -Filter 'ffmpeg.exe'  | Select-Object -First 1
  $ffprobeExe = Get-ChildItem -Path $Extracted -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1

  if (-not $ffmpegExe -or -not $ffprobeExe) {
    throw 'Could not find ffmpeg.exe and/or ffprobe.exe inside the downloaded ZIP'
  }

  Copy-Item -Path $ffmpegExe.FullName  -Destination (Join-Path $Bin 'ffmpeg.exe')  -Force
  Copy-Item -Path $ffprobeExe.FullName -Destination (Join-Path $Bin 'ffprobe.exe') -Force

  Write-Host ''
  Write-Host '✓ Done. Staged binaries:'
  Get-Item -Path (Join-Path $Bin 'ffmpeg.exe'), (Join-Path $Bin 'ffprobe.exe') |
    Format-Table Name, @{Name='Size (MB)'; Expression={[math]::Round($_.Length/1MB,1)}}, LastWriteTime
}
finally {
  Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
