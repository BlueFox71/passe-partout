from app.instance import acquire_instance_lock, release_instance_lock


def test_second_instance_lock_refused(tmp_path):
    first = acquire_instance_lock(tmp_path)
    try:
        assert first is not None and acquire_instance_lock(tmp_path) is None
    finally:
        release_instance_lock(first)


def test_lock_released_after_close(tmp_path):
    first = acquire_instance_lock(tmp_path)
    assert first is not None
    release_instance_lock(first)
    second = acquire_instance_lock(tmp_path)
    assert second is not None
    release_instance_lock(second)


def test_lock_cree_le_dossier(tmp_path):
    d = tmp_path / "nouveau"
    lock = acquire_instance_lock(d)
    assert lock is not None and (d / ".instance.lock").exists()
    release_instance_lock(lock)
