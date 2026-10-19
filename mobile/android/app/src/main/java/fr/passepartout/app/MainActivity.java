package fr.passepartout.app;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PassePartoutPlugin.class); // avant super.onCreate : le pont est créé là
        super.onCreate(savedInstanceState);
        // captures d'écran et enregistrements bloqués, aperçu noir dans les applis récentes
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
