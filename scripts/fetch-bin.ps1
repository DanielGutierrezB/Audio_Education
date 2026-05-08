# Fetches Windows binaries that AudioPro bundles (ffmpeg.exe, ffprobe.exe,
# deep-filter.exe). The bin/ directory is gitignored, so this script is what
# populates it on a Windows machine before `npm run build:win`.
#
# Sources:
#   - ffmpeg / ffprobe Windows builds:
#       https://github.com/BtbN/FFmpeg-Builds/releases
#       (BtbN serves both x64 and arm64 static builds.)
#   - deep-filter Windows builds:
#       https://github.com/Rikorose/DeepFilterNet/releases/tag/v0.5.6
#
# Usage (PowerShell, from repo root):
#   npm run setup:bin:win
#
# Notes:
#   - This script does not pin SHA256 hashes — release artefacts on GitHub
#     are immutable per tag, so URL pinning is sufficient for now.
#   - deep-filter is currently disabled in the pipeline; the binary is
#     downloaded for completeness but isn't called at runtime.
#   - The arm64 ffmpeg URL uses a master rolling tag because BtbN doesn't
#     ship per-version arm64 stable releases yet. If your build is
#     reproducibility-sensitive, replace it with a dated artefact link.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Bin  = Join-Path $Root 'bin'

if (-not (Test-Path $Bin)) {
    New-Item -ItemType Directory -Path $Bin | Out-Null
}

$Tmp = Join-Path $env:TEMP "audiopro-bin-$(Get-Random)"
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
    # FFmpeg + FFprobe — BtbN static builds (GPL, includes everything we need)
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'winarm64' } else { 'win64' }
    Write-Host "Detected build arch: $arch"

    $ffmpegZip = Join-Path $Tmp 'ffmpeg.zip'
    $ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.zip"
    Write-Host "Downloading ffmpeg ($ffmpegUrl)"
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing
    Expand-Archive -Path $ffmpegZip -DestinationPath $Tmp -Force

    $extracted = Get-ChildItem -Path $Tmp -Directory | Where-Object { $_.Name -like 'ffmpeg-*' } | Select-Object -First 1
    Copy-Item -Path (Join-Path $extracted.FullName 'bin\ffmpeg.exe')  -Destination (Join-Path $Bin 'ffmpeg.exe')  -Force
    Copy-Item -Path (Join-Path $extracted.FullName 'bin\ffprobe.exe') -Destination (Join-Path $Bin 'ffprobe.exe') -Force
    Write-Host "  ffmpeg.exe + ffprobe.exe installed"

    # deep-filter — only x86_64 build is published; on arm64 hosts the
    # binary is skipped (pipeline currently has ML denoise disabled anyway).
    if ($arch -eq 'win64') {
        $dfUrl = 'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-x86_64-pc-windows-msvc.exe'
        Write-Host "Downloading deep-filter ($dfUrl)"
        Invoke-WebRequest -Uri $dfUrl -OutFile (Join-Path $Bin 'deep-filter.exe') -UseBasicParsing
        Write-Host "  deep-filter.exe installed"
    } else {
        Write-Host "  deep-filter: no arm64 windows build published, skipping"
    }

    Write-Host "`nDone. bin/ now contains:"
    Get-ChildItem -Path $Bin | ForEach-Object { Write-Host "  $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" }
} finally {
    Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
