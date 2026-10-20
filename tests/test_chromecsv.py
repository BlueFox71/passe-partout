import pytest

from app.chromecsv import read_chrome_csv, simplify_name
from app.model import Account, Profile, Vault

HEADER = "name,url,username,password,note\n"


def write(tmp_path, body, header=HEADER, encoding="utf-8"):
    p = tmp_path / "Mots de passe Chrome.csv"
    p.write_text(header + body, encoding=encoding)
    return p


@pytest.fixture
def vault():
    return Vault(profiles=[Profile(id="p1", name="Jules")])


@pytest.mark.parametrize("name, url, expected", [
    ("accounts.google.com", "https://accounts.google.com/signin", "Google"),
    ("www.amazon.fr", "https://www.amazon.fr/", "Amazon"),
    ("fd12-courses.leclercdrive.fr", "https://fd12-courses.leclercdrive.fr/", "Leclercdrive"),
    ("cfspart-idp.impots.gouv.fr", "https://cfspart-idp.impots.gouv.fr/", "Impots"),
    ("bluefox71.github.io", "https://bluefox71.github.io/", "Bluefox71"),
    ("bbc.co.uk", "https://bbc.co.uk/", "Bbc"),
    ("bell-anesse-en-provence.fr", "https://bell-anesse-en-provence.fr/", "Bell anesse en provence"),
    ("localhost", "http://localhost:8080/", "localhost"),
    ("192.168.1.1", "http://192.168.1.1/", "192.168.1.1"),
    ("http://192.168.1.169:5000", "http://192.168.1.169:5000/", "192.168.1.169:5000"),
    ("http://www.monalbumphoto.fr", "http://www.monalbumphoto.fr/", "Monalbumphoto"),
    ("http://homeassistant.local", "http://homeassistant.local/", "Homeassistant"),
    ("www.e.leclerc", "https://www.e.leclerc/", "E.leclerc"),
    ("www.france.tv", "https://www.france.tv/", "France"),
    ("mobile.myheritage.com.air", "android://abc@air.com.myheritage.mobile/", "Myheritage"),
    ("AliExpress : shopping en ligne", "android://abc@com.alibaba.aliexpresshd/", "AliExpress"),
    ("Twitch\xa0: streaming en live", "android://abc@tv.twitch.android.app/", "Twitch"),
    ("LinkedIn: Emplois & Connexions", "android://abc@com.linkedin.android/", "LinkedIn"),
    ("Messenger", "android://abc@com.facebook.orca/", "Messenger"),
    ("m6.fr", "https://m6.fr/", "M6"),
    ("Disney+", "android://abc@com.disney.disneyplus/", "Disney+"),
])
def test_simplify_name(name, url, expected):
    assert simplify_name(name, url) == expected


def test_nom_vide_pris_dans_url():
    assert simplify_name("", "https://www.netflix.com/login") == "Netflix"


def test_lecture_basique(tmp_path, vault):
    p = write(tmp_path, "accounts.google.com,https://accounts.google.com/,jules@gmail.com,s3cret,\n")
    r = read_chrome_csv(p, vault)
    assert r["uptodate"] == 0
    assert r["rows"] == [{"name": "Google", "login": "jules@gmail.com", "password": "s3cret"}]


def test_bom_et_guillemets(tmp_path, vault):
    p = write(tmp_path, 'site.fr,https://site.fr/,"a,b","p""w",\n', encoding="utf-8-sig")
    assert read_chrome_csv(p, vault)["rows"] == [{"name": "Site", "login": "a,b", "password": 'p"w'}]


def test_sans_mot_de_passe_ignore(tmp_path, vault):
    p = write(tmp_path, "jamais.fr,https://jamais.fr/,,,\nsite.fr,https://site.fr/,,pw,\n")
    assert [r["name"] for r in read_chrome_csv(p, vault)["rows"]] == ["Site"]


def test_doublons_internes_fusionnes(tmp_path, vault):
    p = write(tmp_path,
              "fd6-courses.leclercdrive.fr,https://a/,jules,pw,\n"
              "fd12-courses.leclercdrive.fr,https://b/,jules,pw,\n"
              "fd12-espace-client.leclercdrive.fr,https://c/,autre,pw,\n")
    rows = read_chrome_csv(p, vault)["rows"]
    assert [(r["name"], r["login"]) for r in rows] == [("Leclercdrive", "autre"), ("Leclercdrive", "jules")]


def test_deja_a_jour_masques(tmp_path, vault):
    vault.accounts.append(Account(id="a1", name="google", login="jules@gmail.com", password="s3cret", profiles=["p1"]))
    p = write(tmp_path,
              "accounts.google.com,https://x/,jules@gmail.com,s3cret,\n"
              "accounts.google.com,https://x/,jules@gmail.com,nouveau,\n")
    r = read_chrome_csv(p, vault)
    assert r["uptodate"] == 1
    assert [x["password"] for x in r["rows"]] == ["nouveau"]


def test_tri_par_nom(tmp_path, vault):
    p = write(tmp_path, "zalando.fr,https://z/,a,1,\namazon.fr,https://a/,a,1,\nÉcole.fr,https://e/,a,1,\n")
    assert [r["name"] for r in read_chrome_csv(p, vault)["rows"]] == ["Amazon", "École", "Zalando"]


def test_fichier_pas_chrome(tmp_path, vault):
    p = write(tmp_path, "a;b\n", header="foo;bar\n")
    with pytest.raises(ValueError):
        read_chrome_csv(p, vault)


def test_nom_repris_d_un_compte_existant(tmp_path, vault):
    vault.accounts.append(Account(id="a1", name="Le Bon Coin", login="jules", password="ancien", profiles=["p1"]))
    p = write(tmp_path, "auth.leboncoin.fr,https://auth.leboncoin.fr/,jules,nouveau,\n")
    assert read_chrome_csv(p, vault)["rows"] == [{"name": "Le Bon Coin", "login": "jules", "password": "nouveau"}]


def test_deja_a_jour_nom_approchant(tmp_path, vault):
    vault.accounts.append(Account(id="a1", name="Yves Rocher", login="j", password="pw", profiles=["p1"]))
    p = write(tmp_path, "auth.yves-rocher.fr,https://auth.yves-rocher.fr/,j,pw,\n")
    assert read_chrome_csv(p, vault) == {"rows": [], "uptodate": 1}
