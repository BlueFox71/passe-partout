from app.main import configure_webview_env, window_geometry


def test_gpu_desactive_pour_webview2(monkeypatch):
    monkeypatch.delenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", raising=False)
    configure_webview_env()
    import os
    assert "--disable-gpu" in os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"]


def test_gpu_conserve_les_arguments_existants(monkeypatch):
    monkeypatch.setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--foo")
    configure_webview_env()
    configure_webview_env()  # idempotent
    import os
    assert os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"].split() == ["--foo", "--disable-gpu"]


def test_geometrie_fenetre_maximisee():
    g = window_geometry({"width": 1280, "height": 800, "x": 50, "y": 60, "maximized": True})
    assert g == {"width": 1280, "height": 800, "x": 50, "y": 60, "maximized": True}


def test_geometrie_hors_ecran_ignoree():
    # ancienne sauvegarde d'une fenêtre maximisée (x=-8) : on repart d'une taille par défaut
    g = window_geometry({"width": 2576, "height": 1408, "x": -8, "y": -8})
    assert g["x"] is None and g["y"] is None and g["maximized"] is True
