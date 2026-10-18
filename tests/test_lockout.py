from app.lockout import Lockout


def test_lockout_progression():
    t = [0.0]
    lo = Lockout(clock=lambda: t[0])
    assert lo.wait_seconds() == 0
    lo.fail()
    assert lo.wait_seconds() == 1
    lo.fail()
    lo.fail()
    assert lo.wait_seconds() == 4
    for _ in range(20):
        lo.fail()
    assert lo.wait_seconds() == 300
    t[0] += 300
    assert lo.wait_seconds() == 0
    lo.success()
    lo.fail()
    assert lo.wait_seconds() == 1
