"""Sample module for the RefDex spike."""
from __future__ import annotations

import math
from dataclasses import dataclass
from .base import Shape


def _square(x: float) -> float:
    return x * x


@dataclass
class Circle(Shape):
    radius: float

    def area(self) -> float:
        return math.pi * _square(self.radius)

    @property
    def diameter(self) -> float:
        return self.radius * 2

    class Meta:
        ordering = ["radius"]

        def describe(cls) -> str:
            return "circle meta"


async def load_shapes(path: str, *, strict: bool = False) -> list[Shape]:
    return []
