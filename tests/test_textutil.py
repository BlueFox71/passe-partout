from app.textutil import apply_mask, normalize, raw_value, search, strength


def test_mask_numero_fiscal():
    assert apply_mask("1234567890123", "## ## ### ### ###") == "12 34 567 890 123"


def test_mask_surplus_ajoute_a_la_suite():
    assert apply_mask("12345", "## #") == "12 345"


def test_mask_valeur_courte():
    assert apply_mask("123", "## ##") == "12 3"


def test_mask_absent():
    assert apply_mask("abc", None) == "abc" and apply_mask("abc", "") == "abc"


def test_raw_value_inchangee():
    assert raw_value("1234567890123") == "1234567890123"


def test_normalize():
    assert normalize("  Réseau  Social ") == "reseau social"


def test_search_accents_casse(sample_accounts):
    assert [a.name for a in search(sample_accounts, "RESEAU")] == ["Facebook"]
    assert [a.name for a in search(sample_accounts, "boursorama")] == ["Boursorama"]


def test_search_vide_renvoie_tout(sample_accounts):
    assert search(sample_accounts, "  ") == sample_accounts


def test_search_ignore_mot_de_passe(sample_accounts):
    assert search(sample_accounts, sample_accounts[0].password) == []


def test_strength_bornes():
    assert strength("") == 0 and strength("1234") <= 1 and strength("Xk9!pQ2#vL7$wR") == 4
