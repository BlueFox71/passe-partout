package fr.passepartout.app;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.fragment.app.FragmentActivity;
import androidx.lifecycle.Lifecycle;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Plugin natif de Passe-Partout (côté JS : www/js/native.js, PPM.native).
 *
 * Keystore : une clé AES-256/GCM AndroidKeyStore par alias, créée à la demande, jamais exportable.
 *   - alias ordinaire (« pp-device ») : utilisable sans authentification ;
 *   - alias biométrique (« pp-bio ») : setUserAuthenticationRequired(true) + setInvalidatedByBiometricEnrollment(true),
 *     utilisable seulement à travers BiometricPrompt (BIOMETRIC_STRONG) avec un CryptoObject ; recréée à chaque wrap.
 * Format du blob : base64 (NO_WRAP) de iv (12 octets, tiré par le Keystore) ‖ texte chiffré (avec l'étiquette GCM de 16 octets).
 * Les octets échangés avec le JS sont en base64 (champ « data »).
 *
 * Codes d'erreur (PluginCall.reject(message, code)) :
 *   KEY_MISSING     : aucune clé sous cet alias (jamais créée, ou effacée par Android) ;
 *   KEY_INVALIDATED : clé biométrique invalidée (empreinte ajoutée ou retirée) ;
 *   BAD_BLOB        : blob mal formé, ou qui ne correspond pas à la clé (étiquette GCM fausse) ;
 *   CANCELED        : fenêtre d'empreinte annulée (bouton « Utiliser le code », retour, appli en arrière-plan) ;
 *   LOCKOUT         : trop d'essais d'empreinte (capteur bloqué par Android, temporairement ou non) ;
 *   FAILED          : tout le reste (erreur passagère du Keystore…) ;
 *   CAMERA_DENIED   : appareil photo refusé (scanQr) ;
 *   INSTALL_PERMISSION : installation d'applis non autorisée pour Passe-Partout (installApk ; l'écran
 *                     d'autorisation d'Android a été ouvert, l'utilisateur doit réessayer).
 *   INVALID_APK     : APK reçu refusé (installApk) : autre paquet, autre signature, ou version pas plus récente.
 * Rien n'est journalisé : ni données, ni clés, ni exceptions.
 */
@CapacitorPlugin(
    name = "PassePartout",
    permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) }
)
public class PassePartoutPlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final String DEFAULT_TITLE = "Déverrouiller Passe-Partout";
    private static final String IS_SENSITIVE_LEGACY = "android.content.extra.IS_SENSITIVE";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** Erreur portant un code transmis au JS. */
    private static final class NativeError extends Exception {
        final String code;

        NativeError(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private interface CipherTask {
        void run(Cipher cipher) throws Exception;
    }

    // ------------------------------------------------------------------ Keystore

    private KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return ks;
    }

    // Clé de l'alias, ou null seulement si son absence est confirmée. Sur keystore2 (Android 12+), une erreur
    // passagère du démon (SYSTEM_ERROR, BACKEND_BUSY…) se lit comme « pas de clé » (containsAlias faux, getKey
    // null) : l'absence n'est admise que si trois lectures espacées, sur un KeyStore rechargé, concordent
    // (getKey, containsAlias et aliases()). Sinon NativeError FAILED (réessayable) : jamais KEY_MISSING, et
    // jamais de nouvelle clé qui écraserait la vraie.
    private static final int KEY_CHECKS = 3;
    private static final long KEY_CHECK_DELAY_MS = 150;

    private SecretKey findKey(String alias) throws Exception {
        for (int i = 0; i < KEY_CHECKS; i++) {
            if (i > 0) Thread.sleep(KEY_CHECK_DELAY_MS);
            boolean absent;
            try {
                KeyStore ks = keyStore();
                SecretKey key = (SecretKey) ks.getKey(alias, null);
                if (key != null) return key;
                absent = !ks.containsAlias(alias) && !Collections.list(ks.aliases()).contains(alias);
            } catch (Exception e) {
                absent = false; // lecture impossible : rien n'est confirmé
            }
            if (!absent) throw new NativeError("FAILED", "Erreur du module de sécurité Android.");
        }
        return null;
    }

    private SecretKey createKey(String alias, boolean biometric) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256);
        if (biometric) {
            b.setUserAuthenticationRequired(true);
            b.setInvalidatedByBiometricEnrollment(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // 0 s : une authentification par utilisation, empreinte « forte » seulement
                b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            }
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        kg.init(b.build());
        return kg.generateKey();
    }

    private void deleteEntry(String alias) throws Exception {
        KeyStore ks = keyStore();
        if (ks.containsAlias(alias)) ks.deleteEntry(alias);
    }

    private static String blobOf(byte[] iv, byte[] ct) {
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private static byte[] decodeB64(String s, String code, String message) throws NativeError {
        if (s == null) throw new NativeError(code, message);
        try {
            return Base64.decode(s, Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            throw new NativeError(code, message);
        }
    }

    private static void rejectWith(PluginCall call, Exception e) {
        if (e instanceof NativeError) {
            call.reject(e.getMessage(), ((NativeError) e).code);
        } else if (e instanceof KeyPermanentlyInvalidatedException) {
            call.reject("Les empreintes du téléphone ont changé.", "KEY_INVALIDATED");
        } else if (e instanceof AEADBadTagException) {
            call.reject("Données chiffrées illisibles.", "BAD_BLOB");
        } else {
            call.reject("Erreur du module de sécurité Android.", "FAILED");
        }
    }

    private static JSObject dataResult(byte[] bytes) {
        JSObject r = new JSObject();
        r.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return r;
    }

    @PluginMethod
    public void wrap(PluginCall call) {
        try {
            String alias = call.getString("alias");
            if (alias == null || alias.isEmpty()) throw new NativeError("FAILED", "Alias manquant.");
            byte[] data = decodeB64(call.getString("data"), "FAILED", "Données manquantes.");
            boolean biometric = Boolean.TRUE.equals(call.getBoolean("biometric", false));
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            if (biometric) {
                // nouvelle clé à chaque activation : un ancien blob d'empreinte devient illisible
                deleteEntry(alias);
                cipher.init(Cipher.ENCRYPT_MODE, createKey(alias, true));
                String title = call.getString("title", "Activer l'empreinte");
                withBiometric(call, cipher, title, "Annuler", (c) -> {
                    byte[] ct = c.doFinal(data);
                    JSObject r = new JSObject();
                    r.put("blob", blobOf(c.getIV(), ct));
                    call.resolve(r);
                });
                return;
            }
            SecretKey key = findKey(alias);
            if (key == null) key = createKey(alias, false); // absence confirmée : première clé
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] ct = cipher.doFinal(data);
            JSObject r = new JSObject();
            r.put("blob", blobOf(cipher.getIV(), ct));
            call.resolve(r);
        } catch (Exception e) {
            rejectWith(call, e);
        }
    }

    @PluginMethod
    public void unwrap(PluginCall call) {
        try {
            String alias = call.getString("alias");
            if (alias == null || alias.isEmpty()) throw new NativeError("FAILED", "Alias manquant.");
            byte[] raw = decodeB64(call.getString("blob"), "BAD_BLOB", "Données chiffrées illisibles.");
            if (raw.length < IV_BYTES + TAG_BITS / 8) throw new NativeError("BAD_BLOB", "Données chiffrées illisibles.");
            SecretKey key = findKey(alias);
            if (key == null) throw new NativeError("KEY_MISSING", "Clé de sécurité introuvable.");
            byte[] iv = Arrays.copyOfRange(raw, 0, IV_BYTES);
            byte[] ct = Arrays.copyOfRange(raw, IV_BYTES, raw.length);
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            if (needsAuth(key)) {
                String title = call.getString("title", DEFAULT_TITLE);
                withBiometric(call, cipher, title, "Utiliser le code", (c) -> call.resolve(dataResult(c.doFinal(ct))));
                return;
            }
            call.resolve(dataResult(cipher.doFinal(ct)));
        } catch (Exception e) {
            rejectWith(call, e);
        }
    }

    // Vrai si la clé exige une authentification (clé d'empreinte).
    private static boolean needsAuth(SecretKey key) {
        try {
            javax.crypto.SecretKeyFactory f = javax.crypto.SecretKeyFactory.getInstance(key.getAlgorithm(), KEYSTORE);
            android.security.keystore.KeyInfo info = (android.security.keystore.KeyInfo) f.getKeySpec(
                key, android.security.keystore.KeyInfo.class);
            return info.isUserAuthenticationRequired();
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void deleteKey(PluginCall call) {
        try {
            String alias = call.getString("alias");
            if (alias != null && !alias.isEmpty()) deleteEntry(alias);
            call.resolve();
        } catch (Exception e) {
            rejectWith(call, e);
        }
    }

    // ------------------------------------------------------------------ empreinte

    @PluginMethod
    public void biometricAvailable(PluginCall call) {
        int status = BiometricManager.from(getContext())
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        JSObject r = new JSObject();
        r.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(r);
    }

    // Fenêtre d'empreinte (thread principal) ; `task` reçoit le Cipher authentifié.
    private void withBiometric(PluginCall call, Cipher cipher, String title, String negative, CipherTask task) {
        FragmentActivity activity = getActivity();
        if (activity == null) {
            call.reject("Fenêtre d'empreinte indisponible.", "FAILED");
            return;
        }
        activity.runOnUiThread(() -> {
            // appli en arrière-plan ou en cours de fermeture : BiometricPrompt ne peut pas s'afficher
            if (activity.isFinishing() || activity.isDestroyed()
                || activity.getSupportFragmentManager().isStateSaved()
                || !activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) {
                call.reject("Fenêtre d'empreinte indisponible.", "FAILED");
                return;
            }
            try {
                BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            BiometricPrompt.CryptoObject co = result.getCryptoObject();
                            if (co == null || co.getCipher() == null) {
                                call.reject("Erreur du module de sécurité Android.", "FAILED");
                                return;
                            }
                            try {
                                task.run(co.getCipher());
                            } catch (Exception e) {
                                rejectWith(call, e);
                            }
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence message) {
                            if (code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                || code == BiometricPrompt.ERROR_USER_CANCELED
                                || code == BiometricPrompt.ERROR_CANCELED) {
                                call.reject("Empreinte annulée.", "CANCELED");
                            } else if (code == BiometricPrompt.ERROR_LOCKOUT
                                || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT) {
                                call.reject("Trop d'essais d'empreinte : utilise le code.", "LOCKOUT");
                            } else {
                                call.reject("Empreinte indisponible.", "FAILED");
                            }
                        }
                        // onAuthenticationFailed : doigt non reconnu, la fenêtre reste ouverte pour réessayer
                    });
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setNegativeButtonText(negative)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setConfirmationRequired(false)
                    .build();
                prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
            } catch (Exception e) {
                rejectWith(call, e);
            }
        });
    }

    // ------------------------------------------------------------------ presse-papiers

    private ClipboardManager clipboard() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @PluginMethod
    public void copySensitive(PluginCall call) {
        String text = call.getString("text", "");
        mainHandler.post(() -> {
            try {
                ClipboardManager cm = clipboard();
                ClipData clip = ClipData.newPlainText("Passe-Partout", text);
                // contenu masqué dans l'aperçu du presse-papiers et le clavier (Android 13+)
                PersistableBundle extras = new PersistableBundle();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                } else {
                    extras.putBoolean(IS_SENSITIVE_LEGACY, true);
                }
                clip.getDescription().setExtras(extras);
                cm.setPrimaryClip(clip);
                call.resolve();
            } catch (Exception e) {
                call.reject("Copie impossible.", "FAILED");
            }
        });
    }

    @PluginMethod
    public void copyPlain(PluginCall call) {
        String text = call.getString("text", "");
        mainHandler.post(() -> {
            try {
                clipboard().setPrimaryClip(ClipData.newPlainText("Passe-Partout", text));
                call.resolve();
            } catch (Exception e) {
                call.reject("Copie impossible.", "FAILED");
            }
        });
    }

    // ------------------------------------------------------------------ QR code et codes-barres (ZXing, sans service Google)

    @PluginMethod
    public void scanQr(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermission");
            return;
        }
        launchScanner(call);
    }

    // Code-barres d'une carte de fidélité (EAN, UPC, Code 128…, ou QR / Data Matrix / PDF417).
    @PluginMethod
    public void scanBarcode(PluginCall call) {
        scanQr(call); // même permission ; launchScanner choisit les formats d'après le nom de la méthode
    }

    @PermissionCallback
    private void cameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            launchScanner(call);
        } else {
            call.reject("Passe-Partout a besoin de l'appareil photo pour " + scanPurpose(call) + ". "
                + "Autorise-le dans les réglages Android (Applis > Passe-Partout > Autorisations).", "CAMERA_DENIED");
        }
    }

    private static boolean isBarcode(PluginCall call) {
        return "scanBarcode".equals(call.getMethodName());
    }

    private static String scanPurpose(PluginCall call) {
        return isBarcode(call) ? "lire le code-barre de la carte" : "lire le QR code du PC";
    }

    private void launchScanner(PluginCall call) {
        ScanOptions opts = new ScanOptions();
        if (isBarcode(call)) {
            opts.setDesiredBarcodeFormats(ScanOptions.ALL_CODE_TYPES);
            opts.setPrompt("Vise le code-barre de la carte");
        } else {
            opts.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
            opts.setPrompt("Vise le QR code affiché sur le PC");
        }
        opts.setBeepEnabled(false);
        opts.setOrientationLocked(true); // portrait (voir AndroidManifest.xml)
        opts.setCaptureActivity(SecureCaptureActivity.class); // captures d'écran bloquées pendant le scan
        Intent intent = opts.createScanIntent(getContext());
        startActivityForResult(call, intent, "scanResult");
    }

    @ActivityCallback
    private void scanResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ScanIntentResult r = ScanIntentResult.parseActivityResult(result.getResultCode(), result.getData());
        JSObject out = new JSObject();
        String text = r.getContents();
        if (text == null) {
            Intent original = r.getOriginalIntent();
            if (original != null && original.hasExtra(com.google.zxing.client.android.Intents.Scan.MISSING_CAMERA_PERMISSION)) {
                call.reject("Passe-Partout a besoin de l'appareil photo pour " + scanPurpose(call) + ".", "CAMERA_DENIED");
                return;
            }
            out.put("text", null); // scan annulé
        } else {
            out.put("text", text);
        }
        call.resolve(out);
    }

    // ------------------------------------------------------------ mise à jour de l'appli (APK reçu du PC)
    // L'APK (base64, champ « data ») est écrit dans cache/apk/ (seul dossier exposé par le FileProvider,
    // res/xml/file_paths.xml), puis remis à l'installateur d'Android. Lancés « pour résultat » : l'appel ne
    // se termine qu'au retour dans l'appli, pour que le JS compte ces écrans comme natifs (Ruling 23).
    private static final String APK_DIR = "apk";
    private static final String APK_FILE = "passe-partout-update.apk";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    // Au chargement : plus aucune mise à jour en attente (installée, annulée ou abandonnée) : ~11 Mo libérés.
    @Override
    public void load() {
        clearApkCache();
    }

    private void clearApkCache() {
        File[] old = new File(getContext().getCacheDir(), APK_DIR).listFiles();
        if (old != null) {
            for (File f : old) f.delete();
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            byte[] apk = decodeB64(call.getString("data"), "FAILED", "Mise à jour illisible.");
            // ~15 Mo : retirés de l'appel, que Capacitor garde (savedCalls) et écrit dans l'état sauvegardé de
            // l'activité pendant l'écran lancé (Bridge/Plugin.saveInstanceState) → TransactionTooLargeException
            call.getData().remove("data");
            if (apk.length == 0) throw new NativeError("FAILED", "Mise à jour illisible.");
            Context ctx = getContext();
            if (!ctx.getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + ctx.getPackageName()));
                launchForResult(call, settings, "installPermissionResult");
                return;
            }
            File dir = new File(ctx.getCacheDir(), APK_DIR);
            clearApkCache(); // anciennes mises à jour
            if (!dir.isDirectory() && !dir.mkdirs()) throw new NativeError("FAILED", "Espace de stockage indisponible.");
            File file = new File(dir, APK_FILE);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(apk);
            }
            if (!isGenuineUpdate(ctx, file)) { // Ruling 5 : pas de fausse appli via un faux PC
                file.delete();
                throw new NativeError("INVALID_APK", "Mise à jour invalide.");
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, APK_MIME);
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            launchForResult(call, install, "installResult");
        } catch (Exception e) {
            if (e instanceof NativeError) {
                call.reject(e.getMessage(), ((NativeError) e).code);
            } else {
                call.reject("Installation de la mise à jour impossible.", "FAILED");
            }
        }
    }

    // Vraie mise à jour de Passe-Partout (Ruling 5) : même paquet, mêmes certificats de signature que l'appli
    // installée, versionCode strictement supérieur. Toute erreur de lecture → refus.
    private static boolean isGenuineUpdate(Context ctx, File file) {
        try {
            PackageManager pm = ctx.getPackageManager();
            String own = ctx.getPackageName();
            PackageInfo apk = pm.getPackageArchiveInfo(file.getAbsolutePath(),
                PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_SIGNATURES);
            if (apk == null || !own.equals(apk.packageName)) return false;
            PackageInfo installed = pm.getPackageInfo(own, PackageManager.GET_SIGNING_CERTIFICATES);
            Set<String> apkSigners = signers(apk);
            Set<String> ownSigners = signers(installed);
            if (apkSigners.isEmpty() || !apkSigners.equals(ownSigners)) return false;
            return apk.getLongVersionCode() > installed.getLongVersionCode();
        } catch (Exception e) {
            return false;
        }
    }

    // Certificats de signature (octets, en base64 pour comparer des ensembles). L'APK lu hors installation peut,
    // selon la version d'Android, n'avoir que l'ancien champ « signatures ».
    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) {
        Signature[] sigs = null;
        SigningInfo si = info.signingInfo;
        if (si != null) sigs = si.getApkContentsSigners();
        if (sigs == null || sigs.length == 0) sigs = info.signatures;
        Set<String> out = new HashSet<>();
        if (sigs != null) {
            for (Signature sig : sigs) out.add(Base64.encodeToString(sig.toByteArray(), Base64.NO_WRAP));
        }
        return out;
    }

    // Lancement sur le thread principal ; écran introuvable → FAILED.
    private void launchForResult(PluginCall call, Intent intent, String callback) {
        mainHandler.post(() -> {
            try {
                startActivityForResult(call, intent, callback);
            } catch (Exception e) {
                call.reject("Installation de la mise à jour impossible.", "FAILED");
                getBridge().releaseCall(call);
            }
        });
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        call.reject("Autorise Passe-Partout à installer des applis, puis réessaie.", "INSTALL_PERMISSION");
        getBridge().releaseCall(call); // gardé par startActivityForResult
    }

    @ActivityCallback
    private void installResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        call.resolve(); // installateur refermé (mise à jour annulée ou échouée ; installée : l'appli redémarre)
        getBridge().releaseCall(call);
    }
}
