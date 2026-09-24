TAX_RATE = 0.2


def total(lines) -> float:
    return sum(lines) * (1 + TAX_RATE)
