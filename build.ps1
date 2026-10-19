# Construit l'exe unique de Passe-Partout : dist\Passe-Partout-<VERSION>.exe (interface + APK Android embarqués).
#   powershell -File build.ps1
# L'APK (mobile\dist\passe-partout.apk) est d'abord reconstruit s'il manque ou s'il est plus ancien que VERSION.
$ErrorActionPreference = "Stop"
$racine = $PSScriptRoot

$version = (Get-Content (Join-Path $racine "VERSION") -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "VERSION invalide : « $version »" }

$apk = Join-Path $racine "mobile\dist\passe-partout.apk"
$versionFile = Get-Item (Join-Path $racine "VERSION")
if (-not (Test-Path $apk) -or (Get-Item $apk).LastWriteTimeUtc -lt $versionFile.LastWriteTimeUtc) {
    Write-Host "==> Construction de l'APK" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $racine "mobile\build.ps1")
    if ($LASTEXITCODE -ne 0) { throw "La construction de l'APK a échoué (code $LASTEXITCODE)" }
}

Push-Location $racine
try {
    & (Join-Path $racine ".venv\Scripts\python.exe") -m PyInstaller --noconfirm --clean `
        --distpath (Join-Path $racine "dist") --workpath (Join-Path $racine "build") `
        (Join-Path $racine "Passe-Partout.spec")
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller a échoué (code $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$exe = Join-Path $racine "dist\Passe-Partout-$version.exe"
if (-not (Test-Path $exe)) { throw "Exe introuvable : $exe" }
$taille = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "OK : $exe ($taille Mo)" -ForegroundColor Green
