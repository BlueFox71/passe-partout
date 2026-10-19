# Publie une version de Passe-Partout : vérifications, builds (APK + exe), tag, release GitHub.
#   powershell -File release.ps1            publication réelle (depuis main, arbre propre, GH_TOKEN défini)
#   powershell -File release.ps1 -DryRun    déroule tout sans taguer, pousser ni appeler GitHub
param([switch]$DryRun)
$ErrorActionPreference = "Continue"
$racine = $PSScriptRoot
Set-Location $racine
$py = Join-Path $racine ".venv\Scripts\python.exe"
$env:PYTHONUTF8 = "1"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Stop-Release($message) { Write-Host "ERREUR : $message" -ForegroundColor Red; exit 1 }
function Etape($texte) { Write-Host "==> $texte" -ForegroundColor Cyan }
# Une vérification qui bloque une vraie publication n'est qu'un avertissement en simulation.
function Verifier($message) {
    if ($DryRun) { Write-Host "AVERTISSEMENT (ignoré en simulation) : $message" -ForegroundColor Yellow }
    else { Stop-Release $message }
}

$version = (Get-Content (Join-Path $racine "VERSION") -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { Stop-Release "VERSION invalide : « $version »" }
$tag = "v$version"
if ($DryRun) { Write-Host "SIMULATION : rien ne sera tagué, poussé ni publié." -ForegroundColor Yellow }
Write-Host "Version $version (tag $tag)"

Etape "Branche et arbre de travail"
$branche = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branche -ne "main") { Verifier "la publication se fait depuis main (branche actuelle : $branche)." }
$sale = & git status --porcelain
if ($sale) { Verifier "l'arbre de travail n'est pas propre :`n$($sale -join "`n")" }

Etape "Fichiers sensibles suivis par git"
$sensibles = (& git ls-files) | & $py (Join-Path $racine "tools\release.py") sensitive
if ($LASTEXITCODE -ne 0) { Stop-Release "fichiers sensibles suivis par git :`n$($sensibles -join "`n")" }

Etape "Notes de version"
& $py (Join-Path $racine "tools\release.py") check-notes $version (Join-Path $racine "RELEASE_NOTES.md")
if ($LASTEXITCODE -ne 0) { Stop-Release "RELEASE_NOTES.md invalide (voir ci-dessus)." }

Etape "Tag"
if (& git tag --list $tag) { Stop-Release "le tag $tag existe déjà en local." }
if (-not $DryRun) {
    $distant = & git ls-remote --tags origin "refs/tags/$tag"
    if ($LASTEXITCODE -ne 0) { Stop-Release "impossible de lire les tags distants." }
    if ($distant) { Stop-Release "le tag $tag existe déjà sur GitHub." }
}

Etape "Tests Python"
& $py -m pytest -q
if ($LASTEXITCODE -ne 0) { Stop-Release "les tests Python échouent." }
Etape "Tests mobile"
Push-Location (Join-Path $racine "mobile")
& npm test
$codeNpm = $LASTEXITCODE
Pop-Location
if ($codeNpm -ne 0) { Stop-Release "les tests mobile échouent." }

Etape "APK Android"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $racine "mobile\build.ps1")
if ($LASTEXITCODE -ne 0) { Stop-Release "la construction de l'APK a échoué." }
Etape "Exe"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $racine "build.ps1")
if ($LASTEXITCODE -ne 0) { Stop-Release "la construction de l'exe a échoué." }
$exe = Join-Path $racine "dist\Passe-Partout-$version.exe"
if (-not (Test-Path $exe)) { Stop-Release "exe introuvable : $exe" }

if (-not $env:GH_TOKEN) {
    Verifier "Définis GH_TOKEN (jeton GitHub en écriture sur passe-partout) puis relance."
}

if ($DryRun) {
    Write-Host "[simulation] git tag $tag ; git push origin $tag"
    & $py (Join-Path $racine "tools\release.py") publish $version $exe --dry-run
    if ($LASTEXITCODE -ne 0) { Stop-Release "la simulation de publication a échoué." }
    Write-Host "Simulation terminée : rien n'a été publié." -ForegroundColor Green
    exit 0
}

Etape "Tag $tag"
& git tag $tag
if ($LASTEXITCODE -ne 0) { Stop-Release "git tag a échoué." }
& git push origin $tag
if ($LASTEXITCODE -ne 0) { Stop-Release "git push du tag a échoué (le tag local $tag existe : git tag -d $tag pour le retirer)." }
Etape "Release GitHub"
& $py (Join-Path $racine "tools\release.py") publish $version $exe
if ($LASTEXITCODE -ne 0) { Stop-Release "la publication a échoué (le tag $tag est déjà poussé)." }
Write-Host "Version $version publiée." -ForegroundColor Green
