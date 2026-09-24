"""Orders module."""
import os
import shop.pricing as p
from . import utils
from .pricing import total, TAX_RATE
from typing import *


class Order:
    """An order with lines."""

    def __init__(self, lines):
        self.lines = lines

    @property
    def total(self) -> float:
        """Sum of all lines."""
        return total(self.lines)

    def _private(self):
        pass


def load(path: str) -> Order:
    return Order([])
