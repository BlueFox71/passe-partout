from app.main import configure_webview_env, default_data_dir, window_geometry


def test_dossier_de_donnees_renomme(tmp_path):
    (tmp_path / "GestionnaireMdp" / "backups").mkdir(parents=True)
    (tmp_path / "GestionnaireMdp" / "vault.json").write_text("coffre")
    d = default_data_dir(tmp_path)
    assert d == tmp_path / "PassePartout"
    assert (d / "vault.json").read_text() == "coffre" and (d / "backups").is_dir()
    assert not (tmp_path / "GestionnaireMdp").exists()


def test_dossier_de_donnees_nouveau_garde_si_les_deux_existent(tmp_path):
    (tmp_path / "GestionnaireMdp").mkdir()
    (tmp_path / "GestionnaireMdp" / "vault.json").write_text("ancien")
    (tmp_path / "PassePartout").mkdir()
    (tmp_path / "PassePartout" / "vault.json").write_text("nouveau")
    d = default_data_dir(tmp_path)
    assert (d / "vault.json").read_text() == "nouveau"
    assert (tmp_path / "GestionnaireMdp" / "vault.json").read_text() == "ancien"  # rien n'est écrasé ni effacé


def test_dossier_de_donnees_premier_lancement(tmp_path):
    assert default_data_dir(tmp_path) == tmp_path / "PassePartout"


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


def test_deuxieme_instance_message_sans_fenetre(tmp_path, monkeypatch):
    from app import main
    from app.instance import acquire_instance_lock, release_instance_lock

    premier = acquire_instance_lock(tmp_path)
    messages, fenetres = [], []
    monkeypatch.setattr(main, "show_message", lambda texte, titre: messages.append((texte, titre)))
    monkeypatch.setattr(main.webview, "create_window", lambda *a, **k: fenetres.append(a))
    monkeypatch.setattr(main.webview, "start", lambda *a, **k: fenetres.append("start"))
    try:
        main.run(tmp_path)
    finally:
        release_instance_lock(premier)
    assert messages == [("Passe-Partout est déjà ouvert.", "Passe-Partout")]
    assert fenetres == []
