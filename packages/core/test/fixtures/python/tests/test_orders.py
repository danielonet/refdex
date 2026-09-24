import pytest
from shop.orders import Order


def test_order():
    assert Order([]).lines == []
