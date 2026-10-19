# Construit l'APK signé de Passe-Partout : mobile\dist\passe-partout.apk
#   powershell -File mobile\build.ps1
# Étapes : npm run assemble -> npx cap sync android -> clé de signature (créée au premier lancement,
# hors dépôt) -> gradlew assembleRelease -> copie de l'APK.
# JAVA_HOME / ANDROID_HOME ne sont définis que pour ce processus s'ils manquent (jamais de façon permanente).

$ErrorActionPreference = 'Stop'
$mobile = $PSScriptRoot

function Fail([string]$message) {
    Write-Host "ERREUR : $message" -ForegroundColor Red
    exit 1
}

function Run([string]$label, [scriptblock]$command) {
    Write-Host "==> $label" -ForegroundColor Cyan
    # Les outils écrivent des avertissements sur stderr : seul le code de sortie fait foi.
    $ErrorActionPreference = 'Continue'
    & $command
    if ($LASTEXITCODE -ne 0) { Fail "échec de l'étape « $label » (code $LASTEXITCODE)." }
}

# --- Outils : JDK et SDK Android -------------------------------------------------------------
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
    $jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $jdk) {
        Fail "JDK 21 introuvable. Installez-le (winget install -e --id Microsoft.OpenJDK.21) ou définissez JAVA_HOME."
    }
    $env:JAVA_HOME = $jdk.FullName
}
if (-not $env:ANDROID_HOME -or -not (Test-Path (Join-Path $env:ANDROID_HOME 'platforms'))) {
    $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (-not (Test-Path (Join-Path $sdk 'platforms'))) {
        Fail "SDK Android introuvable ($sdk). Ouvrez Android Studio une fois pour l'installer, ou définissez ANDROID_HOME."
    }
    $env:ANDROID_HOME = $sdk
}
Write-Host "JDK : $env:JAVA_HOME"
Write-Host "SDK Android : $env:ANDROID_HOME"
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'

Push-Location $mobile
try {
    if (-not (Test-Path 'node_modules')) {
        Run 'npm ci' { npm ci }
    }
    # Version unique : fichier VERSION à la racine du dépôt (x.y.z) -> versionName / versionCode (x*10000 + y*100 + z)
    $versionName = (Get-Content (Join-Path $mobile '..\VERSION') -Raw).Trim()
    if ($versionName -notmatch '^(\d+)\.(\d+)\.(\d+)$') { Fail "VERSION invalide : « $versionName »." }
    $versionCode = [int]$Matches[1] * 10000 + [int]$Matches[2] * 100 + [int]$Matches[3]
    Write-Host "Version : $versionName (versionCode $versionCode)"
    Run 'npm run assemble' { npm run assemble }
    Run 'npx cap sync android' { npx cap sync android }

    # --- Clé de signature (hors dépôt) ---------------------------------------------------------
    # Dossier des données renommé le 19/10/2026 (GestionnaireMdp → PassePartout) : même migration que app/main.py
    $dataDir = Join-Path $env:APPDATA 'PassePartout'
    $oldDataDir = Join-Path $env:APPDATA 'GestionnaireMdp'
    if (-not (Test-Path $dataDir) -and (Test-Path $oldDataDir)) {
        Rename-Item -Path $oldDataDir -NewName 'PassePartout'
    }
    $signDir = Join-Path $dataDir 'android-signing'
    if (-not (Test-Path (Join-Path $signDir 'passe-partout.jks')) -and (Test-Path (Join-Path $oldDataDir 'android-signing\passe-partout.jks'))) {
        # ne jamais créer une nouvelle clé alors que l'ancienne existe : l'appli installée ne pourrait plus être mise à jour
        Fail "La clé de signature est restée dans $oldDataDir\android-signing : déplacez ce dossier dans $dataDir puis relancez."
    }
    $keystore = Join-Path $signDir 'passe-partout.jks'
    $propsFile = Join-Path $signDir 'signing.properties'
    if (-not (Test-Path $keystore)) {
        if (Test-Path $propsFile) {
            Fail "signing.properties existe sans passe-partout.jks dans $signDir : vérifiez ce dossier avant de continuer."
        }
        Write-Host "==> Création de la clé de signature dans $signDir" -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path $signDir | Out-Null
        $bytes = New-Object byte[] 24
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes)
        $rng.Dispose()
        $password = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        # Mot de passe transmis par variable d'environnement (jamais sur la ligne de commande ni affiché).
        $env:PP_KEYSTORE_PASSWORD = $password
        $ErrorActionPreference = 'Continue'
        & $keytool -genkeypair -keystore $keystore -storetype PKCS12 -alias passe-partout `
            -keyalg RSA -keysize 4096 -validity 36500 -dname 'CN=Passe-Partout' `
            -storepass:env PP_KEYSTORE_PASSWORD -keypass:env PP_KEYSTORE_PASSWORD
        $code = $LASTEXITCODE
        Remove-Item Env:\PP_KEYSTORE_PASSWORD
        $ErrorActionPreference = 'Stop'
        if ($code -ne 0) { Fail "keytool n'a pas pu créer la clé de signature (code $code)." }
        $lines = @(
            '# Signature de l''APK Passe-Partout. NE PAS PERDRE : sans ce fichier et passe-partout.jks,'
            '# les mises à jour de l''appli ne pourront plus s''installer par-dessus la version existante.'
            "storePassword=$password"
            'keyAlias=passe-partout'
            "keyPassword=$password"
        )
        [System.IO.File]::WriteAllLines($propsFile, $lines, (New-Object System.Text.UTF8Encoding $false))
        $password = $null
        Write-Host "Clé créée. Sauvegardez le dossier $signDir (clé + mot de passe)." -ForegroundColor Yellow
    }
    if (-not (Test-Path $propsFile)) {
        Fail "passe-partout.jks existe mais signing.properties est introuvable dans $signDir."
    }

    # --- Construction ----------------------------------------------------------------------------
    $env:PP_SIGNING_PROPERTIES = $propsFile
    Push-Location (Join-Path $mobile 'android')
    try {
        Run 'gradlew assembleRelease' { .\gradlew.bat assembleRelease --no-daemon "-PppVersionName=$versionName" "-PppVersionCode=$versionCode" }
    } finally {
        Pop-Location
    }

    $apk = Join-Path $mobile 'android\app\build\outputs\apk\release\app-release.apk'
    if (-not (Test-Path $apk)) {
        Fail "APK signé introuvable ($apk) : la signature n'a sans doute pas été appliquée."
    }
    $dist = Join-Path $mobile 'dist'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $out = Join-Path $dist 'passe-partout.apk'
    Copy-Item $apk $out -Force
    $size = [math]::Round((Get-Item $out).Length / 1MB, 2)
    Write-Host "APK prêt : $out ($size Mo)" -ForegroundColor Green
} catch {
    Fail $_.Exception.Message
} finally {
    Pop-Location
}
