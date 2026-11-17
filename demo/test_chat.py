from chat import dec, mem_argv


def test_mem_argv() -> None:
    assert mem_argv('/search "dark roast" K 3', "ana") == [
        "MEM.SEARCH", "ana", "dark roast", "K", "3",
    ]  # fmt: skip
    assert mem_argv("/resolve 01ABC KEEP b", "ana") == ["MEM.RESOLVE", "ana", "01ABC", "KEEP", "b"]
    assert mem_argv("/branches", "ana") == ["MEM.BRANCHES", "ana"]
    assert mem_argv("/stats", "ana") is None


def test_dec() -> None:
    assert dec({b"ids": [b"a", b"b"], b"tokens": 3}) == {"ids": ["a", "b"], "tokens": 3}
