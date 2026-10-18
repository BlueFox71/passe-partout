# Construit Passe-Partout.exe et crée le raccourci sur le bureau.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
& .\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --windowed `
    --name "Passe-Partout" --icon "ui\assets\icon.ico" `
    --add-data "ui;ui" lancer.pyw
if ($LASTEXITCODE -ne 0) { throw "PyInstaller a échoué" }

$exe = Join-Path $PSScriptRoot "dist\Passe-Partout\Passe-Partout.exe"
$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop "Passe-Partout.lnk"))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = Split-Path $exe
$lnk.IconLocation = "$exe,0"
$lnk.Description = "Gestionnaire de mots de passe"
$lnk.Save()
Write-Host "OK : $exe"
