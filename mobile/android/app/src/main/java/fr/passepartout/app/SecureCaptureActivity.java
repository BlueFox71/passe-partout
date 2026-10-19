package fr.passepartout.app;

import android.os.Bundle;
import android.view.WindowManager;

import com.journeyapps.barcodescanner.CaptureActivity;

/** Lecteur de QR code ZXing avec FLAG_SECURE : ni capture d'écran ni aperçu dans les applis récentes. */
public class SecureCaptureActivity extends CaptureActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);
    }
}
