from ..pricing import total
from ...outside import nothing


async def deep_total(lines):
    return total(lines)
