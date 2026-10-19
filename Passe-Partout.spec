# -*- mode: python ; coding: utf-8 -*-
# Exe unique (onefile) : dist\Passe-Partout-<VERSION>.exe, avec l'interface, VERSION et l'APK Android.
# Construit par build.ps1 (qui fabrique d'abord l'APK si besoin).
import os

racine = SPECPATH
with open(os.path.join(racine, 'VERSION'), encoding='utf-8-sig') as f:
    version = f.read().strip()
apk = os.path.join(racine, 'mobile', 'dist', 'passe-partout.apk')
if not os.path.isfile(apk):
    raise SystemExit(f"APK introuvable ({apk}) : lancez d'abord mobile\build.ps1.")

a = Analysis(
    [os.path.join(racine, 'lancer.pyw')],
    pathex=[racine],
    binaries=[],
    datas=[
        (os.path.join(racine, 'ui'), 'ui'),
        (os.path.join(racine, 'VERSION'), '.'),
        (apk, 'apk'),
    ],
    hiddenimports=['app.apk', 'app.version'],  # utilisés par la synchro (tâches suivantes)
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=f'Passe-Partout-{version}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=[os.path.join(racine, 'ui', 'assets', 'icon.ico')],
)
