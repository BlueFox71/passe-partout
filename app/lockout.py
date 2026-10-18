"""Délai croissant après des codes erronés à l'écran de verrouillage."""
from __future__ import annotations

import math
import time

MAX_DELAY = 300


class Lockout:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._fails = 0
        self._until = 0.0

    def wait_seconds(self) -> int:
        return max(0, math.ceil(self._until - self._clock()))

    def fail(self) -> None:
        self._fails += 1
        self._until = self._clock() + min(2 ** (self._fails - 1), MAX_DELAY)

    def success(self) -> None:
        self._fails = 0
        self._until = 0.0
