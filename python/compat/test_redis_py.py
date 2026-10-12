"""redis-py compatibility subset, run in RESP2 and RESP3 (PLAN 24, phase 1 gate)."""

from __future__ import annotations

import time

import pytest
import redis

pytestmark = pytest.mark.compat


def test_strings_and_counters(r: redis.Redis) -> None:
    assert r.set("s", "hello") is True
    assert r.get("s") == "hello"
    assert r.set("s", "x", nx=True) is None
    assert r.set("s", "world", xx=True, get=True) == "hello"
    assert r.incr("n") == 1
    assert r.incrby("n", 41) == 42
    assert r.incrbyfloat("f", 1.5) == 1.5
    assert r.mset({"a": "1", "b": "2"}) is True
    assert r.mget(["a", "b", "missing"]) == ["1", "2", None]
    assert r.strlen("s") == 5
    assert r.getrange("s", 1, 3) == "orl"


def test_binary_values(server_port: int) -> None:
    client = redis.Redis(port=server_port)
    value = bytes([0, 1, 13, 10, 255])
    client.set(b"bin\x00key", value)
    assert client.get(b"bin\x00key") == value
    client.close()


def test_keys_and_expiry(r: redis.Redis) -> None:
    r.set("k", "v", ex=100)
    assert 98 <= r.ttl("k") <= 100
    assert r.persist("k") is True
    assert r.ttl("k") == -1
    r.set("short", "v", px=30)
    time.sleep(0.06)
    assert r.exists("short") == 0
    assert r.type("k") == "string"
    assert r.rename("k", "k2") is True
    assert r.delete("k2", "missing") == 1


def test_scan_iter_sees_every_key(r: redis.Redis) -> None:
    keys = {f"scan:{i}" for i in range(120)}
    r.mset(dict.fromkeys(keys, "1"))
    assert set(r.scan_iter(match="scan:*", count=25)) == keys


def test_hashes(r: redis.Redis) -> None:
    assert r.hset("h", mapping={"f1": "a", "f2": "b"}) == 2
    assert r.hgetall("h") == {"f1": "a", "f2": "b"}
    assert r.hincrby("h", "c", 3) == 3
    assert r.hincrbyfloat("h", "d", 0.5) == 0.5
    assert r.hexists("h", "f1") is True
    assert sorted(r.hkeys("h")) == ["c", "d", "f1", "f2"]


def test_lists(r: redis.Redis) -> None:
    assert r.rpush("l", "a", "b", "c") == 3
    assert r.lrange("l", 0, -1) == ["a", "b", "c"]
    assert r.lindex("l", -1) == "c"
    assert r.lpop("l", 2) == ["a", "b"]
    assert r.llen("l") == 1


def test_sets(r: redis.Redis) -> None:
    assert r.sadd("s1", "a", "b", "c") == 3
    r.sadd("s2", "b", "c", "d")
    assert r.sinter("s1", "s2") == {"b", "c"}
    assert r.sunion("s1", "s2") == {"a", "b", "c", "d"}
    assert r.smismember("s1", ["a", "z"]) == [1, 0]


def test_sorted_sets(r: redis.Redis) -> None:
    # redis-py keeps the reply shapes apart: tuples in RESP2, nested lists in RESP3
    # (checked against Redis 7.2.4).
    resp3 = r.connection_pool.connection_kwargs.get("protocol") == 3
    assert r.zadd("z", {"a": 1, "b": 2, "c": 3.5}) == 3
    scored = r.zrange("z", 0, -1, withscores=True)
    assert [tuple(pair) for pair in scored] == [("a", 1.0), ("b", 2.0), ("c", 3.5)]
    assert isinstance(scored[0], list if resp3 else tuple)
    assert r.zrangebyscore("z", "(1", "+inf") == ["b", "c"]
    assert r.zscore("z", "c") == 3.5
    assert r.zincrby("z", 1, "a") == 2.0
    assert r.zpopmax("z") == (["c", 3.5] if resp3 else [("c", 3.5)])
    assert r.zrank("z", "b", withscore=True) == [1, 2.0]
    assert r.zcard("z") == 2


def test_errors(r: redis.Redis) -> None:
    r.lpush("list", "x")
    with pytest.raises(redis.ResponseError, match="WRONGTYPE"):
        r.get("list")
    with pytest.raises(redis.ResponseError, match="unknown command"):
        r.execute_command("NOSUCHCOMMAND")


def test_pipeline_and_transaction(r: redis.Redis) -> None:
    with r.pipeline(transaction=False) as pipe:
        assert pipe.set("p", "1").incr("p").get("p").execute() == [True, 2, "2"]
    with r.pipeline() as pipe:
        assert pipe.set("t", "a").append("t", "b").get("t").execute() == [True, 2, "ab"]


def test_watch_aborts_on_change(r: redis.Redis, server_port: int) -> None:
    other = redis.Redis(port=server_port, decode_responses=True)
    r.set("w", "1")
    with r.pipeline() as pipe:
        pipe.watch("w")
        other.set("w", "2")
        pipe.multi()
        pipe.set("w", "3")
        with pytest.raises(redis.WatchError):
            pipe.execute()
    assert r.get("w") == "2"
    other.close()


def test_connection_commands(r: redis.Redis) -> None:
    assert r.ping() is True
    assert r.echo("hi") == "hi"
    assert r.client_setname("compat") is True
    assert r.client_getname() == "compat"
    assert isinstance(r.client_id(), int)
    info = r.info()
    assert info["redis_version"] == "7.2.0"
    assert info["loading"] == 0
    assert r.config_get("databases") == {"databases": "1"}
    assert r.dbsize() == 0
