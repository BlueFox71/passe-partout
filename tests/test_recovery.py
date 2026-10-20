import json

import pytest

from app import recovery
from tests.conftest import make_api

ANSWERS = ["Médor", "Lucas", "rue des Lilas"]


@pytest.fixture
def api(api_locked):
    assert api_locked.unlock("123456")["ok"]
    api_locked.set_recovery([0, 1, 2], ANSWERS, "123456")
    return api_locked


def relaunch(tmp_path, fake_clip, clock, dialogs):
    return make_api(tmp_path, fake_clip, clock, dialogs)


def test_reponses_normalisees():
    assert recovery.answer_key(["  MÉDOR ", "Jean-Luc"]) == recovery.answer_key(["medor", "jean luc"])


@pytest.mark.parametrize("questions, answers", [
    ([0, 1], ["aa", "bb"]),
    ([0, 0, 1], ["aa", "bb", "cc"]),
    ([0, 1, 99], ["aa", "bb", "cc"]),
    ([0, 1, 2], ["aa", "bb", " - "]),
])
def test_validation(questions, answers):
    with pytest.raises(ValueError):
        recovery.check(questions, answers)


def test_etat_et_questions_affichees(api, tmp_path, fake_clip, clock, dialogs):
    again = relaunch(tmp_path, fake_clip, clock, dialogs)
    assert again.get_state()["recovery"] is True
    r = again.get_recovery()
    assert r["chosen"] == [0, 1, 2] and len(r["questions"]) == 20


def test_recuperation(api, tmp_path, fake_clip, clock, dialogs):
    again = relaunch(tmp_path, fake_clip, clock, dialogs)
    assert again.recover(["medor", "LUCAS", "Rue des lilas"])["ok"] is True
    assert again.get_state()["locked"] is False


def test_mauvaises_reponses_delai(api, tmp_path, fake_clip, clock, dialogs):
    again = relaunch(tmp_path, fake_clip, clock, dialogs)
    r = again.recover(["medor", "lucas", "faux"])
    assert r == {"ok": False, "wait_seconds": 1, "error": "bad_answers"}
    assert again.recover(ANSWERS)["ok"] is False  # encore dans le délai
    clock.advance(2)
    assert again.recover(ANSWERS)["ok"] is True


def test_code_actuel_exige(api_locked):
    api_locked.unlock("123456")
    with pytest.raises(ValueError):
        api_locked.set_recovery([0, 1, 2], ANSWERS, "000000")


def test_sans_verrou_refuse(api_unlocked):
    with pytest.raises(ValueError):
        api_unlocked.set_recovery([0, 1, 2], ANSWERS, "")
    assert api_unlocked.get_state()["recovery"] is False


def test_changement_de_code_suivi(api, tmp_path, fake_clip, clock, dialogs):
    api.set_lock("password", "nouveau-mdp")
    again = relaunch(tmp_path, fake_clip, clock, dialogs)
    assert again.recover(ANSWERS)["ok"] is True
    again.lock()
    assert again.unlock("nouveau-mdp")["ok"] is True


def test_retrait_du_verrou_efface(api, tmp_path):
    api.set_lock("none", None)
    assert "recovery" not in json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert api.get_state()["recovery"] is False


def test_rien_en_clair(api, tmp_path):
    text = (tmp_path / "config.json").read_text(encoding="utf-8").lower()
    assert "123456" not in text and "medor" not in text and "lucas" not in text


def test_supprimer(api):
    api.clear_recovery()
    assert api.get_state()["recovery"] is False
    assert api.get_recovery()["chosen"] is None
