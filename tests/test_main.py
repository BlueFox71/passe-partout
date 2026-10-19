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
        main.run(tmp_path, process_names=lambda: ["explorer.exe"])
    finally:
        release_instance_lock(premier)
    assert messages == [("Passe-Partout est déjà ouvert.", "Passe-Partout")]
    assert fenetres == []


def test_ancienne_copie_ouverte_refus_avant_tout(tmp_path, monkeypatch):
    from app import main

    messages, fenetres, verrous = [], [], []
    monkeypatch.setattr(main, "show_message", lambda texte, titre: messages.append((texte, titre)))
    monkeypatch.setattr(main, "acquire_instance_lock", lambda d: verrous.append(d))
    monkeypatch.setattr(main, "default_data_dir", lambda: verrous.append("data_dir"))
    monkeypatch.setattr(main.webview, "create_window", lambda *a, **k: fenetres.append(a))
    monkeypatch.setattr(main.webview, "start", lambda *a, **k: fenetres.append("start"))
    main.run(None, process_names=lambda: ["explorer.exe", "Passe-Partout.exe", "Passe-Partout-1.0.0.exe"])
    assert messages == [("Ferme l'ancienne copie de Passe-Partout, puis relance.", "Passe-Partout")]
    assert verrous == [] and fenetres == []  # ni verrou, ni dossier de données, ni fenêtre
    assert not (tmp_path / "vault.json").exists()


def test_ancienne_copie_absente_demarrage_normal(tmp_path, monkeypatch):
    from app import main
    from app.instance import release_instance_lock

    messages, fenetres = [], []
    monkeypatch.setattr(main, "show_message", lambda texte, titre: messages.append((texte, titre)))
    monkeypatch.setattr(main.webview, "create_window", lambda *a, **k: fenetres.append("window") or _FakeWindow())
    monkeypatch.setattr(main.webview, "start", lambda *a, **k: fenetres.append("start"))
    monkeypatch.setattr(main.threading, "Thread", _NoThread)
    try:
        main.run(tmp_path, process_names=lambda: ["explorer.exe", "Passe-Partout-1.0.0.exe", "passe-partout.exe.bak"])
    finally:
        release_instance_lock(main._instance_lock)
        main._instance_lock = None
    assert messages == []
    assert fenetres == ["window", "start"]


def test_ancienne_copie_nom_exact_sans_casse():
    from app.main import old_copy_running

    assert old_copy_running(["PASSE-PARTOUT.EXE"])
    assert not old_copy_running(["Passe-Partout-1.0.0.exe", "Passe-Partout.exe.old", "python.exe"])
    assert not old_copy_running([])


def test_liste_des_processus_reelle_contient_python():
    import os
    import sys

    from app.main import running_process_names

    noms = [n.lower() for n in running_process_names()]
    assert os.path.basename(sys.executable).lower() in noms


class _Events:
    def __getattr__(self, name):
        return self

    def __iadd__(self, handler):
        return self


class _FakeWindow:
    events = _Events()


class _NoThread:
    def __init__(self, *a, **k):
        pass

    def start(self):
        pass
